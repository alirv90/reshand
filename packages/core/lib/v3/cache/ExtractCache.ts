// lib/v3/cache/ExtractCache.ts
import { createHash } from "crypto";
import type { Logger } from "../types/public/index.js";
import type { Page } from "../understudy/page.js";
import { CacheStorage } from "./CacheStorage.js";
import { executeExtractPlaybook } from "./extractPlaybook.js";
import { safeGetPageUrl, waitForCachedSelector } from "./utils.js";
import type {
  CachedExtractEntry,
  ExtractCacheContext,
  ExtractCacheDeps,
} from "../types/private/index.js";
import type { StagehandZodSchema } from "../zodCompat.js";
import { TimeoutError } from "../types/public/sdkErrors.js";

const FILE_PREFIX = "extract-";

export class ExtractCache {
  private readonly storage: CacheStorage;
  private readonly logger: Logger;
  private readonly domSettleTimeoutMs?: number;

  constructor({ storage, logger, domSettleTimeoutMs }: ExtractCacheDeps) {
    this.storage = storage;
    this.logger = logger;
    this.domSettleTimeoutMs = domSettleTimeoutMs;
  }

  get enabled(): boolean {
    return this.storage.enabled;
  }

  async prepareContext(params: {
    instruction: string;
    page: Page;
    schemaFingerprint: string;
    selector?: string;
    variables?: Record<string, string>;
  }): Promise<ExtractCacheContext | null> {
    if (!this.enabled) return null;
    const sanitizedInstruction = params.instruction.trim();
    const sanitizedVariables = params.variables
      ? { ...params.variables }
      : undefined;
    const variableKeys = sanitizedVariables
      ? Object.keys(sanitizedVariables).sort()
      : [];
    const pageUrl = await safeGetPageUrl(params.page);
    const selectorKey = params.selector?.trim() ?? "";
    const cacheKey = this.buildExtractCacheKey({
      instruction: sanitizedInstruction,
      url: pageUrl,
      schemaFingerprint: params.schemaFingerprint,
      selectorKey,
      variableKeys,
    });
    return {
      instruction: sanitizedInstruction,
      cacheKey,
      pageUrl,
      schemaFingerprint: params.schemaFingerprint,
      selectorKey,
      variableKeys,
    };
  }

  async tryReplay<T extends StagehandZodSchema>(
    context: ExtractCacheContext,
    page: Page,
    schema: T,
    timeout?: number,
  ): Promise<unknown | null> {
    if (!this.enabled) return null;

    const {
      value: entry,
      error,
      path,
    } = await this.storage.readJson<CachedExtractEntry>(
      `${FILE_PREFIX}${context.cacheKey}.json`,
    );
    if (error && path) {
      this.logger({
        category: "cache",
        message: `failed to read extract cache entry: ${path}`,
        level: 2,
        auxiliary: {
          error: { value: String(error), type: "string" },
        },
      });
      return null;
    }
    if (!entry || entry.version !== 1) return null;

    if (
      entry.schemaFingerprint !== context.schemaFingerprint ||
      entry.selectorKey !== context.selectorKey ||
      entry.url !== context.pageUrl ||
      entry.instruction !== context.instruction
    ) {
      return null;
    }

    const entryVariableKeys = Array.isArray(entry.variableKeys)
      ? [...entry.variableKeys].sort()
      : [];
    const contextVariableKeys = [...context.variableKeys];
    if (entryVariableKeys.join(",") !== contextVariableKeys.join(",")) {
      return null;
    }

    try {
      const waitSel =
        entry.playbook.type === "field"
          ? entry.playbook.selector
          : entry.playbook.type === "array"
            ? entry.playbook.itemsSelector
            : undefined;

      await waitForCachedSelector({
        page,
        selector: waitSel,
        timeout: timeout ?? this.domSettleTimeoutMs,
        logger: this.logger,
        context: "extract",
      });

      const raw = await executeExtractPlaybook(page, entry.playbook, {
        perReadTimeoutMs: timeout ?? this.domSettleTimeoutMs,
      });

      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        this.logger({
          category: "cache",
          message: "extract cache replay failed schema validation",
          level: 1,
          auxiliary: {
            error: { value: parsed.error.message, type: "string" },
          },
        });
        return null;
      }

      this.logger({
        category: "cache",
        message: "extract cache hit",
        level: 2,
        auxiliary: {
          instruction: { value: context.instruction, type: "string" },
          url: { value: context.pageUrl, type: "string" },
        },
      });

      return parsed.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isBenign =
        e instanceof TimeoutError ||
        msg.toLowerCase().includes("timeout") ||
        msg.toLowerCase().includes("not found");
      this.logger({
        category: "cache",
        message: `extract cache replay failed${isBenign ? "" : " — falling back to LLM"}`,
        level: isBenign ? 2 : 1,
        auxiliary: {
          error: { value: msg, type: "string" },
        },
      });
      return null;
    }
  }

  async store(
    context: ExtractCacheContext,
    entry: Omit<CachedExtractEntry, "version">,
  ): Promise<void> {
    if (!this.enabled) return;

    const payload: CachedExtractEntry = {
      version: 1,
      ...entry,
    };

    const { error, path } = await this.storage.writeJson(
      `${FILE_PREFIX}${context.cacheKey}.json`,
      payload,
    );
    if (error) {
      this.logger({
        category: "cache",
        message: `failed to write extract cache entry: ${path ?? ""}`,
        level: 2,
        auxiliary: {
          error: { value: String(error), type: "string" },
        },
      });
      return;
    }

    this.logger({
      category: "cache",
      message: "extract cache stored",
      level: 2,
      auxiliary: {
        instruction: { value: context.instruction, type: "string" },
        url: { value: context.pageUrl, type: "string" },
      },
    });
  }

  private buildExtractCacheKey(parts: {
    instruction: string;
    url: string;
    schemaFingerprint: string;
    selectorKey: string;
    variableKeys: string[];
  }): string {
    const payload = JSON.stringify({
      kind: "stagehand-extract-v1",
      instruction: parts.instruction,
      url: parts.url,
      schemaFingerprint: parts.schemaFingerprint,
      selectorKey: parts.selectorKey,
      variableKeys: parts.variableKeys,
    });
    return createHash("sha256").update(payload).digest("hex");
  }
}
