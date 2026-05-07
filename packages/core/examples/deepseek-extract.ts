import { Stagehand } from "../lib/v3/index.js";
import { chromium } from "playwright";
import { z } from "zod";

/**
 * Extract example using DeepSeek as the LLM and Playwright's installed Chromium.
 *
 * Prerequisites:
 *   1. Install Playwright's bundled Chromium:
 *        npx playwright install chromium
 *   2. Configure the Chromium executable path and DeepSeek key in your shell:
 *        export DEEPSEEK_API_KEY=sk-...
 *        # Optional: pin a specific Chromium binary. If unset, the path is
 *        # resolved from the playwright package via chromium.executablePath().
 *        export CHROMIUM_EXECUTABLE_PATH="$(npx playwright install --dry-run chromium | awk '/Install location/ {print $3}')/chrome-linux/chrome"
 *        # Or override Playwright's browser cache directory:
 *        export PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright
 *
 * Run from the repo root:
 *   pnpm --filter @browserbasehq/stagehand exec tsx examples/deepseek-extract.ts
 */

const executablePath =
  process.env.CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();

async function example() {
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: {
      modelName: "deepseek/deepseek-chat",
      apiKey: process.env.DEEPSEEK_API_KEY,
    },
    localBrowserLaunchOptions: {
      executablePath,
      headless: false,
      viewport: { width: 1280, height: 800 },
    },
  });

  await stagehand.init();

  const page = stagehand.context.pages()[0];
  await page.goto("https://news.ycombinator.com/");

  const { stories } = await stagehand.extract(
    "extract the top 5 stories on the front page",
    z.object({
      stories: z.array(
        z.object({
          title: z.string().describe("The title of the story"),
          points: z.number().describe("Number of points the story has"),
          author: z.string().describe("Username of the submitter"),
          url: z.string().url().describe("Link to the story"),
        }),
      ),
    }),
  );

  console.log(JSON.stringify(stories, null, 2));

  await stagehand.close();
}

(async () => {
  await example();
})();
