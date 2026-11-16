# Dev loop config

How to work in this repo: commands, environments, receipts, conventions, ship steps and gotchas. Committed and public: no secrets, no private paths. Commands marked _(planned)_ do not exist yet; update this file in the same PR that adds them.

## Commands

| Purpose | Command | Notes |
|---|---|---|
| Install | `npm ci` | Exact Node version in `.nvmrc`, shared with CI. Match it locally before running checks |
| Fast check | `npm test` | Biome lint and format, `tsc` type checks, unit tests in Node. No Workers runtime |
| Full check | `npm run check` | Fast check, then `npm run test:integration` (Vite build, then the Worker in the Workers runtime with local D1). Includes the `docs/interfaces.md` freshness test |
| Run locally | `npm run dev` | Builds the SPA, applies local D1 migrations, starts `wrangler dev` on `http://localhost:8787`. Set `LOG_LEVEL=debug` in `.dev.vars` |
| Start a Run locally | `npm run run:local -- --topic <id>` | Needs `npm run dev` running. Starts a `manual` Run with `wrangler workflows trigger --local` and prints its ID. Inspect it with `npx wrangler workflows instances describe research-run <id> --local` |
| Fire the cron locally | `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*&time=<ms>"` | Needs `npm run dev` running. `time` is the tick in Unix milliseconds; omit it to use now. Starts a `scheduled` Run for each due Topic |
| Replay a Run | `npm run replay -- --run <id> --from <stage> --config <file>` | Local only _(planned)_ |
| Regenerate interface docs | `npm run docs:interfaces` | Writes `docs/interfaces.md` from `src/core/ports.ts` |
| Regenerate binding types | `npm run types` | Rerun after changing `wrangler.jsonc` |
| Query local D1 | `npx wrangler d1 execute research-lackey --local --command "<sql>"` | Use `--remote` for production, read-only queries only |

## Environments

| Environment | URL                        | Deployed by                   | Needs Jared for                                                                    |
| ----------- | -------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| local       | `http://localhost:8787`    | `npx wrangler dev`            | `.dev.vars` secrets (already present)                                              |
| production  | `https://lackey.jsulz.com` | Ship steps below, after merge | `npx wrangler login` once; `npx wrangler secret put <NAME>` for each Worker secret |

There are no preview deployments. Cloudflare preview versions share production D1 and R2 bindings.

## Receipts

| Evidence tag                | How to capture                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| unit test, integration test | `npm run check > <run folder>/preflight/<ts>.log 2>&1`; quote the summary lines                                             |
| captured API response       | `curl -s <base>/api/<path> \| jq` against local or production                                                               |
| screenshot | `npm run screenshot -- <url> <file>.png --wait <selector>` (Playwright; first run on a machine: `npx playwright install chromium`). Add `--map lackey.jsulz.com=<ip>` when this machine cannot resolve a freshly deployed domain |
| log excerpt                 | `wrangler dev` terminal output locally; `npx wrangler tail --format json` in production                                     |
| D1 or R2 state              | `npx wrangler d1 execute ...` and `npx wrangler r2 object get research-lackey/<key> --pipe` (add `--remote` for production) |
| CI run | `gh run list --commit <sha>`, then `gh run view <id>` (add `--log-failed` for failures). Cite the run URL |
| deployed smoke              | The ticket's production Verify step against `https://lackey.jsulz.com`                                                      |
| AI Gateway log              | Screenshot of the gateway's Logs view, filtered by metadata                                                                 |

## Conventions

- Branch: the Linear issue's `gitBranchName`.
- Commits and PR titles: `type(JSU-N): summary`, with type one of feat, fix, chore, docs, test, refactor.
- PR ticket reference: `Part of JSU-N`. Never `Closes`. Tickets close only after production receipts.
- Tracker: Linear, project "Autonomous Research Agent".
- CI: `.github/workflows/ci.yml`, job `check`, runs `npm ci && npm run check` on every PR to `main` and every push to `main`. The `main` ruleset requires `check` to pass. Renaming the job blocks every merge until the ruleset is updated.
- TypeScript end to end. D1 access only through `RunStore` with hand-written SQL.

## Ship

After merge to `main`, in order. Each step runs only after Jared approves it.

1. `npx wrangler d1 migrations apply research-lackey --remote` (only when the PR adds migrations)
2. `npx wrangler deploy`
3. The ticket's production Verify steps, with receipts saved to the run folder.

## Gotchas

- `exports.default` is untyped in integration tests: `wrangler types` ran before `main` existed. Rerun `npm run types`.
- `biome migrate` can rewrite `"recommended": true` to `"preset": "none"`, which turns off every lint rule. Keep `"preset": "recommended"`.
- npm blocks dependency install scripts by default (`npm install-scripts ls`). The `esbuild` and `workerd` binaries work without them. Approve one only if a tool fails to start.
- `curl` or the browser cannot resolve `lackey.jsulz.com` right after a deploy: a lookup before the domain existed cached a negative answer on this machine. Check with `dig @1.1.1.1 lackey.jsulz.com`, then use `curl --resolve lackey.jsulz.com:443:<ip>` and `npm run screenshot -- ... --map lackey.jsulz.com=<ip>`. Don't look up the domain locally before a first deploy.
- A git worktree has no `.dev.vars` (gitignored). Copy it in before `npm run types`, or the generated `Env` drops its secrets and narrows `LOG_LEVEL` to `"info"`.
- Integration tests read `.dev.vars` ("Using secrets defined in .dev.vars"). Tests must never log `env` values.
- `npx wrangler r2 object get research-lackey/<content_key> --remote` fails with "The specified key does not exist" for Item content keys. The keys contain `%` (the Item identity is URI-encoded, for example `items/arxiv-serving/arxiv%3A2611.17097/<run_id>.md`), and Wrangler does not escape the key in the remote API URL, so `%3A` arrives as `:`. Escape each `%` as `%25`: `.../arxiv%253A2611.17097/<run_id>.md`. `--local` reads take the key as stored.
