// lib/v3/cache/extractPlaybook.ts
import { Protocol } from "devtools-protocol";
import { z } from "zod";
import { resolveLocatorWithHops } from "../understudy/deepLocator.js";
import { Locator } from "../understudy/locator.js";
import type { Page } from "../understudy/page.js";
import { withTimeout } from "../timeoutConfig.js";
import { StagehandElementNotFoundError } from "../types/public/sdkErrors.js";

const READ_ENUM = z.enum([
  "innerText",
  "textContent",
  "inputValue",
  "innerHtml",
]);

/**
 * Declarative replay plan for extract(): leaf nodes read a single value from
 * the DOM; object/array nodes mirror the Zod output shape.
 */
export type ExtractPlaybookNode =
  | {
      type: "field";
      /** CSS, xpath=..., or text=...; use {index} for 1-based index inside array items. */
      selector: string;
      /** When true, use page.deepLocator (iframes / shadow). */
      deep?: boolean;
      /**
       * How to read the element. Use "attr:<name>" for attributes (e.g. attr:href).
       */
      read: z.infer<typeof READ_ENUM> | (string & {});
    }
  | { type: "object"; fields: Record<string, ExtractPlaybookNode> }
  | {
      type: "array";
      itemsSelector: string;
      itemsDeep?: boolean;
      item: ExtractPlaybookNode;
    };

export const extractPlaybookNodeSchema: z.ZodType<ExtractPlaybookNode> = z.lazy(
  () =>
    z.union([
      z.object({
        type: z.literal("field"),
        selector: z
          .string()
          .describe(
            "Playwright-style selector: CSS, xpath=//..., or text=.... Inside array items, use {index} for the 1-based item index (e.g. xpath=(//article)[{index}]//h2).",
          ),
        deep: z
          .boolean()
          .optional()
          .describe("Set true if the field is inside iframe or shadow DOM."),
        read: z
          .union([READ_ENUM, z.string()])
          .describe(
            'One of innerText, textContent, inputValue, innerHtml, or "attr:name" (e.g. attr:href for links).',
          ),
      }),
      z.object({
        type: z.literal("object"),
        fields: z
          .record(z.string(), extractPlaybookNodeSchema)
          .describe("Child playbook nodes keyed like the output object."),
      }),
      z.object({
        type: z.literal("array"),
        itemsSelector: z
          .string()
          .describe(
            "Selector matching every repeated item (same count as the output array).",
          ),
        itemsDeep: z.boolean().optional(),
        item: extractPlaybookNodeSchema.describe(
          "Playbook for one element; use {index} in field selectors for the item index.",
        ),
      }),
    ]),
) as z.ZodType<ExtractPlaybookNode>;

async function readAttribute(loc: Locator, attrName: string): Promise<string> {
  const session = loc.getFrame().session;
  const { objectId } = await loc.resolveNode();
  try {
    const res = await session.send<Protocol.Runtime.CallFunctionOnResponse>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(attr) { return this.getAttribute(attr) ?? ""; }`,
        arguments: [{ value: attrName }],
        returnByValue: true,
      },
    );
    return String(res.result.value ?? "");
  } finally {
    await session.send("Runtime.releaseObject", { objectId });
  }
}

async function readFieldLeaf(loc: Locator, read: string): Promise<string> {
  if (read.startsWith("attr:")) {
    return (await readAttribute(loc, read.slice(5))).trim();
  }
  if (
    read === "innerText" ||
    read === "textContent" ||
    read === "inputValue" ||
    read === "innerHtml"
  ) {
    if (read === "innerText") return (await loc.innerText()).trim();
    if (read === "textContent") return (await loc.textContent()).trim();
    if (read === "inputValue") return (await loc.inputValue()).trim();
    return (await loc.innerHtml()).trim();
  }
  return (await loc.innerText()).trim();
}

/**
 * Expands {index} placeholders in a selector. Only applies when `index1Based` is set.
 */
function applyIndexPlaceholder(
  selector: string,
  index1Based: number | null,
): string {
  if (index1Based === null || !selector.includes("{index}")) {
    return selector;
  }
  return selector.split("{index}").join(String(index1Based));
}

async function readFieldNode(
  page: Page,
  node: ExtractPlaybookNode & { type: "field" },
  index1Based: number | null,
  perReadTimeoutMs: number | undefined,
): Promise<unknown> {
  const rawSelector = applyIndexPlaceholder(node.selector, index1Based);
  const label = `extract cache read (${rawSelector})`;
  const loc = node.deep
    ? await page.deepLocator(rawSelector).resolvedLocator()
    : page.locator(rawSelector);
  return await withTimeout(
    readFieldLeaf(loc, node.read),
    perReadTimeoutMs,
    label,
  );
}

/**
 * Deterministically builds a value from the live page using a cached playbook.
 */
export async function executeExtractPlaybook(
  page: Page,
  root: ExtractPlaybookNode,
  options?: { perReadTimeoutMs?: number },
): Promise<unknown> {
  const perReadTimeoutMs = options?.perReadTimeoutMs;

  const exec = async (
    node: ExtractPlaybookNode,
    index1Based: number | null,
  ): Promise<unknown> => {
    if (node.type === "field") {
      try {
        return await readFieldNode(page, node, index1Based, perReadTimeoutMs);
      } catch (e) {
        if (e instanceof StagehandElementNotFoundError) {
          return null;
        }
        throw e;
      }
    }
    if (node.type === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) {
        out[key] = await exec(child, index1Based);
      }
      return out;
    }
    const n = node.itemsDeep
      ? await withTimeout(
          (async () => {
            const base = await resolveLocatorWithHops(
              page,
              page.mainFrame(),
              node.itemsSelector,
            );
            return base.count();
          })(),
          perReadTimeoutMs,
          "extract cache items count (deep)",
        )
      : await withTimeout(
          page.locator(node.itemsSelector).count(),
          perReadTimeoutMs,
          "extract cache items count",
        );
    const results: unknown[] = [];
    for (let i = 0; i < n; i++) {
      results.push(await exec(node.item, i + 1));
    }
    return results;
  };

  return await exec(root, null);
}
