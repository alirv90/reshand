import { test, expect } from "@playwright/test";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { V3 } from "../../lib/v3/v3.js";
import type { CachedExtractEntry } from "../../lib/v3/types/private/cache.js";
import type { ExtractPlaybookNode } from "../../lib/v3/cache/extractPlaybook.js";
import { getV3DynamicTestConfig } from "./v3.dynamic.config.js";

const CORRUPT_SELECTOR = "#__stagehand_extract_cache_corrupt__";

// eslint-disable-next-line no-empty-pattern
test("extract disk cache: corrupt playbook forces LLM fallback and refreshes cache", async ({}, testInfo) => {
  test.skip(
    !process.env.OPENAI_API_KEY,
    "OPENAI_API_KEY is required for extract LLM fallback",
  );
  test.setTimeout(120_000);

  await fs.mkdir(testInfo.outputDir, { recursive: true });
  const cacheDir = await fs.mkdtemp(
    path.join(testInfo.outputDir, "extract-cache-"),
  );

  const v3 = new V3(
    getV3DynamicTestConfig({
      cacheDir,
      model: "openai/gpt-4.1-mini",
    }),
  );
  await v3.init();

  try {
    const page = v3.context.pages()[0];
    const instruction =
      "Extract the document title as shown on the page (the main page title text).";
    const schema = z.object({
      title: z.string(),
    });

    await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
    const first = await v3.extract(instruction, schema);
    expect(first.title).toMatch(/example domain/i);

    const cachePath = await locateExtractCacheFile(cacheDir);
    const entry = JSON.parse(
      await fs.readFile(cachePath, "utf8"),
    ) as CachedExtractEntry;
    const didCorrupt = corruptFirstFieldSelector(entry.playbook);
    expect(didCorrupt).toBe(true);
    await fs.writeFile(cachePath, JSON.stringify(entry, null, 2), "utf8");
    expect(
      playbookContainsFieldSelector(entry.playbook, CORRUPT_SELECTOR),
    ).toBe(true);

    await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
    const second = await v3.extract(instruction, schema);
    expect(second.title).toMatch(/example domain/i);

    const healed = JSON.parse(
      await fs.readFile(cachePath, "utf8"),
    ) as CachedExtractEntry;
    expect(
      playbookContainsFieldSelector(healed.playbook, CORRUPT_SELECTOR),
    ).toBe(false);
  } finally {
    await v3.close?.().catch(() => {});
  }
});

async function locateExtractCacheFile(cacheDir: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(cacheDir);
    const files = entries.filter(
      (f) => f.startsWith("extract-") && f.endsWith(".json"),
    );
    if (files.length > 0) {
      return path.join(cacheDir, files[0]!);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for extract cache JSON file");
}

function corruptFirstFieldSelector(playbook: ExtractPlaybookNode): boolean {
  const walk = (node: ExtractPlaybookNode): boolean => {
    if (node.type === "field") {
      (node as { selector: string }).selector = CORRUPT_SELECTOR;
      return true;
    }
    if (node.type === "object") {
      for (const child of Object.values(node.fields)) {
        if (walk(child)) return true;
      }
    }
    if (node.type === "array") {
      return walk(node.item);
    }
    return false;
  };
  return walk(playbook);
}

function playbookContainsFieldSelector(
  playbook: ExtractPlaybookNode,
  selector: string,
): boolean {
  const walk = (node: ExtractPlaybookNode): boolean => {
    if (node.type === "field" && node.selector === selector) return true;
    if (node.type === "object") {
      return Object.values(node.fields).some((c) => walk(c));
    }
    if (node.type === "array") {
      return walk(node.item);
    }
    return false;
  };
  return walk(playbook);
}
