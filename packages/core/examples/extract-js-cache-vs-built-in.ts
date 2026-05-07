/**
 * Side-by-side: **built-in extract disk cache** (`cacheDir` on Stagehand) vs
 * **`extractByJsCache`** (JSON memo of the final object).
 *
 * Run from `packages/core`:
 *   pnpm example extract-js-cache-vs-built-in
 *
 * See table in `lib/v3/extractByJsCache.ts` module doc.
 */
import { Stagehand, extractByJsCache } from "../lib/v3/index.js";
import { z } from "zod";

const DEMO_URL = "https://example.com/";
const schema = z.object({
  title: z.string(),
  heading: z.string(),
});
const instruction =
  "Extract the document title and the main visible h1 heading text.";

function relaxedLocalChrome(): boolean {
  const v = process.env.STAGEHAND_CONTAINER?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (process.env.CURSOR_AGENT === "1") return true;
  return false;
}

(async () => {
  const container = relaxedLocalChrome();
  const localOpts = container
    ? {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        ...(process.env.CHROME_PATH
          ? { executablePath: process.env.CHROME_PATH }
          : {}),
      }
    : undefined;

  console.log("\n=== 1) Built-in extract cache (playbook replay) ===\n");
  const builtin = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: "openai/gpt-4.1-mini",
    cacheDir: "stagehand-compare-builtin-extract",
    ...(localOpts ? { localBrowserLaunchOptions: localOpts } : {}),
  });
  await builtin.init();
  const p1 = builtin.context.pages()[0];
  await p1.goto(DEMO_URL, { waitUntil: "domcontentloaded" });
  console.log("first extract (expect MISS + store)…");
  console.log(await builtin.extract(instruction, schema));
  console.log("second extract (expect HIT = DOM replay, no LLM)…");
  console.log(await builtin.extract(instruction, schema));
  await builtin.close();

  console.log("\n=== 2) extractByJsCache (JSON result memo) ===\n");
  const jsOnly = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: "openai/gpt-4.1-mini",
    ...(localOpts ? { localBrowserLaunchOptions: localOpts } : {}),
  });
  await jsOnly.init();
  const p2 = jsOnly.context.pages()[0];
  await p2.goto(DEMO_URL, { waitUntil: "domcontentloaded" });
  console.log("first call (MISS → extract + write JSON)…");
  console.log(
    await extractByJsCache(jsOnly, instruction, schema, {
      cacheDir: "stagehand-compare-js-extract",
    }),
  );
  console.log("second call (HIT → read JSON only, extract() not invoked)…");
  console.log(
    await extractByJsCache(jsOnly, instruction, schema, {
      cacheDir: "stagehand-compare-js-extract",
    }),
  );
  await jsOnly.close();

  console.log(
    "\nCompare folders: stagehand-compare-builtin-extract/ (extract-*.json playbooks) vs stagehand-compare-js-extract/ (extract-js-*.json envelopes).\n",
  );
})();
