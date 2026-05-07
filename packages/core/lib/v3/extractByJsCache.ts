/**
 * Application-level **extract result** cache (JavaScript / JSON on disk).
 *
 * ## vs built-in `cacheDir` extract cache (playbook replay inside `V3.extract`)
 *
 * | | `extractByJsCache` (this helper) | Built-in extract disk cache |
 * |--|----------------------------------|------------------------------|
 * | **Stored value** | Final object after `schema.parse` (JSON) | `CachedExtractEntry`: playbook + metadata |
 * | **On cache hit** | `JSON.parse` → `schema.safeParse` (no DOM read) | Replay playbook: query DOM → `schema.safeParse` |
 * | **If DOM changed** | Can return **stale** text until `bypassCache` / TTL / delete file | Replay fails → **LLM** refreshes playbook |
 * | **LLM on miss** | One `extract()` call | One `extract()` call (may request playbook) |
 * | **Needs ctor `cacheDir`** | No — uses `options.cacheDir` only | Yes — `new Stagehand({ cacheDir })` |
 * | **Determinism** | Hit path is pure I/O + Zod | Hit path is DOM + Zod |
 *
 * This helper always calls `stagehand.extract(..., { ...rest, useCache: false })` so it does
 * not stack on top of the built-in extract cache layer (avoid double-bookkeeping). Use **either**
 * built-in extract cache **or** this helper for the same flow, not both at once.
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { Page as PlaywrightPage } from "playwright-core";
import type { Page as PuppeteerPage } from "puppeteer-core";
import type { Page as PatchrightPage } from "patchright-core";
import { flattenVariables } from "./agent/utils/variables.js";
import { safeGetPageUrl } from "./cache/utils.js";
import type { V3 } from "./v3.js";
import { Page } from "./understudy/page.js";
import type { ExtractOptions } from "./types/public/methods.js";
import type {
  InferStagehandSchema,
  StagehandZodSchema,
} from "./zodCompat.js";
import { toJsonSchema } from "./zodCompat.js";
import { StagehandNotInitializedError } from "./types/public/sdkErrors.js";

const FILE_PREFIX = "extract-js-";

export type ExtractByJsCacheOptions = ExtractOptions & {
  /** Directory for `extract-js-<sha256>.json` files (separate from Stagehand `cacheDir`). */
  cacheDir: string;
  /** When true, skip read hit and overwrite after extract. */
  bypassCache?: boolean;
  /** Extra discriminator when sharing one folder across logical caches. */
  cacheNamespace?: string;
};

type JsCacheEnvelope = {
  version: 1;
  kind: "stagehand-extract-js-v1";
  instruction: string;
  pageUrl: string;
  schemaFingerprint: string;
  selectorKey: string;
  variableKeys: string[];
  namespace: string;
  data: unknown;
};

function fingerprintSchema(schema: StagehandZodSchema): string {
  return createHash("sha256")
    .update(JSON.stringify(toJsonSchema(schema)))
    .digest("hex");
}

/** Same hashing idea as `ExtractCache`, but `kind` differs so files never collide with `extract-*.json`. */
export function buildExtractByJsCacheKey(parts: {
  instruction: string;
  pageUrl: string;
  schemaFingerprint: string;
  selectorKey: string;
  variableKeys: string[];
  namespace: string;
}): string {
  const payload = JSON.stringify({
    kind: "stagehand-extract-js-v1",
    instruction: parts.instruction.trim(),
    url: parts.pageUrl,
    schemaFingerprint: parts.schemaFingerprint,
    selectorKey: parts.selectorKey,
    variableKeys: parts.variableKeys,
    namespace: parts.namespace.trim(),
  });
  return createHash("sha256").update(payload).digest("hex");
}

async function resolvePageUrl(
  stagehand: V3,
  pageOption: ExtractOptions["page"],
): Promise<string> {
  const raw = pageOption ?? stagehand.context.pages()[0];
  if (!raw) {
    throw new StagehandNotInitializedError("extractByJsCache()");
  }
  if (raw instanceof Page) {
    return await safeGetPageUrl(raw);
  }
  try {
    return (raw as PlaywrightPage | PuppeteerPage | PatchrightPage).url();
  } catch {
    return "";
  }
}

/**
 * Memoize `stagehand.extract` results under `cacheDir` as JSON (`extract-js-<hash>.json`).
 *
 * Delegates to `stagehand.extract` with `{ useCache: false }` merged into options.
 */
export async function extractByJsCache<T extends StagehandZodSchema>(
  stagehand: V3,
  instruction: string,
  schema: T,
  options: ExtractByJsCacheOptions,
): Promise<InferStagehandSchema<T>> {
  const {
    cacheDir,
    bypassCache,
    cacheNamespace = "",
    ...extractRest
  } = options;

  const flatVars = flattenVariables(extractRest.variables);
  const variableKeys = flatVars ? Object.keys(flatVars).sort() : [];
  const selectorKey = extractRest.selector?.trim() ?? "";
  const pageUrl = await resolvePageUrl(stagehand, extractRest.page);
  const schemaFingerprint = fingerprintSchema(schema);

  const cacheKey = buildExtractByJsCacheKey({
    instruction,
    pageUrl,
    schemaFingerprint,
    selectorKey,
    variableKeys,
    namespace: cacheNamespace,
  });

  const dir = path.resolve(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${FILE_PREFIX}${cacheKey}.json`);

  if (!bypassCache && fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const env = JSON.parse(raw) as JsCacheEnvelope;
      if (
        env.version === 1 &&
        env.kind === "stagehand-extract-js-v1" &&
        env.instruction === instruction.trim() &&
        env.pageUrl === pageUrl &&
        env.schemaFingerprint === schemaFingerprint &&
        env.selectorKey === selectorKey &&
        env.variableKeys.join(",") === variableKeys.join(",") &&
        (env.namespace ?? "") === cacheNamespace.trim()
      ) {
        const parsed = schema.safeParse(env.data);
        if (parsed.success) {
          return parsed.data as InferStagehandSchema<T>;
        }
      }
    } catch {
      // fall through to fresh extract
    }
  }

  const data = await stagehand.extract(instruction, schema, {
    ...extractRest,
    useCache: false,
  });

  const envelope: JsCacheEnvelope = {
    version: 1,
    kind: "stagehand-extract-js-v1",
    instruction: instruction.trim(),
    pageUrl,
    schemaFingerprint,
    selectorKey,
    variableKeys,
    namespace: cacheNamespace.trim(),
    data,
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), "utf8");
  } catch {
    // best-effort cache write
  }

  return data as InferStagehandSchema<T>;
}
