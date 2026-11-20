import type { ImportIssue } from "@/src/db/schema";

export function IssueList({ issues }: { issues: ImportIssue[] }) {
  return (
    <>
      <ul className="issue-list">
        {issues.map(({ source, row, field, message }, index) => (
          <li key={index}>
            <strong>{[source, row === undefined ? null : `row ${row}`, field].filter(Boolean).join(" · ")}</strong>
            <span>{message}</span>
          </li>
        ))}
      </ul>
      {issues.length === 30 && <p>Showing up to 30 issues. Resubmit after making corrections.</p>}
    </>
  );
}
