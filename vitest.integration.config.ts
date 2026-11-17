import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Primary test boundary: the Worker in the Workers runtime with local D1.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    // The Workflow runs in the test isolate, so swapping the model client factory module here
    // gives it a scripted client that tests control. No real model call is ever made.
    resolve: {
      alias: [
        {
          find: /^\.\/model-client-factory$/,
          replacement: path.join(import.meta.dirname, "test/integration/scripted-model-client.ts"),
        },
      ],
    },
    test: {
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["./test/integration/apply-migrations.ts"],
    },
  };
});
