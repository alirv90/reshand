import { Stagehand } from "../lib/v3/index.js";
import { chromium } from "playwright";
import { z } from "zod";

/**
 * Extract example using DeepSeek as the LLM and Playwright's bundled Chromium.
 *
 * Resolves the Chromium executable from CHROMIUM_EXECUTABLE_PATH if set,
 * otherwise falls back to chromium.executablePath() from the `playwright`
 * package (which honors PLAYWRIGHT_BROWSERS_PATH). Useful when the
 * sandbox-installed Chromium build does not match the version expected by
 * the bundled `playwright` package.
 *
 * Prerequisites:
 *   export DEEPSEEK_API_KEY=sk-...
 *   # If `playwright`'s expected chromium build is missing in the sandbox:
 *   export CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium
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
      modelName: process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-v4-flash",
      apiKey: process.env.DEEPSEEK_API_KEY,
    },
    localBrowserLaunchOptions: {
      executablePath,
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ["--no-sandbox", "--ignore-certificate-errors"],
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
