"use strict";
/**
 * Runtime patch enabling a disk-backed playbook cache for
 * @browserbasehq/stagehand `extract()` without modifying node_modules.
 *
 * Targets Stagehand V3's own Page/Locator (CDP-backed). No Playwright
 * dependency.
 *
 * Usage:
 *   const { Stagehand } = require("@browserbasehq/stagehand");
 *   const { applyExtractCachePatch } = require("./extract-cache-patch.cjs");
 *   applyExtractCachePatch(Stagehand, { cacheDir: "./stagehand-extract-cache" });
 *
 *   const sh = new Stagehand({ env: "LOCAL", model: "deepseek/deepseek-chat" });
 *   await sh.init();
 *   await sh.extract("Extract title", z.object({ title: z.string() }));
 *   // First call: LLM + cache write. Second: replay from disk + Zod validate.
 *   // Pass options.useCache=false to bypass.
 *
 * Mechanism:
 *   - On miss, calls the original extract() with the user's instruction
 *     augmented with a playbook guide and the user's schema wrapped as
 *     z.object({ data: <user>, playbook: z.any() }). The LLM returns both in
 *     one call; we persist `playbook` and return `data`.
 *   - On hit, walks the cached playbook against the live page using
 *     Stagehand's Locator API (`.innerText/.textContent/.inputValue/
 *     .innerHtml/.count`) and CDP for attributes; validates the output with
 *     the user's Zod schema. Validation failure / walker error → LLM fallback.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PLAYBOOK_GUIDE = [
  "ALSO populate a 'playbook' field: a tree mirroring the data shape that tells",
  "how to read each value from the live DOM (raw CSS selectors only).",
  '- Leaf:  {"type":"field","selector":"<css>","read":"innerText"|"textContent"|"inputValue"|"innerHtml"|"attr:<name>"}.',
  "  For <title>, use selector `title` with read `textContent`.",
  '  Set "deep":true only inside iframe or shadow DOM.',
  '- Object:{"type":"object","fields":{"<key>":<node>,...}}.',
  '- Array: {"type":"array","itemsSelector":"<row css>","item":<node>}.',
  "  Inside an array's item, leaf selectors are evaluated as",
  "  `row.querySelector(selector)`. Use class/attr-based selectors RELATIVE",
  "  to the row (`.text`, `.author`, `a`). Never repeat the row tag",
  '  (`li:nth-child(N)`) and never use `{index}`. Use empty `""` to read the',
  "  row itself.",
  'Use read "attr:href" for URL fields.',
].join("\n");

function sha256Hex(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function isZodSchema(v) {
  return !!v && typeof v === "object" && typeof v.safeParse === "function";
}

function fingerprintSchema(schema) {
  const z = require("zod");
  if (typeof z.toJSONSchema === "function") {
    try {
      return sha256Hex(z.toJSONSchema(schema));
    } catch {
      /* fall through */
    }
  }
  return sha256Hex(schema?._def ?? {});
}

function buildAugmented(z, instruction, schema) {
  return {
    instruction: `${instruction}\n\n${PLAYBOOK_GUIDE}`,
    schema: z.object({ data: schema, playbook: z.any() }),
  };
}

function isPlaybookNode(n) {
  if (!n || typeof n !== "object") return false;
  if (n.type === "field")
    return typeof n.selector === "string" && typeof n.read === "string";
  if (n.type === "object")
    return (
      n.fields &&
      typeof n.fields === "object" &&
      Object.values(n.fields).every(isPlaybookNode)
    );
  if (n.type === "array")
    return typeof n.itemsSelector === "string" && isPlaybookNode(n.item);
  return false;
}

/** LLMs sometimes emit `css:foo` / `css=foo`; Stagehand expects raw CSS. */
function normalizeSelector(selector) {
  return selector.replace(/^css[:=]\s*/i, "");
}

/** CDP `Runtime.callFunctionOn` on an element resolved from a Locator. */
async function callOnElement(loc, fnDecl, args) {
  const session = loc.getFrame().session;
  const { objectId } = await loc.resolveNode();
  try {
    const res = await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fnDecl,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    return res?.result?.value;
  } finally {
    try {
      await session.send("Runtime.releaseObject", { objectId });
    } catch {
      /* best-effort */
    }
  }
}

const TRIM = (s) => (s == null ? "" : String(s)).trim();

/** Read a leaf value from a top-level (non-scoped) Stagehand Locator. */
async function readLeaf(loc, read) {
  if (read.startsWith("attr:")) {
    const v = await callOnElement(
      loc,
      'function(a){return this.getAttribute(a) ?? "";}',
      [read.slice(5)],
    );
    return TRIM(v);
  }
  if (read === "textContent") return TRIM(await loc.textContent());
  if (read === "inputValue") return TRIM(await loc.inputValue());
  if (read === "innerHtml") return TRIM(await loc.innerHtml());
  // innerText (default): empty for elements not rendered (e.g. <title> in <head>);
  // fall back to textContent so unrendered nodes still yield text.
  const it = TRIM(await loc.innerText());
  return it !== "" ? it : TRIM(await loc.textContent());
}

