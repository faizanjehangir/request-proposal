import Link from "next/link";
import type { activityEvents } from "@/src/db/schema";
import { IssueList } from "./import-feedback";
import { formatTime } from "./dates";

export function ActivityPanel({ events, overview = false }: { events: (typeof activityEvents.$inferSelect)[]; overview?: boolean }) {
  return (
    <aside className="panel activity-panel" aria-labelledby="activity-title">
      <div className="section-heading">
        <h2 id="activity-title">Agent Orchestration</h2>
        <p>Recent actions, results, and items that need review.</p>
      </div>
      {!events.length ? (
        <p className="activity-empty">Import a workbook to see its validation and storage results here.</p>
      ) : (
        <>
          <Timeline events={events.slice(0, 4)} overview={overview} />
          {events.length > 4 && (
            <details className="activity-history">
              <summary>Older activity ({events.length - 4})</summary>
              <Timeline events={events.slice(4)} overview={overview} />
            </details>
          )}
        </>
      )}
    </aside>
  );
}

function Timeline({ events, overview }: { events: (typeof activityEvents.$inferSelect)[]; overview: boolean }) {
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id} data-status={event.status}>
          <div className="event-meta">
            <span className={event.status === "complete" ? "event-complete" : "event-failed"}>
              {event.status === "failed" ? (event.rfpId ? "Failed" : "Rejected") : event.status === "review_required" ? "Review needed" : "Complete"}
            </span>
            <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
          </div>
          <h3>{event.stage}</h3>
          <p className="event-source">{event.sourceName}</p>
          <p>{event.result}</p>
          {event.target && event.rfpId && overview ? (
            <Link href={`/rfps/${event.rfpId}#${event.target}`}>{event.nextAction}</Link>
          ) : event.target ? (
            <a href={`#${event.target}`}>{event.nextAction}</a>
          ) : <p>{event.nextAction}</p>}
          {event.issues?.length ? (
            <details className="event-issues">
              <summary>View validation errors</summary>
              <IssueList issues={event.issues} />
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
