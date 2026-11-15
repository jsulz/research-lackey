import { defineConfig } from "vitest/config";

// Fast suite: pure code in Node, no Workers runtime, no network.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
