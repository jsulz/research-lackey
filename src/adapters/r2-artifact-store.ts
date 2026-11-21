import type { ArtifactStore, RawItem, ReportDocument, StepArtifact, StepName } from "../core/ports";

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

  async putRawEntries(runId: string, sourceId: string, entries: RawItem[]): Promise<string> {
    const key = `runs/${runId}/raw/${encodeURIComponent(sourceId)}.json`;
    await this.bucket.put(key, JSON.stringify(entries), {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  }

  async getRawEntries(key: string): Promise<RawItem[] | null> {
    const object = await this.bucket.get(key);
    return object ? object.json<RawItem[]>() : null;
  }

  async getItemContent(contentKey: string): Promise<string | null> {
    const object = await this.bucket.get(contentKey);
    return object ? object.text() : null;
  }

  async putReport(reportId: string, doc: ReportDocument, markdown: string): Promise<string> {
    const key = `reports/${reportId}.json`;
    await this.bucket.put(key, JSON.stringify(doc), {
      httpMetadata: { contentType: "application/json" },
    });
    await this.bucket.put(`reports/${reportId}.md`, markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    return key;
  }

  async getReport(key: string): Promise<ReportDocument | null> {
    const object = await this.bucket.get(key);
    return object ? object.json<ReportDocument>() : null;
  }

  async getStepArtifact(runId: string, step: StepName): Promise<StepArtifact | null> {
    const object = await this.bucket.get(stepKey(runId, step));
    return object ? object.json<StepArtifact>() : null;
  }
}

function stepKey(runId: string, step: StepName): string {
  return `runs/${runId}/steps/${step}.json`;
}
