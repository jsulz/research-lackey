import type { ArtifactStore, StepArtifact, StepName } from "../core/ports";

/** ArtifactStore backed by R2. Step artifacts are JSON at `runs/<run_id>/steps/<stage>.json`. */
export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async putStepArtifact(runId: string, step: StepName, data: StepArtifact): Promise<string> {
    const key = stepKey(runId, step);
    await this.bucket.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  }

  async putItemContent(
    sourceId: string,
    itemKey: string,
    runId: string,
    markdown: string,
  ): Promise<string> {
    // Item keys contain "/", ":" and "//" (URLs, GitHub tag URIs), so the key segment is encoded.
    const key = `items/${sourceId}/${encodeURIComponent(itemKey)}/${runId}.md`;
    await this.bucket.put(key, markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    return key;
  }

  async getStepArtifact(runId: string, step: StepName): Promise<StepArtifact | null> {
    const object = await this.bucket.get(stepKey(runId, step));
    return object ? object.json<StepArtifact>() : null;
  }
}

function stepKey(runId: string, step: StepName): string {
  return `runs/${runId}/steps/${step}.json`;
}
