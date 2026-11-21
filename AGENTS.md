# Agent guide

Read `docs/dev-loop.md` first. It covers commands, receipts, conventions, ship steps and gotchas.

## Layout

| Path | What |
|---|---|
| `src/core/ports.ts` | Interfaces between the pipeline core and its adapters. Add only what a change uses, then run `npm run docs:interfaces` (a test fails when `docs/interfaces.md` is stale) |
| `src/adapters/` | One adapter per port: `D1RunStore` (hand-written SQL), `R2ArtifactStore`, `WorkflowRunStarter`, `HttpSourceFetcher`, `JsonLogger`. No business logic |
| `fixtures/feeds/` | Captured feed files, read only by tests. Nothing under `src/` may name them (a unit test checks) |
| `src/worker/index.ts` | Worker `fetch` handler, which routes `/api/*` (Static Assets serves the SPA for everything else), and the `scheduled` handler for the 15-minute cron. Exports `RunWorkflow` (`src/worker/run-workflow.ts`) |
| `src/web/` | React SPA built by Vite into `dist/client`. Keep testable logic in plain `.ts` modules with no DOM |
| `migrations/` | D1 schema and seed, applied in order |
| `scripts/` | Node scripts run with type stripping (`docs-interfaces.ts`, `screenshot.ts`) |
| `test/unit/` | Vitest in Node. No Workers runtime, no network. Code that names Worker binding types (`Workflow`, `InstanceStatus`, `D1Database`) does not typecheck here; test it in `test/integration/`, even with a fake binding |
| `test/integration/` | Vitest in the Workers runtime (`@cloudflare/vitest-plugin`) with local D1. Requests go through `exports.default.fetch` |

## Rules

- **Migrations are append-only.** Production has applied every file in `migrations/`. Never edit one; add the next numbered file.
- **Tests clean up after themselves.** The seed Topic `ai-infra` always exists; delete any other rows a test inserts.
- **Checks.** `npm run check` must pass. CI runs it as job `check`, which `main` requires; don't rename the job.
- **After changing `wrangler.jsonc`**, run `npm run types`.
- **No secrets or personal identifiers in the repo.** No account IDs, emails, tokens or keys. `.dev.vars` holds local secrets and is gitignored. Never print its values.
- **Model calls are never made by automated tests.** Use a fake `ModelClient`.
- **Feed requests are never made by automated tests.** Integration tests get a fake outbound fetch that serves `fixtures/feeds/`; unit tests pass their own.
