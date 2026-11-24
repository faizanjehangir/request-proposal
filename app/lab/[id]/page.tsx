import Link from "next/link";
import { notFound } from "next/navigation";
import { getRfp } from "@/src/db/queries";
import { labEnabled } from "@/src/lab/config";
import { getLabRun, labMode, recentLabRuns } from "@/src/lab/runs";
import { services } from "@/src/routing/contracts";
import { analysisInput } from "@/src/routing/review";
import { RoutingForm } from "../../rfps/[id]/routing-form";
import { formatDate } from "../../components/dates";
import { askRun, openProposal, reviewRun, startRun } from "./actions";
import { LabWorkspace } from "./lab-workspace";
import styles from "./lab.module.css";

export const dynamic = "force-dynamic";

export default async function LabDetail({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  if (!labEnabled()) notFound();
  const { id } = await params;
  const rfpId = Number(id);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(rfpId)) notFound();
  const rfp = await getRfp(rfpId);
  if (!rfp) notFound();

  const query = (await searchParams).run;
  const runId = typeof query === "string" ? query : "";
  const run = runId ? await getLabRun(rfp, runId) : undefined;
  const recent = run ? [] : await recentLabRuns(rfp);
  const mode = run?.mode ?? labMode();
  const sourceLabels = new Map(analysisInput(rfp).sources.map(source => [source.id, source.label]));
  const extracted = new Map(run?.state.lanes.map(lane => [lane.id, lane.extracted]));
  const reviewOrder = rfp.lanes.toSorted((a, b) =>
    (extracted.get(b.id)?.issues.length ?? 0) - (extracted.get(a.id)?.issues.length ?? 0));

  const flagged = run?.state.lanes.filter(lane => lane.extracted.issues.length).length ?? 0;
  const unassigned = run?.state.issues.length ?? 0;
  const stages = [
    { title: "Extract requirements", detail: run ? `${rfp.lanes.length} lanes checked` : "Ready to analyze", active: !run, complete: Boolean(run) },
    { title: "Review exceptions", detail: run?.awaitingReview ? `${flagged} flagged lanes · ${unassigned} unassigned` : run ? "Requirements confirmed" : "Waiting for extraction", active: Boolean(run?.awaitingReview), complete: Boolean(run?.state.routes) },
    { title: "Compare flight routes", detail: run?.state.routes ? `${run.state.routes.length} lanes assessed` : "Waiting for review", active: Boolean(run?.state.routes), complete: Boolean(run?.state.routes) },
  ];

  return (
    <>
      <div className="page-heading">
        <Link className="back-link" href="/lab">← AI Lab</Link>
        <div className={styles.header}>
          <div>
            <h1>{rfp.title}</h1>
            <p>V2 routing lab · {mode === "fixture" ? "Fixture mode" : "OpenAI mode"} · RFP {rfpId}</p>
          </div>
          <div className={styles.headerActions}>
            {run && <Link className="button" href={`/lab/${rfpId}`}>Start a new run</Link>}
            {run && <Link className="button" href={`/lab/${rfpId}/compare?run=${runId}`}>Compare V1 and V2</Link>}
            {run?.state.routes && <RoutingForm action={openProposal.bind(null, { sourceId: rfpId, runId })}
              button="Open lab proposal" pendingLabel="Opening proposal…" primary />}
            <Link className="button" href={`/rfps/${rfpId}`}>Original workflow</Link>
          </div>
        </div>
      </div>
      <ol className={styles.stages} aria-label="Lab workflow">
        {stages.map((stage, index) => <li key={stage.title} aria-current={stage.active ? "step" : undefined}>
          <span className={styles.step} aria-hidden="true">{stage.complete ? "✓" : index + 1}</span>
          <div><strong>{stage.title}</strong><p>{stage.detail}</p></div>
        </li>)}
      </ol>
      <LabWorkspace key={runId} mode={mode} routes={run?.state.routes} ask={run ? askRun.bind(null, rfpId, runId) : undefined}
        lanes={rfp.lanes.map(({ id, origin, destination, maxTransitDays }) => ({ id, origin, destination, maxTransitDays }))}>
        {(!run?.state.routes || run.awaitingReview) && <section className="panel" aria-labelledby="lab-review-title">
          <div className="section-heading">
            <h2 id="lab-review-title">{run ? "Review requirements" : "Start a lab analysis"}</h2>
            {!run && <p>Analyze the imported notes and inventory in a separate lab run.</p>}
          </div>
          {!run && (
            <>
              {runId && <p className="routing-warning" role="status">This lab run is unavailable. Start a new one below.</p>}
              <RoutingForm action={startRun.bind(null, rfpId)} button="Extract in AI Lab" pendingLabel="Extracting…" primary>
                {mode === "fixture" && <label className="check-option">
                  <input type="checkbox" name="simulateAmbiguity" value="yes" /> Add a simulated ambiguous instruction
                </label>}
              </RoutingForm>
                {recent.length > 0 && <details className={`pricing-note ${styles.trace}`}>
                  <summary>Open a recent run</summary>
                  <ul className="import-list">
                    {recent.map(item => <li key={item.id}>
                      <Link href={`/lab/${rfpId}?run=${item.id}`}>
                        {formatDate(new Date(item.extractedAt).toISOString())} · {item.mode === "openai" ? "OpenAI" : "Fixture"} · {item.reviewedAt ? "Routes ready" : "Awaiting review"}
                      </Link>
                    </li>)}
                  </ul>
                </details>}
            </>
          )}
          {run?.awaitingReview && (
            <>
              <p className="routing-status" role="status">Paused for requirement review</p>
              <RoutingForm action={reviewRun.bind(null, rfpId, runId, run.revision)} button="Confirm requirements and compare routes" pendingLabel="Comparing routes…" primary buttonFirst>
                {run.state.issues.length > 0 && <div className="workflow-inset">
                  <h3>Unassigned instructions</h3>
                  {run.state.issues.map((issue, index) => <blockquote key={index} className="evidence-block">
                    <p>{issue.excerpt}</p><p>{issue.message}</p>
                  </blockquote>)}
                  <p className="muted">Which lanes does this apply to? If it changes a lane’s services, open that lane and confirm the updated selection.</p>
                </div>}
                <div className="lane-results" tabIndex={0} role="region" aria-label="Extracted lanes">
                  <section className="review-group" aria-label="Review extracted requirements">
                    {reviewOrder.map(lane => {
                      const result = extracted.get(lane.id);
                      if (!result) return null;
                      return <div key={lane.id}><details className={styles.lane} open={result.issues.length ? true : undefined}>
                        <summary><strong>{lane.origin} → {lane.destination}</strong> · {result.issues.length ? "Needs review" : result.services.join(", ") || "General cargo"}</summary>
                        {result.evidence.map((evidence, index) => <blockquote className="evidence-block" key={index}>
                          <p>{evidence.excerpt}</p><cite>{sourceLabels.get(evidence.sourceId) ?? evidence.sourceId}</cite>
                        </blockquote>)}
                        {result.issues.map((issue, index) => <div className="evidence-block routing-warning" key={index}>
                          <p>{issue.message}</p>{issue.excerpt && <p>{issue.excerpt}</p>}
                        </div>)}
                        <div className={styles.laneControls}>
                          <p className="muted">Select required services, or leave them empty for general cargo.</p>
                          {services.map(service => <label className="check-option" key={service}>
                            <input type="checkbox" name={`services-${lane.id}`} value={service} defaultChecked={result.services.includes(service)} />{service}
                          </label>)}
                          <label className="check-option">
                            <input type="checkbox" name={`confirmed-${lane.id}`} value="yes" />
                            Confirm this service selection for {lane.origin} to {lane.destination}
                          </label>
                        </div>
                      </details></div>;
                    })}
                  </section>
                </div>
                <div className="field">
                  <label htmlFor="lab-note">Review note</label>
                  <textarea id="lab-note" name="note" rows={2} maxLength={2000}
                    required={Boolean(run.state.issues.length || run.state.lanes.some(lane => lane.extracted.issues.length))} />
                </div>
              </RoutingForm>
            </>
          )}
        </section>}
        {run && <details className={`panel ${styles.trace}`}>
          <summary>Workflow trace</summary>
          <ol>
            {run.state.events.map(event => <li key={event.step}><strong>{event.step}</strong> · {event.result}</li>)}
            {run.awaitingReview && <li>Waiting for the reviewer to confirm requirements.</li>}
          </ol>
            <p className="muted">This run is saved for an hour. Reopen its URL to continue after a restart.</p>
        </details>}
      </LabWorkspace>
    </>
  );
}
