// Stands in for src/worker/model-client-factory.ts in integration tests (alias in
// vitest.integration.config.ts), so the real Workflow never calls a model. Tests script responses.
import type { Logger, ModelClient, ModelRequest, ModelResponse } from "../../src/core/ports";

type Responder = (req: ModelRequest) => ModelResponse | Promise<ModelResponse>;

/** Usage reported by the default response. */
export const DEFAULT_USAGE = {
  input_tokens: 1_000,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_write_5m_input_tokens: 0,
  cache_write_1h_input_tokens: 0,
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

let responder: Responder = emptyReport;

/** Every request the Workflow made, in order. */
export const calls: ModelRequest[] = [];

/** Sets how the model answers until `resetScript()`. */
export function script(fn: Responder): void {
  responder = fn;
}

/** Back to the default: an empty, valid Report. Clears recorded calls. */
export function resetScript(): void {
  responder = emptyReport;
  calls.length = 0;
}

export function createModelClient(_env: Env, _log: Logger): ModelClient {
  return {
    async call(req) {
      calls.push(req);
      return responder(req);
    },
  };
}
