import { Stagehand } from "../lib/v3/index.js";
import { z } from "zod";

/**
 * DeepSeek with V3 `extract()` disk cache (playbook replay).
 *
 * Set `DEEPSEEK_API_KEY` in your environment. The first extract call uses the
 * model and stores a declarative playbook under `cacheDir`. A second extract
 * with the same instruction and Zod schema replays from disk when the DOM
 * still matches. Use `{ useCache: false }` on `extract()` to skip the cache.
 *
 * **Linux containers / CI / Cursor agents:** Chromium often needs sandbox
 * disabled. Set `STAGEHAND_CONTAINER=1` (or `true` / `yes`), or run with
 * `CURSOR_AGENT=1` (set in Cursor cloud), to pass `--no-sandbox` and
 * `--disable-setuid-sandbox` and use headless Chrome. Optional: `CHROME_PATH`
 * for a non-default binary (same as GitHub Actions).
 *
 * From `packages/core`: `pnpm example deepseek-extract-cache`
 */
function relaxedLocalChrome(): boolean {
  const v = process.env.STAGEHAND_CONTAINER?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (process.env.CURSOR_AGENT === "1") return true;
  return false;
}
const listingSchema = z.object({
  listings: z.array(
    z.object({
      price: z.string(),
      address: z.string(),
    }),
  ),
});

async function runExtract(stagehand: Stagehand) {
  return stagehand.extract(
    "Extract all the apartment listings with their prices and their addresses.",
    listingSchema,
  );
}

(async () => {
  const container = relaxedLocalChrome();
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 2,
    model: "deepseek/deepseek-chat",
    cacheDir: "stagehand-deepseek-extract-cache",
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

  await page.goto("https://www.apartments.com/san-francisco-ca/2-bedrooms/", {
    waitUntil: "load",
  });

  console.log("--- First extract (LLM + cache write) ---");
  const first = await runExtract(stagehand);
  console.log(`first run: ${first.listings.length} listings`);

  console.log("--- Second extract (playbook replay when possible) ---");
  const second = await runExtract(stagehand);
  console.log(`second run: ${second.listings.length} listings`);

  await stagehand.close();
})();
