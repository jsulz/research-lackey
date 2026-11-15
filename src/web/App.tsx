import { useEffect, useState } from "react";
import { fetchTopics, formatLastChecked, type TopicLastChecked } from "./topics";

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; topics: TopicLastChecked[] };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    // Only the latest effect may update state; an earlier request that settles late is ignored.
    let active = true;
    fetchTopics()
      .then((topics) => {
        if (active) setState({ kind: "loaded", topics });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <h1>Research Lackey</h1>
      <section aria-labelledby="topics-heading">
        <h2 id="topics-heading">Topics</h2>
        <TopicList state={state} />
      </section>
    </main>
  );
}

function TopicList({ state }: { state: State }) {
  if (state.kind === "loading") return <p role="status">Loading topics</p>;
  if (state.kind === "error") return <p role="alert">Could not load topics</p>;
  if (state.topics.length === 0) return <p>No topics yet</p>;
  return (
    <ul className="topics">
      {state.topics.map((t) => (
        <li key={t.id}>
          <span className="topic-name">{t.name}</span>
          <span className="topic-checked">{formatLastChecked(t)}</span>
        </li>
      ))}
    </ul>
  );
}
