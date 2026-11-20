import type { getRfp } from "@/src/db/queries";
import { pendingDispositionKey, type getRoutingReview } from "@/src/routing/review";
import { permittedDispositions, routeLabels, services, type AssessedPath, type Disposition, type Evidence } from "@/src/routing/contracts";
import { confirmAllCompliant, declineAllOpen, resolveEmail, runAnalysis, saveLaneDisposition, saveRequirements } from "./routing-actions";
import { LaneReviewExplorer } from "./lane-review-explorer";
import { RoutingForm } from "./routing-form";

type Rfp = NonNullable<Awaited<ReturnType<typeof getRfp>>>;
type RoutingReview = Awaited<ReturnType<typeof getRoutingReview>>;
type Review = RoutingReview["reviews"][number];
type Lane = Rfp["lanes"][number];

const dispositionLabels: Record<Disposition, string> = {
  offer: "Compliant offer",
  alternative: "Offer with disclosed gap",
  no_offer: "No offer",
};

function EvidenceBlock({ evidence, labels }: { evidence: Evidence; labels: Map<string, string> }) {
  if (!evidence.excerpt) return null;
  const row = /^workbook-row-(\d+)$/.exec(evidence.sourceId)?.[1];
  const sourceLink = row ? `#shipper-row-${row}` : evidence.sourceId === "shipper-email" ? "#shipper-email-source" : undefined;
  const label = labels.get(evidence.sourceId) ?? evidence.sourceId;
  return (
    <blockquote className="evidence-block">
      <p>{evidence.excerpt}</p>
      <cite>{sourceLink ? <a href={sourceLink}>{label}</a> : label}</cite>
    </blockquote>
  );
}

function Reason({ id, label, required = false }: { id: string; label: string; required?: boolean }) {
  return <div className="field"><label htmlFor={id}>{label}</label><textarea id={id} name="reason" rows={2} maxLength={2000} required={required} /></div>;
}

