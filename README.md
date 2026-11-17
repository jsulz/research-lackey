# Research Lackey

Scheduled research Runs on Cloudflare Workers. A Worker serves a React homepage and a read-only JSON API backed by D1.

## Setup

1. Install Node (version in `.nvmrc`), then `npm ci`.
2. `npx wrangler login` once, for remote D1 commands and manual deploys. Merging to `main` deploys through CI.
3. Create `.dev.vars` (gitignored) for local settings and secrets:

   ```
   LOG_LEVEL=debug
   APP_ENV=dev
   CF_ACCOUNT_ID=<Cloudflare account ID>
   AI_GATEWAY_ID=<AI Gateway ID>
   CF_AIG_TOKEN=<AI Gateway token>
   AI_GATEWAY_BYOK_ALIAS=<alias of the stored Anthropic key; omit if it is "default">
   ```

   Runs call Claude through AI Gateway, which stores the Anthropic key. `APP_ENV=dev` tags local calls `env=dev` in the gateway logs; production is `prod`. A Run whose new Items reach Synthesis makes one real, billed model call.

4. `npm run dev`, then open `http://localhost:8787`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Build the SPA, apply local D1 migrations, serve on `:8787` |
| `npm test` | Lint, format check, type checks, unit tests (no Workers runtime, no network) |
| `npm run test:integration` | The Worker end to end in the Workers runtime with local D1 |
| `npm run check` | Both suites |
| `npm run docs:interfaces` | Regenerate `docs/interfaces.md` from `src/core/ports.ts`. A unit test fails when it is stale |
| `npm run types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `npm run run:local -- --topic <id>` | Start a manual Run against `npm run dev` and print its Run ID (`--port` if not 8787) |
| `npm run replay -- --run <id> --from triage\|synthesis --config <file>` | Replay a local Run from a stage with another config and print the Replay's Run ID (see [Replay](#replay)) |
| `npm run screenshot -- <url> <out.png>` | Screenshot a page with Playwright (`--wait <selector>`, `--map <host>=<ip>`) |
| `npm run deploy` | Build and deploy to production by hand (CI does this on every merge to `main`) |

## Replay

A Replay reruns a local Run from `triage` or `synthesis` with an alternate config, reusing the source Run's Step artifacts for the stages before it. Use it to compare models, limits or prompts without refetching.

1. `npm run dev`, then `npm run run:local -- --topic ai-infra` and note the Run ID.
2. Copy `src/core/config.ts` (or write the config as `.json`) and change it, for example `tasks.synthesis.model`. Every task's model needs an entry in `prices`.
3. `npm run replay -- --run <id> --from synthesis --config <copy>` prints `Replay <replay id>`.

A Replay is a Run of kind `replay` with `source_run_id`, `from_stage` and its config snapshot in `runs`. Its Report is not public (absent from `GET /api/reports`, 404 from `GET /api/reports/:id`), it records no Items, and it does not change a Topic's last-checked line. Its model calls are tagged `env=dev`. Prompt changes take effect after restarting `npm run dev`. Replays are local only.

## Log levels

The Worker writes one JSON line per log call, with `level`, `msg` and fields. `LOG_LEVEL` sets the minimum level: `debug`, `info`, `warn` or `error`. Unknown values mean `info`.

- Production uses `info`, set in `wrangler.jsonc`. Request lines are not logged at `info`.
- Locally, `LOG_LEVEL=debug` in `.dev.vars` logs one `request` line per API call with method, path, status and duration.
- At `debug`, model calls also log the prompt and response, truncated. Token counts and the gateway log ID are logged at `info`.
- Production logs: `npx wrangler tail --format json`.

## Database

D1 schema and seed data are SQL files in `migrations/`, applied in order.

- Local: `npx wrangler d1 migrations apply research-lackey --local` (`npm run dev` does this).
- Production: `npx wrangler d1 migrations apply research-lackey --remote`.

Agents: see `AGENTS.md` and `docs/dev-loop.md`.
