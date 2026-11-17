import { useEffect, useState } from "react";
import {
  fetchReports,
  formatCost,
  formatDuration,
  formatTokens,
  type PublicReport,
} from "./reports";
import { fetchTopics, formatLastChecked, formatUtc, type TopicLastChecked } from "./topics";

type Load<T> = { kind: "loading" } | { kind: "error" } | { kind: "loaded"; rows: T[] };

/** Loads once on mount. Only the latest effect may update state; a late earlier request is ignored. */
function useLoad<T>(load: () => Promise<T[]>): Load<T> {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    load()
      .then((rows) => {
        if (active) setState({ kind: "loaded", rows });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [load]);
  return state;
}

export function App() {
  const reports = useLoad(fetchReports);
  const topics = useLoad(fetchTopics);

  return (
    <main>
      <h1>Research Lackey</h1>
      <section aria-labelledby="reports-heading">
        <h2 id="reports-heading">Reports</h2>
        <ReportList state={reports} />
      </section>
      <section aria-labelledby="topics-heading">
        <h2 id="topics-heading">Topics</h2>
        <TopicList state={topics} />
      </section>
    </main>
  );
}

function ReportList({ state }: { state: Load<PublicReport> }) {
  if (state.kind === "loading") return <p role="status">Loading reports</p>;
  if (state.kind === "error") return <p role="alert">Could not load reports</p>;
  if (state.rows.length === 0) return <p>No reports yet</p>;
  return (
    <ul className="rows reports">
      {state.rows.map((r) => (
        <li key={r.id}>
          <div className="row-head">
            <span className="row-name">{r.topic.name}</span>
            <time dateTime={r.run.started_at} className="muted">
              {formatUtc(r.run.started_at)}
            </time>
          </div>
          <p className="report-summary">{r.summary}</p>
          <p className="muted report-meta">
            {formatDuration(r.run.duration_ms)} · {formatTokens(r.tokens)} ·{" "}
            {formatCost(r.cost_usd)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function TopicList({ state }: { state: Load<TopicLastChecked> }) {
  if (state.kind === "loading") return <p role="status">Loading topics</p>;
  if (state.kind === "error") return <p role="alert">Could not load topics</p>;
  if (state.rows.length === 0) return <p>No topics yet</p>;
  return (
    <ul className="rows topics">
      {state.rows.map((t) => (
        <li key={t.id}>
          <div className="row-head">
            <span className="row-name">{t.name}</span>
            <span className="muted">{formatLastChecked(t)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
