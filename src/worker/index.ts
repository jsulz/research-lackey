import { D1RunStore } from "../adapters/d1-run-store";
import { JsonLogger, parseLogLevel } from "../adapters/json-logger";
import { WorkflowRunStarter } from "../adapters/workflow-run-starter";
import type { Logger, RunStore } from "../core/ports";
import { runScheduler } from "../core/scheduler";

/** How many Reports the homepage lists. A starting value. */
const REPORTS_LIMIT = 20;

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
  if (request.method === "GET" && url.pathname === "/api/reports") {
    return json(await store.listPublicReports(REPORTS_LIMIT));
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

  /** The 15-minute cron. Starts a Run for each due Topic. */
  async scheduled(controller, env): Promise<void> {
    await runScheduler({
      tick: new Date(controller.scheduledTime),
      store: new D1RunStore(env.DB),
      starter: new WorkflowRunStarter(env.RUN_WORKFLOW),
      clock: { now: () => new Date() },
      log: new JsonLogger(parseLogLevel(env.LOG_LEVEL)),
    });
  },
} satisfies ExportedHandler<Env>;

export { RunWorkflow } from "./run-workflow";
