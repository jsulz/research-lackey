import { env } from "cloudflare:workers";

/** Deletes every Run and the Items they recorded. Items reference Runs, so they go first. */
export async function deleteRuns(): Promise<void> {
  await env.DB.batch([env.DB.prepare("DELETE FROM items"), env.DB.prepare("DELETE FROM runs")]);
}

/** Deletes test Topics and their Sources, keeping the seed Topic `ai-infra` and its Sources. */
export async function deleteTestTopics(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sources WHERE topic_id != 'ai-infra'"),
    env.DB.prepare("DELETE FROM topics WHERE id != 'ai-infra'"),
  ]);
}
