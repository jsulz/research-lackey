# Research Lackey

Scheduled research Runs on Cloudflare Workers. A Worker serves a React homepage and a read-only JSON API backed by D1.

## Setup

1. Install Node (version in `.nvmrc`), then `npm ci`.
2. `npx wrangler login` once, for deploys and remote D1 commands.
3. Create `.dev.vars` (gitignored) for local settings and secrets:

   ```
   LOG_LEVEL=debug
   CF_AIG_TOKEN=<AI Gateway token>
   ```

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
| `npm run deploy` | Build and deploy to production |

## Log levels

The Worker writes one JSON line per log call, with `level`, `msg` and fields. `LOG_LEVEL` sets the minimum level: `debug`, `info`, `warn` or `error`. Unknown values mean `info`.

- Production uses `info`, set in `wrangler.jsonc`. Request lines are not logged at `info`.
- Locally, `LOG_LEVEL=debug` in `.dev.vars` logs one `request` line per API call with method, path, status and duration.
- Production logs: `npx wrangler tail --format json`.

## Database

D1 schema and seed data are SQL files in `migrations/`, applied in order.

- Local: `npx wrangler d1 migrations apply research-lackey --local` (`npm run dev` does this).
- Production: `npx wrangler d1 migrations apply research-lackey --remote`.

Agents: see `AGENTS.md` and `docs/dev-loop.md`.
