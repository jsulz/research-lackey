import { D1RunStore } from "../adapters/d1-run-store";
import { JsonLogger, parseLogLevel } from "../adapters/json-logger";
import type { Logger, RunStore } from "../core/ports";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Routes `/api/*`. Everything else is served by Static Assets before the Worker runs. */
export async function handleApi(request: Request, store: RunStore): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/topics") {
    return json(await store.listTopicsLastChecked());
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const log: Logger = new JsonLogger(parseLogLevel(env.LOG_LEVEL));
    const started = Date.now();
    const { pathname } = new URL(request.url);
    let response: Response;
    try {
      response = await handleApi(request, new D1RunStore(env.DB));
    } catch (err) {
      log.error("request failed", {
        method: request.method,
        path: pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      response = json({ error: "internal" }, 500);
    }
    log.debug("request", {
      method: request.method,
      path: pathname,
      status: response.status,
      ms: Date.now() - started,
    });
    return response;
  },
} satisfies ExportedHandler<Env>;
