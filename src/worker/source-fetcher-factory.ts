// Builds the production SourceFetcher. Integration tests replace this module (alias in
// vitest.integration.config.ts) with one that builds the same HttpSourceFetcher over a fake
// outbound fetch serving fixture files, so they never reach the network.
import { HttpSourceFetcher } from "../adapters/http-source-fetcher";
import type { FetchConfig } from "../core/config";
import type { SourceFetcher } from "../core/ports";

export function createSourceFetcher(settings: FetchConfig): SourceFetcher {
  return new HttpSourceFetcher({
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    settings,
  });
}
