import { Stagehand } from "../lib/v3/index.js";
import { chromium } from "playwright";
import { z } from "zod";

/**
 * Extract example using DeepSeek as the LLM and Playwright's bundled Chromium.
 *
 * Uses the Chromium binary already installed by Playwright in this sandbox.
 * `chromium.executablePath()` resolves it via the `playwright` package, which
 * honors PLAYWRIGHT_BROWSERS_PATH if set (here: /opt/pw-browsers).
 *
 * Prerequisite:
 *   export DEEPSEEK_API_KEY=sk-...
 *
 * Run from the repo root:
 *   pnpm --filter @browserbasehq/stagehand exec tsx examples/deepseek-extract.ts
 */

async function example() {
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model: {
      modelName: "deepseek/deepseek-chat",
      apiKey: process.env.DEEPSEEK_API_KEY,
    },
    localBrowserLaunchOptions: {
      executablePath: chromium.executablePath(),
      headless: true,
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
