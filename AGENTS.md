## Cursor Cloud specific instructions

### Overview

Stagehand is a TypeScript monorepo (pnpm workspaces + Turborepo) for an AI-powered browser automation framework. Key packages:

- `packages/core` — SDK library (`@browserbasehq/stagehand`)
- `packages/server-v3` / `packages/server-v4` — Fastify API servers
- `packages/cli` — CLI tool
- `packages/evals` — Evaluation suite
- `packages/docs` — Mintlify documentation

### Prerequisites

- **Node.js**: `^20.19.0 || >=22.12.0` (use nvm)
- **pnpm 9.15.0**: enabled via `corepack enable && corepack prepare pnpm@9.15.0 --activate`
- **Playwright browsers**: install with `cd packages/server-v4 && pnpm exec playwright install chromium`

### Common commands

See root `package.json` scripts. Key ones:

| Task                                 | Command                                                |
| ------------------------------------ | ------------------------------------------------------ |
| Install deps                         | `pnpm install`                                         |
| Build all                            | `pnpm run build`                                       |
| Lint (prettier + eslint + typecheck) | `pnpm run lint`                                        |
| Core unit tests                      | `pnpm run test:core`                                   |
| Server-v4 dev                        | `pnpm --filter @browserbasehq/stagehand-server-v4 dev` |
| Server-v3 dev                        | `pnpm --filter @browserbasehq/stagehand-server-v3 dev` |

### Non-obvious caveats

- `pnpm install` triggers a `prepare` script that runs a full Turborepo build. No separate `pnpm run build` is needed after a fresh install.
- Server-v4 defaults to embedded PGlite (`STAGEHAND_DB_MODE=pglite`), so no external Postgres is needed for development.
- The `pnpm run test:server` turbo task currently has a pre-existing config issue referencing a missing `build:esm-tests` task. Run server unit tests directly: `cd packages/server-v4 && pnpm run test:unit`.
- Core unit tests have 4 pre-existing failures in `flowlogger-eventstore.test.ts` — these are not environment issues.
- The example scripts (`packages/core/examples/`) require LLM API keys (e.g. `OPENAI_API_KEY`) and optionally `BROWSERBASE_API_KEY` to run.
- Server-v4 listens on port 3000 by default. Swagger UI is at `/documentation`.
- Pre-commit hook runs `pnpm exec lint-staged` (Prettier formatting).