/** Read a leaf value from a child of `itemLoc`, scoped via this.querySelector. */
async function readScopedLeaf(itemLoc, childSelector, read) {
  const sel = normalizeSelector(childSelector);
  if (read.startsWith("attr:")) {
    const v = await callOnElement(
      itemLoc,
      'function(s,a){const el=s===""?this:this.querySelector(s);return el?(el.getAttribute(a)??""):"";}',
      [sel, read.slice(5)],
    );
    return TRIM(v);
  }
  const fnByRead = {
    textContent:
      'function(s){const el=s===""?this:this.querySelector(s);return el?(el.textContent??""):"";}',
    inputValue:
      'function(s){const el=s===""?this:this.querySelector(s);return el?(el.value??""):"";}',
    innerHtml:
      'function(s){const el=s===""?this:this.querySelector(s);return el?(el.innerHTML??""):"";}',
    innerText:
      'function(s){const el=s===""?this:this.querySelector(s);return el?(el.innerText||el.textContent||""):"";}',
  };
  const decl = fnByRead[read] ?? fnByRead.innerText;
  const v = await callOnElement(itemLoc, decl, [sel]);
  return TRIM(v);
}

async function resolveLocator(page, selector, deep) {
  const sel = normalizeSelector(selector);
  if (deep && typeof page.deepLocator === "function") {
    const del = page.deepLocator(sel);
    if (typeof del.resolvedLocator === "function") {
      return await del.resolvedLocator();
    }
    return del;
  }
  return page.locator(sel);
}

async function executePlaybook(page, root) {
  // `scope` is null at top level (read via page.locator) or a Stagehand Locator
  // narrowed to an array item (read via CDP this.querySelector).
  const exec = async (node, scope) => {
    if (node.type === "field") {
      try {
        if (scope) {
          return await readScopedLeaf(scope, node.selector, node.read);
        }
        const loc = await resolveLocator(page, node.selector, !!node.deep);
        return await readLeaf(loc, node.read);
      } catch {
        return null;
      }
    }
    if (node.type === "object") {
      const out = {};
      for (const [key, child] of Object.entries(node.fields)) {
        out[key] = await exec(child, scope);
      }
      return out;
    }
    // type === "array": scope each row to the i-th item locator.
    const items = await resolveLocator(
      page,
      node.itemsSelector,
      !!node.itemsDeep,
    );
    const n = await items.count();
    const results = [];
    for (let i = 0; i < n; i++) {
      const itemLoc = typeof items.nth === "function" ? items.nth(i) : items;
      results.push(await exec(node.item, itemLoc));
    }
    return results;
  };
  return exec(root, null);
}

function parseExtractArgs(args) {
  const [a, b, c] = args;
  if (typeof a === "string") {
    if (isZodSchema(b)) return { instruction: a, schema: b, options: c };
    return { instruction: a, schema: undefined, options: b };
  }
  return { instruction: undefined, schema: undefined, options: a };
}

function pickPage(stagehand, options) {
  if (options && options.page) return options.page;
  try {
    return stagehand.context.pages()[0];
  } catch {
    return null;
  }
}

function readPageUrl(page) {
  try {
    const u = page.url();
    return typeof u === "string" ? u : "";
  } catch {
    return "";
  }
}

function applyExtractCachePatch(Stagehand, opts = {}) {
  const cacheDir = path.resolve(opts.cacheDir ?? "stagehand-extract-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const log = typeof opts.log === "function" ? opts.log : () => {};

  const proto = Stagehand.prototype;
  if (proto.__extractCachePatched) return;
  proto.__extractCachePatched = true;

  const original = proto.extract;

  proto.extract = async function patchedExtract(...args) {
    const { instruction, schema, options } = parseExtractArgs(args);

    if (!instruction || !schema || options?.useCache === false) {
      return original.apply(this, args);
    }

    const page = pickPage(this, options);
    if (!page) return original.apply(this, args);

    const z = require("zod");
    const url = readPageUrl(page);
    const schemaFp = fingerprintSchema(schema);
    const cacheKey = sha256Hex({
      kind: "stagehand-extract-runtime-patch-v1",
      instruction,
      url,
      schemaFp,
    });
    const file = path.join(cacheDir, `extract-${cacheKey}.json`);

    if (fs.existsSync(file)) {
      try {
        const entry = JSON.parse(fs.readFileSync(file, "utf8"));
        if (isPlaybookNode(entry.playbook)) {
          const raw = await executePlaybook(page, entry.playbook);
          const parsed = schema.safeParse(raw);
          if (parsed.success) {
            log("extract cache hit", { url, instruction });
            return parsed.data;
          }
          log("extract cache miss: zod validation", { url });
        }
      } catch (e) {
        log("extract cache miss: replay error", { error: String(e) });
      }
    }

    const augmented = buildAugmented(z, instruction, schema);
    let bundle;
    try {
      bundle = await original.call(
        this,
        augmented.instruction,
        augmented.schema,
        options,
      );
    } catch (e) {
      log("extract failed under augmentation, retrying raw", {
        error: String(e),
      });
      return original.apply(this, args);
    }

    const data = bundle?.data;
    const playbook = bundle?.playbook;
    if (isPlaybookNode(playbook)) {
      try {
        fs.writeFileSync(
          file,
          JSON.stringify({ instruction, url, schemaFp, playbook }, null, 2),
        );
        log("extract cache stored", { url, instruction });
      } catch (e) {
        log("extract cache write failed", { error: String(e) });
      }
    } else {
      log("extract cache: invalid playbook from LLM, not caching");
    }
    return data;
  };
}

module.exports = { applyExtractCachePatch };
