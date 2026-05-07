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
  "how to read each value from the live DOM.",
  '- Leaves: { "type": "field", "selector": "<selector>",',
  '    "read": "innerText"|"textContent"|"inputValue"|"innerHtml"|"attr:<name>" }.',
  "  Selector forms: raw CSS (e.g. `h1`, `div.row > a`), `xpath=...`, or",
  "  `text=...`. Do NOT prefix CSS with `css:` or `css=`.",
  '  Use "deep": true only when the element is inside an iframe or shadow DOM.',
  '- Objects: { "type": "object", "fields": { "<key>": <node>, ... } }.',
  '- Arrays: { "type": "array", "itemsSelector": "<css matching every row>",',
  '    "item": <node> }; inside array items, use the literal "{index}" in',
  "  selectors for the 1-based row index (e.g. xpath=(//article)[{index}]//h2).",
  'Prefer stable selectors. Use read "attr:href" for URL fields.',
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

function applyIndexPlaceholder(selector, index1Based) {
  if (index1Based == null || !selector.includes("{index}")) return selector;
  return selector.split("{index}").join(String(index1Based));
}

/** LLMs sometimes emit `css:foo` / `css=foo`; Stagehand expects raw CSS. */
function normalizeSelector(selector) {
  return selector.replace(/^css[:=]\s*/i, "");
}

/** CDP-backed attribute read for Stagehand Locator (no native getAttribute). */
async function readAttributeViaCdp(loc, attrName) {
  const frame = loc.getFrame();
  const session = frame.session;
  const { objectId } = await loc.resolveNode();
  try {
    const res = await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: 'function(a){return this.getAttribute(a) ?? "";}',
      arguments: [{ value: attrName }],
      returnByValue: true,
    });
    return String(res?.result?.value ?? "");
  } finally {
    try {
      await session.send("Runtime.releaseObject", { objectId });
    } catch {
      /* best-effort */
    }
  }
}

async function readLeaf(loc, read) {
  const trim = (s) => (s == null ? "" : String(s)).trim();
  if (read.startsWith("attr:")) {
    return trim(await readAttributeViaCdp(loc, read.slice(5)));
  }
  if (read === "textContent") return trim(await loc.textContent());
  if (read === "inputValue") return trim(await loc.inputValue());
  if (read === "innerHtml") return trim(await loc.innerHtml());
  return trim(await loc.innerText());
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
  const exec = async (node, index1Based) => {
    if (node.type === "field") {
      const sel = applyIndexPlaceholder(node.selector, index1Based);
      try {
        const loc = await resolveLocator(page, sel, !!node.deep);
        return await readLeaf(loc, node.read);
      } catch {
        return null;
      }
    }
    if (node.type === "object") {
      const out = {};
      for (const [key, child] of Object.entries(node.fields)) {
        out[key] = await exec(child, index1Based);
      }
      return out;
    }
    const items = await resolveLocator(
      page,
      node.itemsSelector,
      !!node.itemsDeep,
    );
    const n = await items.count();
    const results = [];
    for (let i = 0; i < n; i++) results.push(await exec(node.item, i + 1));
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
