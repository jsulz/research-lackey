import { D1RunStore } from "../adapters/d1-run-store";
import { JsonLogger, parseLogLevel } from "../adapters/json-logger";
import { R2ArtifactStore } from "../adapters/r2-artifact-store";
import { WorkflowRunStarter } from "../adapters/workflow-run-starter";
import type { ArtifactStore, Logger, RunStore } from "../core/ports";
import { publicReportDetail } from "../core/report";
import { runScheduler } from "../core/scheduler";

/** How many Reports the homepage lists. A starting value. */
const REPORTS_LIMIT = 20;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const NOT_FOUND = { error: "not_found" };

/** The Report ID in `/api/reports/<id>`: one URI-decoded path segment, else null. */
function reportIdFromPath(pathname: string): string | null {
  const match = /^\/api\/reports\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Routes `/api/*`. Everything else is served by Static Assets before the Worker runs. */
export async function handleApi(
  request: Request,
  store: RunStore,
  artifacts: ArtifactStore,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") return json(NOT_FOUND, 404);
  if (url.pathname === "/api/topics") {
    return json(await store.listTopicsLastChecked());
  }
  if (url.pathname === "/api/reports") {
    return json(await store.listPublicReports(REPORTS_LIMIT));
  }
  const id = reportIdFromPath(url.pathname);
  if (id !== null) {
    const row = await store.getPublicReport(id);
    if (!row) return json(NOT_FOUND, 404);
    const doc = await artifacts.getReport(row.r2_key);
    // A listed Report without its document is corruption, not an unknown Report.
    if (!doc) throw new Error(`Report ${id} has no document at ${row.r2_key}`);
    return json(publicReportDetail(row, doc));
  }
  return json(NOT_FOUND, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const log: Logger = new JsonLogger(parseLogLevel(env.LOG_LEVEL));
    const started = Date.now();
    const { pathname } = new URL(request.url);
    let response: Response;
    try {
      response = await handleApi(
        request,
        new D1RunStore(env.DB),
        new R2ArtifactStore(env.ARTIFACTS),
      );
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
