import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the SPA only. Wrangler serves it from dist/client alongside the Worker.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/client", emptyOutDir: true },
});
