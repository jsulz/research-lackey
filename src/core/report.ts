import type { PublicReport, PublicReportDetail, ReportDocument } from "./ports";

/** One key development as Synthesis returns it. `sources` are the refs of the Items it cites. */
export interface SynthesisFinding {
  title: string;
  what_is_new: string;
  why_it_matters: string;
  sources: string[];
}

/** Synthesis output: the four sections of the Report schema (T1 spec, user story 19). */
export interface SynthesisReport {
  summary: string;
  key_developments: SynthesisFinding[];
  implications: string;
  worth_watching: string[];
}

/**
 * The JSON schema Synthesis output is constrained to (structured output). Each Finding's
 * `sources` may only name the refs of the Items in this Run's prompt.
 */
export function reportJsonSchema(refs: readonly string[]): Record<string, unknown> {
  const text = { type: "string" };
  return {
    type: "object",
    properties: {
      summary: text,
      key_developments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: text,
            what_is_new: text,
            why_it_matters: text,
            sources: { type: "array", items: { type: "string", enum: [...refs] } },
          },
          required: ["title", "what_is_new", "why_it_matters", "sources"],
          additionalProperties: false,
        },
      },
      implications: text,
      worth_watching: { type: "array", items: text },
    },
    required: ["summary", "key_developments", "implications", "worth_watching"],
    additionalProperties: false,
  };
}

export type ValidationResult =
  | { ok: true; report: SynthesisReport }
  | { ok: false; reason: string };

/**
 * Checks Synthesis output against the Report schema in code, independent of the model's
 * structured output: required non-blank text, and every Finding citing at least one known Item.
 * Repeated refs within a Finding are dropped.
 */
export function validateReport(value: unknown, refs: readonly string[]): ValidationResult {
  const known = new Set(refs);
  const fail = (reason: string): ValidationResult => ({ ok: false, reason });
  if (!isObject(value)) return fail("Report is not an object");
  if (!isText(value.summary)) return fail("summary is missing or blank");
  if (!Array.isArray(value.key_developments)) return fail("key_developments is not an array");
  if (typeof value.implications !== "string") return fail("implications is not a string");
  if (
    !Array.isArray(value.worth_watching) ||
    !value.worth_watching.every((w) => typeof w === "string")
  ) {
    return fail("worth_watching is not an array of strings");
  }

  const findings: SynthesisFinding[] = [];
  for (const [i, f] of value.key_developments.entries()) {
    const at = `key_developments[${i}]`;
    if (!isObject(f)) return fail(`${at} is not an object`);
    for (const field of ["title", "what_is_new", "why_it_matters"] as const) {
      if (!isText(f[field])) return fail(`${at}.${field} is missing or blank`);
    }
    if (!Array.isArray(f.sources) || f.sources.length === 0) {
      return fail(`${at}.sources cites no Item`);
    }
    for (const ref of f.sources) {
      if (typeof ref !== "string" || !known.has(ref)) {
        return fail(`${at}.sources cites unknown Item ${String(ref)}`);
      }
    }
    findings.push({
      title: f.title as string,
      what_is_new: f.what_is_new as string,
      why_it_matters: f.why_it_matters as string,
      sources: [...new Set(f.sources as string[])],
    });
  }
  return {
    ok: true,
    report: {
      summary: value.summary,
      key_developments: findings,
      implications: value.implications,
      worth_watching: value.worth_watching as string[],
    },
  };
}

/** `rpt_<run_id>`: one Report per Run, so a retried publish rewrites the same Report. */
export function reportId(runId: string): string {
  return `rpt_${runId}`;
}

/** `fnd_<run_id>_<position>`, from the Report ID. Stable across retries of the same Run. */
export function findingId(reportIdValue: string, position: number): string {
  return `fnd_${reportIdValue.replace(/^rpt_/, "")}_${position}`;
}

/** The Report as Markdown, stored beside its JSON document. */
export function reportMarkdown(doc: ReportDocument): string {
  const lines = [`# ${doc.topic.name}`, "", `Generated ${doc.generated_at}`, "", "## Summary", ""];
  lines.push(doc.summary, "", "## Key developments", "");
  if (doc.findings.length === 0) lines.push("None.", "");
  for (const f of doc.findings) {
    lines.push(`### ${f.title}`, "", `**What is new:** ${f.what_is_new}`, "");
    lines.push(`**Why it matters:** ${f.why_it_matters}`, "", "Sources:");
    for (const item of f.items) lines.push(`- [${item.title}](${item.url})`);
    lines.push("");
  }
  lines.push("## Technical and competitive implications", "", doc.implications, "");
  lines.push("## Worth watching", "");
  for (const w of doc.worth_watching) lines.push(`- ${w}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * The public view of a Report: its list row plus the four sections from its document. Every
 * field is copied by name, so nothing else in the row or document (such as an R2 key or
 * extracted source text) can reach a public page (ADR-0006).
 */
export function publicReportDetail(row: PublicReport, doc: ReportDocument): PublicReportDetail {
  return {
    id: row.id,
    topic: { id: row.topic.id, name: row.topic.name },
    run: {
      id: row.run.id,
      started_at: row.run.started_at,
      ended_at: row.run.ended_at,
      duration_ms: row.run.duration_ms,
    },
    tokens: row.tokens.map((t) => ({ model: t.model, input: t.input, output: t.output })),
    cost_usd: row.cost_usd,
    finding_count: row.finding_count,
    summary: row.summary,
    sections: {
      summary: doc.summary,
      key_developments: doc.findings.map((f) => ({
        finding_id: f.id,
        title: f.title,
        what_is_new: f.what_is_new,
        why_it_matters: f.why_it_matters,
        sources: f.items.map((item) => ({ title: item.title, url: item.url })),
      })),
      implications: doc.implications,
      worth_watching: [...doc.worth_watching],
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}