function PathDetails({ path }: { path: AssessedPath }) {
  return (
    <div className="route-path">
      <p><strong>{path.airports.join(" → ")}</strong> · {path.totalDays} {path.totalDays === "1" ? "day" : "days"}</p>
      {(path.fulfilled.length > 0 || path.missing.length > 0) && (
        <>
          <p className="muted">Fulfilled on every leg · {path.fulfilled.join(", ") || "None of the requested services"}</p>
          {path.missing.length > 0 && <p className="routing-warning">Unavailable end to end · {path.missing.join(", ")}</p>}
        </>
      )}
      <details className="route-legs">
        <summary>Flight legs and service evidence</summary>
        <ol>
          {path.legs.map((leg) => (
            <li key={leg.id}>
              <strong>{leg.origin} → {leg.destination}</strong> · {leg.transitDays} {leg.transitDays === "1" ? "day" : "days"} · <a href={`#flight-row-${leg.sourceRow}`}>Transit row {leg.sourceRow}</a>
              <p className="muted">Available · {leg.services.join(", ") || "Standard cargo"}</p>
              {leg.missing.length > 0 && <p className="routing-warning">Missing · {leg.missing.join(", ")}</p>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function LaneReview({ rfpId, lane, review, workspace }: { rfpId: number; lane: Lane; review: Review; workspace: RoutingReview }) {
  const { assessment, disposition, requirements, extracted } = review;
  const laneKey = `${lane.origin} → ${lane.destination}`;
  const options = permittedDispositions(assessment).filter((value) => !workspace.emailNeedsReview || value === "no_offer");

  return (
    <details className="review-lane">
      <summary>
        <span className="review-lane-name">{laneKey}<small>Row {lane.sourceRow} · {lane.maxTransitDays} days max</small></span>
        <span className={`route-badge ${assessment?.status === "compliant" ? "route-good" : "route-pending"}`}>
          {assessment ? routeLabels[assessment.status] : "Requirements need review"}
        </span>
        <span className="lane-disposition">{disposition ? dispositionLabels[disposition] : "Decision needed"}</span>
      </summary>
      <div className="review-lane-body">
        <p><strong>Requested services</strong> · {requirements ? (requirements.join(", ") || "General cargo") : (extracted.services.join(", ") || "Unconfirmed")}</p>
        {extracted.issues.length > 0 && (
          <ul className="lane-issues">
            {extracted.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}
          </ul>
        )}
        {extracted.evidence.length + extracted.issues.filter((issue) => issue.excerpt).length > 0 && (
          <details className="review-evidence">
            <summary>Original requirement evidence</summary>
            {[...extracted.evidence, ...extracted.issues.filter((issue) => issue.excerpt && !extracted.evidence.some(
              (item) => item.sourceId === issue.sourceId && item.excerpt === issue.excerpt,
            ))].map((evidence, index) => <EvidenceBlock key={index} evidence={evidence} labels={workspace.sourceLabels} />)}
          </details>
        )}
        {assessment?.path ? (
          <>
            <PathDetails path={assessment.path} />
            {assessment.fullServicePath && assessment.status !== "compliant" && assessment.fullServicePath.legs.some((leg, index) => leg.id !== assessment.path?.legs[index]?.id) && (
              <details className="route-legs">
                <summary>Fastest full-service route exceeds the time limit</summary>
                <PathDetails path={assessment.fullServicePath} />
              </details>
            )}
          </>
        ) : assessment ? (
          <p>No directed path connects these airports in the imported flight inventory.</p>
        ) : <p>Confirm the requested services to calculate a route.</p>}
        {assessment?.status === "service_gap" && !permittedDispositions(assessment).includes("alternative") && (
          <p className="routing-warning">The exercise policy blocks offers with this service gap.</p>
        )}
        {options.includes("alternative") && (
          <p className="muted">If you offer this route with the gap disclosed, Pricing will quote only the available services and the customer will see what is unavailable.</p>
        )}

        <details className="review-edit">
          <summary>{requirements === null ? "Confirm or correct services" : "Correct requirements"}</summary>
          <RoutingForm key={review.revision} action={saveRequirements.bind(null, rfpId, lane.id, review.revision)} button="Save and reroute">
            <div className="field">
              <p>Select requested services. Leave all unchecked to confirm general cargo.</p>
              {services.map((service) => (
                <label key={service} className="check-option">
                  <input name="service" type="checkbox" value={service} defaultChecked={(requirements ?? extracted.services).includes(service)} />
                  {service}
                </label>
              ))}
            </div>
            <Reason id={`services-reason-${lane.id}`} label="Correction reason" required />
          </RoutingForm>
        </details>

        {disposition && <p className="saved-disposition"><strong>{dispositionLabels[disposition]}</strong>{review.dispositionReason && ` · ${review.dispositionReason}`}</p>}
        <details className="review-edit">
          <summary>{disposition ? "Change decision" : "Decide what to offer"}</summary>
          <RoutingForm key={review.revision} action={saveLaneDisposition.bind(null, rfpId, lane.id, review.revision)} button="Save decision">
            <div className="field">
              <label htmlFor={`disposition-${lane.id}`}>Lane decision</label>
              <select id={`disposition-${lane.id}`} name="disposition" defaultValue={disposition && options.includes(disposition) ? disposition : options[0]}>
                {options.map((value) => <option value={value} key={value}>{dispositionLabels[value]}</option>)}
              </select>
            </div>
            <Reason id={`disposition-reason-${lane.id}`} label="Reason for an alternative or no offer" />
          </RoutingForm>
        </details>
      </div>
    </details>
  );
}

export function RoutingPanel({ rfp, workspace }: { rfp: Rfp; workspace: RoutingReview }) {
  const { analysis, reviews, pending, offered, emailNeedsReview, sourceLabels } = workspace;
  const byLane = new Map(reviews.map((review) => [review.laneId, review]));
  const compliantPending = reviews.filter((review) => review.assessment?.status === "compliant" && !review.disposition).length;
  const groups = [
    { id: "exceptions", title: "Routing and requirement exceptions", lanes: rfp.lanes.filter((lane) => byLane.get(lane.id)?.assessment?.status !== "compliant") },
    { id: "compliant", title: "Compliant routes", lanes: rfp.lanes.filter((lane) => byLane.get(lane.id)?.assessment?.status === "compliant") },
  ];

  return (
    <section id="routing" className="panel" aria-labelledby="routing-title">
      <div className="section-heading">
        <h2 id="routing-title">Routing review</h2>
        <p>For each lane, decide whether to offer the suggested route, disclose an eligible service gap, or decline.</p>
      </div>
      {!analysis ? (
        <RoutingForm action={runAnalysis.bind(null, rfp.id)} button="Extract requirements and find routes" pendingLabel="Analyzing lanes…" primary />
      ) : (
        <>
          <p className="routing-status" data-tone={emailNeedsReview ? "attention" : pending ? "neutral" : "success"} role="status">
            {pending || emailNeedsReview
              ? `${pending} of ${rfp.lanes.length} lanes awaiting a decision${emailNeedsReview ? " · Shipper email needs review" : ""}`
              : offered ? `Routing complete · ${offered} ${offered === 1 ? "lane" : "lanes"} ready for pricing` : "Routing complete · No offer"}
          </p>
          {offered > 0 && !emailNeedsReview && <p className="pricing-note"><a href="#pricing">Request rates for confirmed offers</a></p>}
          {analysis.issues.length > 0 && (
            <details id="email-review" className="email-review" open={emailNeedsReview}>
              <summary>{emailNeedsReview ? "Review unmatched shipper email" : "Unmatched shipper email reviewed"}</summary>
              {analysis.issues.map((issue, index) => (
                <div key={index} className="email-issue">
                  <p>{issue.message}</p><EvidenceBlock evidence={issue} labels={sourceLabels} />
                </div>
              ))}
              {emailNeedsReview && (
                <RoutingForm action={resolveEmail.bind(null, rfp.id)} button="Confirm email review">
                  <Reason id="email-review-reason" label="Record how you resolved the unmatched passages and update affected lanes." required />
                </RoutingForm>
              )}
            </details>
          )}
          {pending > 0 && (
            <details className="workflow-inset">
              <summary>Bulk decisions</summary>
              <p className="muted">Review individual lanes below, or apply a decision to multiple open lanes at once.</p>
              {compliantPending > 0 && !emailNeedsReview && (
                <RoutingForm action={confirmAllCompliant.bind(null, rfp.id)} button={`Confirm ${compliantPending} compliant ${compliantPending === 1 ? "offer" : "offers"}`} />
              )}
              <details className="pricing-note">
                <summary>Mark remaining lanes as no offer</summary>
                <p className="muted">Applies to all {pending} open {pending === 1 ? "lane" : "lanes"}, including any open compliant routes. Confirm any offers you want to keep first.</p>
                <RoutingForm action={declineAllOpen.bind(null, rfp.id, pendingDispositionKey(reviews))}
                  button={`Mark ${pending} ${pending === 1 ? "lane" : "lanes"} as no offer`}>
                  <Reason id="bulk-no-offer-reason" label="Reason for marking these lanes as no offer" required />
                </RoutingForm>
              </details>
            </details>
          )}
          <LaneReviewExplorer groups={groups.map(({ id, title, lanes }) => ({
            id, title,
            entries: lanes.flatMap((lane) => {
              const review = byLane.get(lane.id);
              return review ? [{
                id: lane.id, origin: lane.origin, destination: lane.destination, open: !review.disposition,
                content: <LaneReview rfpId={rfp.id} lane={lane} review={review} workspace={workspace} />,
              }] : [];
            }),
          }))} />
        </>
      )}
    </section>
  );
}
