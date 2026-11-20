import { replyLabels, reviewLabels, type CustomerScenario } from "@/src/closeout/contracts";
import { maxCustomerReplyLength, type getCloseoutWorkspace } from "@/src/closeout/proposals";
import { formatUsd } from "@/src/pricing/rates";
import { describeServices, quoteReference } from "@/src/quotes/contracts";
import { formatDate } from "../../components/dates";
import { replayCustomerAcceptance, retryCalendar, saveReplyReview, sendCustomerReply } from "./closeout-actions";
import { RoutingForm } from "./routing-form";

type Workspace = Awaited<ReturnType<typeof getCloseoutWorkspace>>;
type Reply = Workspace["replies"][number];
type Proposal = NonNullable<Workspace["proposal"]>;

const scenarios = [
  ["partial", "Simulate partial acceptance"],
  ["counteroffer", "Simulate counteroffer"],
  ["rejection", "Simulate rejection"],
  ["unclear", "Simulate ambiguous reply"],
  ["superseded", "Simulate reply to earlier version"],
] as const satisfies ReadonlyArray<readonly [CustomerScenario, string]>;

function CustomerReply({ item, rfpId, closed, current }: { item: Reply; rfpId: number; closed: boolean; current: boolean }) {
  const { message, version, reply } = item;
  const needsReview = reply.intent !== "accepted" && reply.intent !== "duplicate" && !reply.resolution && !closed;
  return (
    <details className="closeout-reply" id={current ? "current-customer-reply" : undefined} open={current && needsReview ? true : undefined}>
      <summary>{replyLabels[reply.intent]} · v{version} <small>· {formatDate(message.recordedAt)} ET</small></summary>
      <p className="pricing-note">{reply.explanation}</p>
      <pre className="pricing-email">{message.body}</pre>
      {reply.resolution && <p className="saved-disposition"><strong>{reviewLabels[reply.resolution]}</strong> · {reply.resolutionNote}</p>}
      {needsReview && (
        <RoutingForm action={saveReplyReview.bind(null, rfpId, message.id)} button="Save reply review">
          <div className="field">
            <label htmlFor={`review-action-${message.id}`}>Review decision</label>
            <select id={`review-action-${message.id}`} name="resolution" defaultValue={reply.intent === "rejection" ? "rejected" : "clarified"}>
              <option value="clarified">Send simulated clarification</option>
              <option value="revise">Request a revised quote</option>
              <option value="rejected">Record rejection</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`review-note-${message.id}`}>Review note or message to the customer</label>
            <textarea id={`review-note-${message.id}`} name="note" required maxLength={2000} rows={3} />
          </div>
          <p className="muted">The note becomes the email body when you choose to send a clarification.</p>
        </RoutingForm>
      )}
      {reply.resolution === "revise" && <p><a href="#quote">Revise and reapprove the customer quote</a></p>}
    </details>
  );
}

