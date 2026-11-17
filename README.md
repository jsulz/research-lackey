# Research Lackey

Scheduled research Runs on Cloudflare Workers. A Worker serves a React homepage and a read-only JSON API backed by D1.

## Setup

1. Install Node (version in `.nvmrc`), then `npm ci`.
2. `npx wrangler login` once, for deploys and remote D1 commands.
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
| `npm run screenshot -- <url> <out.png>` | Screenshot a page with Playwright (`--wait <selector>`, `--map <host>=<ip>`) |
| `npm run deploy` | Build and deploy to production |

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
