// Builds the production ModelClient from Worker env. Integration tests replace this module with a
// scripted client (alias in vitest.integration.config.ts), so they never call a model.
import { AnthropicModelClient } from "../adapters/anthropic-model-client";
import type { Logger, ModelClient } from "../core/ports";

const REQUIRED = ["CF_ACCOUNT_ID", "AI_GATEWAY_ID", "CF_AIG_TOKEN"] as const;

/**
 * When a gateway secret is missing, returns a client whose calls throw, naming only the missing
 * variables. Failing at call time, inside a step, ends the Run `failed` at that stage.
 */
export function createModelClient(env: Env, log: Logger): ModelClient {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    const reason = `Model client not configured: missing ${missing.join(", ")}`;
    return {
      call: async () => {
        throw new Error(reason);
      },
    };
  }
  return new AnthropicModelClient({
    gateway: {
      accountId: env.CF_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID,
      token: env.CF_AIG_TOKEN,
    },
    log,
  });
}