function AcceptedRecord({ proposal }: { proposal: Proposal }) {
  return (
    <details className="quote-preview">
      <summary>View accepted proposal in SQLite · P-{proposal.id}</summary>
      <p className="pricing-note"><strong>{proposal.subject}</strong> · Accepted {formatDate(proposal.acceptedAt)} ET</p>
      <blockquote className="evidence-block">{proposal.evidence}</blockquote>
      <div className="table-scroll" role="region" tabIndex={0} aria-label="Accepted lane details">
        <table>
          <thead><tr><th scope="col">Lane</th><th scope="col">Disposition and route</th><th scope="col">Services</th><th scope="col">Price per ton</th></tr></thead>
          <tbody>
            {proposal.lanes.map((lane) => (
              <tr key={lane.laneId}>
                <th scope="row" className="lane-code">{lane.origin} → {lane.destination}<br /><small>{lane.tons} tons</small></th>
                {lane.disposition === "no_offer" ? (
                  <><td>No offer · {lane.reason}</td><td>—</td><td>—</td></>
                ) : (
                  <>
                    <td>{lane.airports.join(" → ")} · {lane.transitDays} {lane.transitDays === "1" ? "day" : "days"}</td>
                    <td>{describeServices(lane.offered, "Standard handling only")}
                      {lane.unavailable.length > 0 && <p className="routing-warning">Unavailable · {describeServices(lane.unavailable)}</p>}
                    </td>
                    <td>{lane.currency} {formatUsd(lane.amountCents)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function KickoffDetails({ invite }: { invite: NonNullable<Workspace["invite"]> }) {
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full", timeStyle: "short", timeZone: invite.timezone,
  });
  const time = new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: invite.timezone });
  return (
    <section className="quote-preview" aria-labelledby="kickoff-title">
      <h3 id="kickoff-title">Simulated kickoff invitation</h3>
      <dl className="pricing-addresses">
        <dt>Invite</dt><dd>{invite.providerId} · {invite.title}</dd>
        <dt>When</dt><dd>{format.format(new Date(invite.startAt))}–{time.format(new Date(invite.endAt))} · {invite.timezone}</dd>
        <dt>Attendees</dt><dd>{invite.attendees.join(", ")}</dd>
      </dl>
    </section>
  );
}

export function CloseoutPanel({ rfpId, workspace }: { rfpId: number; workspace: Workspace }) {
  const { delivered, proposal, invite, job, replies, clarifications } = workspace;
  const current = delivered[0];
  const latest = replies[0];
  const currentReply = current && latest && latest.message.id > current.messageId ? latest.reply : undefined;
  const status = proposal ? (invite ? "Proposal accepted · Kickoff booked" : job?.lastError ? "Proposal accepted · Kickoff scheduling failed" : "Proposal accepted · Kickoff queued")
    : !current ? "Waiting for a customer quote to be sent"
      : currentReply ? (currentReply.resolution ? reviewLabels[currentReply.resolution] : `${replyLabels[currentReply.intent]} · Human review needed`) : "Waiting for the customer’s reply";

  return (
    <section id="closeout" className="panel" aria-labelledby="closeout-title">
      <div className="section-heading">
        <h2 id="closeout-title">Acceptance and kickoff</h2>
        <p>Review customer replies and check the accepted proposal and simulated meeting.</p>
      </div>
      <p className="routing-status" data-tone={invite ? "success" : job?.lastError || (currentReply && !currentReply.resolution) ? "attention" : "neutral"} role="status">{status}</p>
      {current && !proposal && (
        <>
          <div className="workflow-inset">
            <h3>Simulate the customer’s reply</h3>
            <p className="muted">Replies go to {quoteReference(rfpId, current.quote.version)}. Full acceptance saves the proposal and queues the kickoff. Other replies go to human review.</p>
            <RoutingForm action={sendCustomerReply.bind(null, rfpId, current.quote.id, latest?.message.id ?? 0, "full")}
              button="Simulate full acceptance" primary>
              <label className="check-option"><input type="checkbox" name="simulateFailure" />Simulate a temporary calendar failure</label>
            </RoutingForm>
            <div className="pricing-reply-actions">
              {scenarios.filter(([value]) => value !== "superseded" || delivered.length > 1).map(([value, label]) => (
                <RoutingForm key={value} action={sendCustomerReply.bind(null, rfpId, current.quote.id, latest?.message.id ?? 0, value)} button={label} />
              ))}
            </div>
          </div>
          <details className="pricing-correction">
            <summary>Enter a simulated customer reply</summary>
            <RoutingForm action={sendCustomerReply.bind(null, rfpId, current.quote.id, latest?.message.id ?? 0, "custom")} button="Submit customer reply">
              <div className="field"><label htmlFor="customer-reply-body">Customer email</label>
                <textarea id="customer-reply-body" name="body" required maxLength={maxCustomerReplyLength} rows={4} />
              </div>
            </RoutingForm>
          </details>
        </>
      )}
      {replies.length > 0 && (
        <section className="quote-preview" aria-labelledby="customer-replies-title">
          <h3 id="customer-replies-title">Customer replies</h3>
          {replies.map((item) => <CustomerReply key={item.message.id} item={item} rfpId={rfpId} closed={Boolean(proposal)} current={item.reply === currentReply} />)}
          {clarifications.map((message) => (
            <details className="closeout-reply" key={message.id}>
              <summary>Clarification sent <small>· {formatDate(message.recordedAt)} ET</small></summary>
              <pre className="pricing-email">{message.body}</pre>
            </details>
          ))}
        </section>
      )}
      {proposal && (
        <>
          <AcceptedRecord proposal={proposal} />
          {invite ? <KickoffDetails invite={invite} /> : (
            <>
              {job?.lastError && <p className="routing-warning pricing-note">{job.lastError}</p>}
              <RoutingForm action={retryCalendar.bind(null, rfpId)}
                button={job?.lastError ? "Retry kickoff scheduling" : "Process queued kickoff"} primary />
            </>
          )}
          <RoutingForm action={replayCustomerAcceptance.bind(null, rfpId)} button="Replay acceptance reply" />
        </>
      )}
    </section>
  );
}
