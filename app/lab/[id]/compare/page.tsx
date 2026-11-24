import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/src/db/client";
import { getRfp } from "@/src/db/queries";
import { labEnabled } from "@/src/lab/config";
import { getLabRun } from "@/src/lab/runs";
import { routeLabels, type ExtractedLane, type RouteAssessment, type Service } from "@/src/routing/contracts";
import { getRoutingReview } from "@/src/routing/review";
import { QuoteComparison } from "./quote-comparison";
import styles from "../lab.module.css";

export const dynamic = "force-dynamic";

type Version = {
  extracted: ExtractedLane;
  requirements?: Service[] | null;
  assessment?: RouteAssessment | null;
  sourceLabels?: ReadonlyMap<string, string>;
};

function serviceText(values: Service[]) {
  return values.join(", ") || "General cargo";
}

function duration(start: number, end?: number | null) {
  if (end == null || end < start) return "No review recorded";
  const seconds = Math.floor((end - start) / 1000);
  return seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min ${seconds % 60} sec`;
}

function VersionResult({ version }: { version?: Version }) {
  if (!version) return <p className="muted">No extraction recorded</p>;
  const { extracted, requirements, assessment } = version;
  return <>
    <p><strong>Extracted</strong> · {extracted.issues.length ? "Needs review" : serviceText(extracted.services)}</p>
    <p><strong>Requirements used</strong> · {requirements ? serviceText(requirements) : "Pending"}</p>
    <p><strong>Route</strong> · {assessment ? routeLabels[assessment.status] : "Pending"}
      {assessment?.path && ` · ${assessment.path.airports.join(" → ")} · ${assessment.path.totalDays} days`}</p>
    {(extracted.evidence.length > 0 || extracted.issues.length > 0) && <details>
      <summary>Source evidence</summary>
      {extracted.evidence.map((item, index) => <blockquote key={index} className="evidence-block">
        <p>{item.excerpt}</p><cite>{version.sourceLabels?.get(item.sourceId) ?? item.sourceId}</cite>
      </blockquote>)}
      {extracted.issues.map((issue, index) => <p key={index} className="routing-warning">{issue.message}</p>)}
    </details>}
  </>;
}

function differs(v1: Version | undefined, v2: Version | undefined) {
  if (!v1 || !v2) return false;
  const serviceKey = (services: Service[]) => [...services].sort().join("|");
  if (serviceKey(v1.extracted.services) !== serviceKey(v2.extracted.services)
    || Boolean(v1.extracted.issues.length) !== Boolean(v2.extracted.issues.length)) return true;
  if (v1.requirements && v2.requirements && serviceKey(v1.requirements) !== serviceKey(v2.requirements)) return true;
  if (!v1.assessment || !v2.assessment) return false;
  return v1.assessment.status !== v2.assessment.status
    || v1.assessment.path?.totalDays !== v2.assessment.path?.totalDays
    || v1.assessment.path?.legs.map(leg => leg.id).join() !== v2.assessment.path?.legs.map(leg => leg.id).join();
}

export default async function CompareRun({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string; differences?: string; page?: string }>;
}) {
  if (!labEnabled()) notFound();
  const { id } = await params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  const rfp = await getRfp(Number(id));
  if (!rfp) notFound();
  const query = await searchParams;
  const runId = typeof query.run === "string" ? query.run : "";
  const run = runId && await getLabRun(rfp, runId);
  if (!run) notFound();
  const baseline = await getRoutingReview(await getDb(), rfp);
  const baselineById = new Map(baseline.reviews.map(review => [review.laneId, review]));
  const labById = new Map(run.state.lanes.map(lane => [lane.id, lane.extracted]));
  const labRoutes = new Map(run.state.routes?.map(route => [route.id, route]));
  const rows = rfp.lanes.map(lane => {
    const prior = baselineById.get(lane.id);
    const extracted = labById.get(lane.id);
    const route = labRoutes.get(lane.id);
    const v1 = prior && { ...prior, sourceLabels: baseline.sourceLabels };
    const v2 = extracted && { extracted, requirements: route?.requirements, assessment: route?.assessment, sourceLabels: baseline.sourceLabels };
    return { lane, v1, v2, changed: differs(v1, v2) };
  });
  const count = rows.filter(row => row.changed).length;
  const visible = query.differences === "1" ? rows.filter(row => row.changed) : rows;
  const pageSize = 20;
  const page = Math.min(Math.max(Number.parseInt(query.page ?? "1", 10) || 1, 1), Math.max(1, Math.ceil(visible.length / pageSize)));
  const offset = (page - 1) * pageSize;
  const lastReview = Math.max(0, ...baseline.reviews.filter(review => review.reviewerId).map(review => Date.parse(review.updatedAt)),
    Date.parse(baseline.analysis?.issuesReviewedAt ?? "") || 0);
  const url = `/lab/${id}/compare?run=${runId}`;
  const filter = query.differences === "1" ? "&differences=1" : "";

  return <>
    <div className="page-heading">
      <Link className="back-link" href={`/lab/${id}?run=${runId}`}>← Back to lab run</Link>
      <h1>Compare V1 and V2</h1>
      <p>{rfp.title} · Same imported workbook and flight inventory</p>
    </div>
    <section className="panel" aria-labelledby="comparison-title">
      <div className="section-heading"><h2 id="comparison-title">Comparison summary</h2>
        <p>Elapsed times measure wall time from extraction to the recorded review action, including time spent waiting.</p>
      </div>
      {!baseline.analysis && <p className="routing-warning">Run routing analysis in the <Link href={`/rfps/${id}`}>original workflow</Link> to populate the V1 baseline.</p>}
      <div className={styles.comparisonSummary}>
        <div><h3>V1 original workflow</h3>
          <p>{baseline.analysis ? duration(Date.parse(baseline.analysis.analyzedAt), lastReview) : "Waiting for extraction"}</p>
          <p className="muted">Extraction to latest review action</p>
        </div>
        <div><h3>V2 AI Lab</h3>
          <p>{duration(run.extractedAt, run.reviewedAt)}</p>
          <p className="muted">Extraction to requirements confirmation · {run.state.review?.corrections.length ?? 0} lane selections confirmed</p>
        </div>
      </div>
      {run.state.review?.note && <p className="pricing-note"><strong>V2 review note</strong> · {run.state.review.note}</p>}
    </section>
    <QuoteComparison source={rfp} target={{ sourceId: rfp.id, runId }} />
    <section className="panel pricing-note" aria-labelledby="compare-lanes">
      <div className="section-heading"><h2 id="compare-lanes">Lane evidence and outcomes</h2>
        <p>{count} detected differences across {rows.length} lanes. Pending assessments remain visible for review.</p>
      </div>
      <div className={styles.filters}>
        <Link className="button" aria-current={!filter ? "page" : undefined} href={url}>All lanes</Link>
        <Link className="button" aria-current={filter ? "page" : undefined} href={`${url}&differences=1`}>Differences only</Link>
      </div>
      {visible.length > 0 ? <div className="table-scroll pricing-note" role="region" aria-label="V1 and V2 lane comparison" tabIndex={0}>
        <table><thead><tr><th scope="col">Lane</th><th scope="col">V1 result</th><th scope="col">V2 result</th></tr></thead>
          <tbody>{visible.slice(offset, offset + pageSize).map(({ lane, v1, v2, changed }) =>
            <tr key={lane.id}><th scope="row" className="lane-code">{lane.origin} → {lane.destination}
              {changed && <p className="routing-warning">Different result</p>}</th>
              <td><VersionResult version={v1} /></td><td><VersionResult version={v2} /></td>
            </tr>)}</tbody>
        </table>
      </div> : <p className="muted pricing-note">No differences to show for the recorded results.</p>}
      {visible.length > pageSize && <nav className={`${styles.filters} pricing-note`} aria-label="Comparison pages">
        {page > 1 && <Link className="button" href={`${url}${filter}&page=${page - 1}`}>Previous lanes</Link>}
        {offset + pageSize < visible.length && <Link className="button" href={`${url}${filter}&page=${page + 1}`}>Next lanes</Link>}
      </nav>}
    </section>
  </>;
}
