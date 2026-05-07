import fs from "fs";
import path from "path";
import { Stagehand } from "../lib/v3/index.js";
import { z } from "zod";

/**
 * DeepSeek + V3 extract **disk cache** with a **nested list** schema (array of
 * objects). Demonstrates playbook `type: "array"` with `itemsSelector` / `item`.
 *
 * Target: `quotes.toscrape.com` (static HTML list of quotes + authors).
 *
 * Requires `DEEPSEEK_API_KEY`. Same container Chrome flags as
 * `deepseek-extract-cache.ts`: `STAGEHAND_CONTAINER=1` / `true` / `yes`, or
 * `CURSOR_AGENT=1`, optional `CHROME_PATH`.
 *
 * From `packages/core`: `pnpm example deepseek-extract-cache-list`
 */
const CACHE_DIR = "stagehand-deepseek-extract-cache-list";

function printExtractCacheOnDisk(): void {
  const abs = path.resolve(process.cwd(), CACHE_DIR);
  console.log("\n--- On-disk extract cache ---");
  console.log("Directory (resolved):", abs);
  if (!fs.existsSync(abs)) {
    console.log("(directory does not exist yet)");
    return;
  }
  const names = fs
    .readdirSync(abs)
    .filter((n) => n.startsWith("extract-") && n.endsWith(".json"))
    .sort();
  if (names.length === 0) {
    console.log("(no extract-*.json files)");
    return;
  }
  for (const name of names) {
    const fp = path.join(abs, name);
    const raw = fs.readFileSync(fp, "utf8");
    console.log("\n---", name, "---");
    try {
      console.log(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      console.log(raw.slice(0, 4000));
    }
  }
}

function relaxedLocalChrome(): boolean {
  const v = process.env.STAGEHAND_CONTAINER?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (process.env.CURSOR_AGENT === "1") return true;
  return false;
}

const DEMO_URL = "https://quotes.toscrape.com/";

const quotesPageSchema = z.object({
  quotes: z.array(
    z.object({
      text: z.string().describe("The quote body as shown on the page"),
      author: z.string().describe("Author name for that quote"),
    }),
  ),
});

async function runExtract(stagehand: Stagehand) {
  return stagehand.extract(
    "Extract every quote on this page. For each quote, capture the full quote text and the author name.",
    quotesPageSchema,
  );
}

(async () => {
  const container = relaxedLocalChrome();
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 2,
    model: "deepseek/deepseek-chat",
    cacheDir: CACHE_DIR,
    ...(container
      ? {
          localBrowserLaunchOptions: {
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
            ...(process.env.CHROME_PATH
              ? { executablePath: process.env.CHROME_PATH }
              : {}),
          },
        }
      : {}),
  });

  await stagehand.init();
  const page = stagehand.context.pages()[0];

  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

  console.log("--- First extract (LLM + cache write, list schema) ---");
  const first = await runExtract(stagehand);
  console.log(`first run: ${first.quotes.length} quotes`);
  console.log(first.quotes.slice(0, 3), first.quotes.length > 3 ? "…" : "");

  console.log("--- Second extract (playbook replay when possible) ---");
  const second = await runExtract(stagehand);
  console.log(`second run: ${second.quotes.length} quotes`);

  printExtractCacheOnDisk();

  await stagehand.close();
})();
