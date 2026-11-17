// Stands in for src/worker/model-client-factory.ts in integration tests (alias in
// vitest.integration.config.ts), so the real Workflow never calls a model. Tests script responses
// per task.
import type {
  Logger,
  ModelClient,
  ModelRequest,
  ModelResponse,
  TaskName,
} from "../../src/core/ports";

type Responder = (req: ModelRequest) => ModelResponse | Promise<ModelResponse>;

/** Usage reported by the default responses. */
export const DEFAULT_USAGE = {
  input_tokens: 1_000,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_write_5m_input_tokens: 0,
  cache_write_1h_input_tokens: 0,
};

/** The refs a Triage request asks to score, from its JSON schema's enum. */
export function triageRefs(req: ModelRequest): string[] {
  const schema = req.json_schema as
    | { properties: { scores: { items: { properties: { ref: { enum: string[] } } } } } }
    | undefined;
  return schema?.properties.scores.items.properties.ref.enum ?? [];
}

/** The same score for every Item, so ranking falls back to newest first. */
const evenScores: Responder = (req) => {
  const json = { scores: triageRefs(req).map((ref) => ({ ref, score: 5, reason: "default" })) };
  return { text: JSON.stringify(json), json, model: req.model, usage: DEFAULT_USAGE };
};

/** A schema-valid Report with no key developments. */
const emptyReport: Responder = (req) => {
  const json = {
    summary: "Nothing notable.",
    key_developments: [],
    implications: "None.",
    worth_watching: [],
  };
  return { text: JSON.stringify(json), json, model: req.model, usage: DEFAULT_USAGE };
};

const DEFAULTS: Record<TaskName, Responder> = { triage: evenScores, synthesis: emptyReport };
let responders: Record<TaskName, Responder> = { ...DEFAULTS };

/** Every request the Workflow made, in order. */
export const calls: ModelRequest[] = [];

/** The requests made for one task, in order. */
export function callsFor(task: TaskName): ModelRequest[] {
  return calls.filter((c) => c.task === task);
}

/** Sets how the model answers one task (Synthesis by default) until `resetScript()`. */
export function script(fn: Responder, task: TaskName = "synthesis"): void {
  responders[task] = fn;
}

/** Back to the defaults: even Triage scores and an empty, valid Report. Clears recorded calls. */
export function resetScript(): void {
  responders = { ...DEFAULTS };
  calls.length = 0;
}

export function createModelClient(_env: Env, _log: Logger): ModelClient {
  return {
    async call(req) {
      calls.push(req);
      return responders[req.task](req);
    },
  };
}
