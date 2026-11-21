import { env } from "cloudflare:workers";

/** Deletes every Run and what references it: Polls, Reports and Findings, Step rows, Items. */
export async function deleteRuns(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM polls"),
    env.DB.prepare("DELETE FROM finding_items"),
    env.DB.prepare("DELETE FROM findings"),
    env.DB.prepare("DELETE FROM reports"),
    env.DB.prepare("DELETE FROM run_steps"),
    env.DB.prepare("DELETE FROM items"),
    env.DB.prepare("DELETE FROM runs"),
  ]);
}

/** Deletes test Topics and their Sources, keeping the seed Topic `ai-infra` and its Sources. */
export async function deleteTestTopics(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sources WHERE topic_id != 'ai-infra'"),
    env.DB.prepare("DELETE FROM topics WHERE id != 'ai-infra'"),
  ]);
}
