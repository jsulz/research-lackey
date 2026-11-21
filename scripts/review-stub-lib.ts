export const USAGE = "usage: npm run review-stub -- <report_id> [--base-url <url>]";

export const PRODUCTION_BASE_URL = "https://lackey.jsulz.com";

/** The fields of `GET /api/reports/:id` the review block uses. */
export interface ReviewStubReport {
  id: string;
  run: { started_at: string };
  sections: { key_developments: { finding_id: string; title: string }[] };
}

export interface ReviewStubResult {
  code: number;
  stdout: string;
  stderr: string;
}

type FetchFn = (url: string) => Promise<Response>;

/** Parses `review-stub` arguments: one Report ID and `--base-url <url>` (default production). */
export function parseReviewStubArgs(
  argv: readonly string[],
): { ok: true; reportId: string; baseUrl: string } | { ok: false; error: string } {
  let reportId: string | undefined;
  let baseUrl = PRODUCTION_BASE_URL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--base-url") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, error: "--base-url needs a value" };
      const parsed = URL.canParse(value) ? new URL(value) : null;
      if (
        parsed === null ||
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        value.includes("?") ||
        value.includes("#")
      ) {
        return {
          ok: false,
          error: `invalid base URL (http or https, no query or fragment): ${value}`,
        };
      }
      baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `unknown argument: ${arg}` };
    } else if (reportId === undefined) {
      reportId = arg;
    } else {
      return { ok: false, error: `unexpected argument: ${arg}` };
    }
  }
  if (reportId === undefined || reportId === "") {
    return { ok: false, error: "a Report ID is required" };
  }
  return { ok: true, reportId, baseUrl };
}

/** The Markdown review block for a Report: date and link, verdict, reason, one line per Finding. */
export function formatReviewStub(report: ReviewStubReport, baseUrl: string): string {
  const date = report.run.started_at.slice(0, 10);
  const link = `${baseUrl}/reports/${encodeURIComponent(report.id)}`;
  const findings = report.sections.key_developments;
  const lines = [
    `## ${date} · [${report.id}](${link})`,
    "",
    "<!-- verdict: yes | no. Finding labels: new-to-me | known | noise | wrong -->",
    "- Verdict:",
    "- Reason:",
    findings.length === 0 ? "- Findings: none" : "- Findings:",
    ...findings.map((f) => `  - \`${f.finding_id}\` ${oneLine(f.title)} · label:`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Fetches the Report from the public API and returns the review block, or an error and exit code. */
export async function reviewStub(
  argv: readonly string[],
  fetchFn: FetchFn,
): Promise<ReviewStubResult> {
  const args = parseReviewStubArgs(argv);
  if (!args.ok) return fail(2, `${args.error}\n${USAGE}`);

  const url = `${args.baseUrl}/api/reports/${encodeURIComponent(args.reportId)}`;
  let status: number;
  let body: string;
  try {
    const res = await fetchFn(url);
    status = res.status;
    body = await res.text();
  } catch (error) {
    return fail(1, `GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status < 200 || status > 299) return fail(1, `GET ${url} returned ${status}: ${body}`);

  let report: unknown;
  try {
    report = JSON.parse(body);
  } catch {
    return fail(1, `GET ${url} returned a body that is not JSON`);
  }
  if (!isReviewStubReport(report)) {
    return fail(1, `GET ${url} returned a body without the Report fields the block needs`);
  }
  return { code: 0, stdout: formatReviewStub(report, args.baseUrl), stderr: "" };
}

function fail(code: number, message: string): ReviewStubResult {
  return { code, stdout: "", stderr: `${message}\n` };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReviewStubReport(value: unknown): value is ReviewStubReport {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (!isRecord(value.run) || typeof value.run.started_at !== "string") return false;
  if (!isRecord(value.sections) || !Array.isArray(value.sections.key_developments)) return false;
  return value.sections.key_developments.every(
    (f) => isRecord(f) && typeof f.finding_id === "string" && typeof f.title === "string",
  );
}
