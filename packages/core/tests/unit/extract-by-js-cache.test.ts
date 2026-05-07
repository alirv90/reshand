import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  buildExtractByJsCacheKey,
  extractByJsCache,
} from "../../lib/v3/extractByJsCache.js";

describe("extractByJsCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ejs-cache-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns disk hit without a second extract() call", async () => {
    const extract = vi
      .fn()
      .mockResolvedValueOnce({ title: "first" })
      .mockResolvedValueOnce({ title: "second" });

    const page = { url: () => "https://example.com/page" };
    const stagehand = {
      extract,
      context: { pages: () => [page] },
    };

    const schema = z.object({ title: z.string() });
    const opts = { cacheDir: dir };

    const a = await extractByJsCache(
      stagehand as never,
      "get title",
      schema,
      opts,
    );
    const b = await extractByJsCache(
      stagehand as never,
      "get title",
      schema,
      opts,
    );

    expect(a).toEqual({ title: "first" });
    expect(b).toEqual({ title: "first" });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]?.[2]).toMatchObject({ useCache: false });
  });

  it("buildExtractByJsCacheKey is stable for same inputs", () => {
    const k1 = buildExtractByJsCacheKey({
      instruction: "x",
      pageUrl: "https://a/",
      schemaFingerprint: "fp",
      selectorKey: "",
      variableKeys: [],
      namespace: "",
    });
    const k2 = buildExtractByJsCacheKey({
      instruction: "x",
      pageUrl: "https://a/",
      schemaFingerprint: "fp",
      selectorKey: "",
      variableKeys: [],
      namespace: "",
    });
    expect(k1).toBe(k2);
  });
});
