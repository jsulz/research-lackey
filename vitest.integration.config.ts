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
    // The Workflow runs in the test isolate, so swapping these factory modules here gives it a
    // scripted model client and a fake outbound fetch that tests control. No real model call and
    // no real feed request is ever made.
    resolve: {
      alias: [
        {
          find: /^\.\/model-client-factory$/,
          replacement: path.join(import.meta.dirname, "test/integration/scripted-model-client.ts"),
        },
        {
          find: /^\.\/source-fetcher-factory$/,
          replacement: path.join(
            import.meta.dirname,
            "test/integration/fake-source-fetcher-factory.ts",
          ),
        },
      ],
    },
    test: {
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["./test/integration/apply-migrations.ts"],
    },
  };
});
