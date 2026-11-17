import { useEffect, useState } from "react";
import { fetchReport, type PublicReportDetail, safeHref } from "./report";
import { formatCost, formatDuration, formatTokens } from "./reports";
import { formatUtc } from "./topics";

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "not_found" }
  | { kind: "found"; report: PublicReportDetail };

/** The public report page: synthesis and source links only, never extracted source text. */
export function ReportPage({ id }: { id: string | null }) {
  const [state, setState] = useState<State>(
    id === null ? { kind: "not_found" } : { kind: "loading" },
  );
  useEffect(() => {
    if (id === null) return;
    let active = true;
    fetchReport(id)
      .then((result) => {
        if (active) setState(result);
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <main>
      <p className="home-link">
        <a href="/">Research Lackey</a>
      </p>
      {state.kind === "loading" && <p role="status">Loading report</p>}
      {state.kind === "error" && <p role="alert">Could not load report</p>}
      {state.kind === "not_found" && <h1>Report not found</h1>}
      {state.kind === "found" && <Report report={state.report} />}
    </main>
  );
}

function Report({ report }: { report: PublicReportDetail }) {
  const { sections } = report;
  return (
    <article>
      <header className="report-header">
        <h1>{report.topic.name}</h1>
        <p className="muted report-meta">
          <time dateTime={report.run.started_at}>{formatUtc(report.run.started_at)}</time> ·{" "}
          {formatDuration(report.run.duration_ms)} · {formatTokens(report.tokens)} ·{" "}
          {formatCost(report.cost_usd)}
        </p>
      </header>
      <section aria-labelledby="summary-heading">
        <h2 id="summary-heading">Summary</h2>
        <p>{sections.summary}</p>
      </section>
      <section aria-labelledby="developments-heading">
        <h2 id="developments-heading">Key developments</h2>
        {sections.key_developments.map((f) => (
          <div className="finding" key={f.finding_id}>
            <h3>{f.title}</h3>
            <p>
              <span className="label">What is new:</span> {f.what_is_new}
            </p>
            <p>
              <span className="label">Why it matters:</span> {f.why_it_matters}
            </p>
            <ul className="sources" aria-label="Sources">
              {f.sources.map((s, i) => {
                const href = safeHref(s.url);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: two sources may share a URL
                  <li key={i}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {s.title}
                      </a>
                    ) : (
                      s.title
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
      <section aria-labelledby="implications-heading">
        <h2 id="implications-heading">Technical and competitive implications</h2>
        <p>{sections.implications}</p>
      </section>
      <section aria-labelledby="watching-heading">
        <h2 id="watching-heading">Worth watching</h2>
        <ul>
          {sections.worth_watching.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are plain text and may repeat
            <li key={i}>{w}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
