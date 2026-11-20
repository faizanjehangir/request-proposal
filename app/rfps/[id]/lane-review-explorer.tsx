"use client";

import { useState, type ReactNode } from "react";

type LaneEntry = { id: number; origin: string; destination: string; open: boolean; content: ReactNode };
type LaneGroup = { id: string; title: string; entries: LaneEntry[] };

export function LaneReviewExplorer({ groups }: { groups: LaneGroup[] }) {
  const [query, setQuery] = useState("");
  const [disposition, setDisposition] = useState("all");
  const search = query.toUpperCase().replace(/\bTO\b/g, "").replace(/[^A-Z]/g, "");
  const visible = groups.map((group) => ({
    ...group,
    entries: group.entries.filter((lane) => (
      (disposition === "all" || lane.open === (disposition === "open"))
      && (lane.origin + lane.destination).includes(search)
    )),
  }));
  const count = visible.reduce((total, group) => total + group.entries.length, 0);
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <>
      <div className="lane-tools">
        <div className="field">
          <label htmlFor="routing-lane-search">Find a lane</label>
          <input id="routing-lane-search" type="search" placeholder="MEX to CDG" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="routing-disposition-filter">Disposition filter</label>
          <select id="routing-disposition-filter" value={disposition} onChange={(event) => setDisposition(event.target.value)}>
            <option value="all">All lanes</option>
            <option value="open">Decision needed</option>
            <option value="decided">Disposition saved</option>
          </select>
        </div>
      </div>
      <p className="muted" role="status" aria-live="polite">
        {count ? `Showing ${count} of ${total} lanes` : "No lanes match. Try another airport code or select All lanes."}
      </p>
      {visible.filter((group) => group.entries.length > 0).map((group) => (
        <section className="review-group" key={group.id} aria-label={group.title}>
          <h3>{group.title} <span className="muted">({group.entries.length})</span></h3>
          {group.entries.map((lane) => <div key={lane.id}>{lane.content}</div>)}
        </section>
      ))}
    </>
  );
}
