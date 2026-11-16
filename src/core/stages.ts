import type { Stage } from "./run-pipeline";

/**
 * The production stage list, in order. `fetch` is a placeholder until real Sources arrive:
 * it finds no Items, so every Run ends `completed_no_new_findings`.
 */
export const STAGES: readonly Stage[] = [{ name: "fetch", run: async () => ({ items: [] }) }];
