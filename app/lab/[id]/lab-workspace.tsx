"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { LabAnswer } from "@/src/lab/assistant";
import type { LabLane, RouteFilter } from "@/src/lab/route-view";
import type { LaneRoute, ModelMode } from "@/src/lab/workflow";
import { RouteExplorer } from "./route-explorer";
import styles from "./lab.module.css";

type Message = { question: string; answer?: string };

export function LabWorkspace({ children, routes, lanes, ask, mode }: {
  children: ReactNode;
  routes?: LaneRoute[];
  lanes: LabLane[];
  ask?: (question: string) => Promise<LabAnswer>;
  mode: ModelMode;
}) {
  const [filter, setFilter] = useState<RouteFilter>("all");
  const [focused, setFocused] = useState<number>();
  const [page, setPage] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const exampleLane = lanes.find(lane => lane.origin === "GRU" && lane.destination === "SIN") ?? lanes[0];

  function navigate(next: RouteFilter, page: number) {
    setFilter(next);
    setFocused(undefined);
    setPage(page);
  }

  async function submit(question: string) {
    if (!ask || pending || !question.trim()) return;
    const text = question.trim();
    setPending(true);
    setDraft("");
    setMessages(previous => [...previous, { question: text }]);
    try {
      const answer = await ask(text);
      if (answer.filter) navigate(answer.filter, 0);
      if (answer.laneId !== undefined) { setFocused(answer.laneId); setPage(0); }
      setMessages(previous => [...previous.slice(0, -1), { question: text, answer: answer.text }]);
    } catch {
      setMessages(previous => [...previous.slice(0, -1), { question: text, answer: "The assistant could not answer. Try again." }]);
    } finally {
      setPending(false);
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(draft);
  }

  return <div className={styles.workbench}>
    <div className={styles.board}>
      {routes && <RouteExplorer routes={routes} lanes={lanes} filter={filter} focused={focused} page={page} navigate={navigate} />}
      {children}
    </div>
    <aside className={`panel ${styles.assistant}`} aria-labelledby="lab-assistant">
      <div className="section-heading">
        <h2 id="lab-assistant">Route assistant</h2>
        <p>{mode === "fixture" ? "Fixture mode · Reads this run" : "OpenAI mode · Reads this run"}</p>
      </div>
      {!ask ? <p className="muted">Start an analysis to ask about this RFP.</p> : <>
        <div className={styles.prompts} aria-label="Suggested questions">
          {(routes ? ["Summarize routes", "Show blocked routes", ...(exampleLane ? [`Explain ${exampleLane.origin} → ${exampleLane.destination}`] : [])] : ["What needs review?"]).map(question =>
            <button className="button" type="button" key={question} disabled={pending} onClick={() => void submit(question)}>{question}</button>)}
        </div>
        <div className={styles.messages} role="log" aria-label="Assistant conversation">
          {messages.map((message, index) => <div className={styles.message} key={index}>
            <p className={styles.question}>{message.question}</p>
            <p>{message.answer ?? "Checking this run…"}</p>
          </div>)}
        </div>
        <form onSubmit={send} className={styles.chatForm}>
          <label htmlFor="lab-question">Ask about this run</label>
          <textarea id="lab-question" placeholder="Which routes are blocked?" rows={2} maxLength={500}
            value={draft} onChange={event => setDraft(event.target.value)} disabled={pending} required />
          <button type="submit" className="button primary" disabled={pending || !draft.trim()}>Send</button>
        </form>
      </>}
    </aside>
  </div>;
}
