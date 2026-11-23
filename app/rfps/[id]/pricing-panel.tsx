import { maxPricingReplyLength } from "@/src/pricing/contracts";
import { formatUsd, laneName, mockPricingReply, serviceDescription } from "@/src/pricing/rates";
import type { getPricingWorkspace } from "@/src/pricing/replies";
import { pricingReference } from "@/src/pricing/requests";
import { formatDate } from "../../components/dates";
import { retryRateRequest, sendPricingReply, sendRateRequest } from "./pricing-actions";
import { RoutingForm } from "./routing-form";
import { ReplyEditor } from "./reply-editor";

type Workspace = Awaited<ReturnType<typeof getPricingWorkspace>>;
type Thread = Workspace["threads"][number];

function Correspondence({ thread }: { thread: Thread }) {
  return (
    <ul className="pricing-messages">
      {thread.messages.map((message) => (
        <li key={message.id} id={`pricing-message-${message.id}`}>
          <details>
            <summary>{message.direction === "outbound" ? "Email to Pricing" : "Reply from Pricing"} <small>· {formatDate(message.recordedAt)}</small></summary>
            <dl className="pricing-addresses">
              <dt>From</dt><dd>{message.sender}</dd>
              <dt>To</dt><dd>{message.recipient}</dd>
              <dt>Subject</dt><dd>{message.subject}</dd>
            </dl>
            <pre className="pricing-email">{message.body}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function RateResults({ workspace }: { workspace: Workspace }) {
  const { active, reply, rates, stale } = workspace;
  if (!active || !reply) return null;
  const byLane = new Map(rates.map((rate) => [rate.laneId, rate]));
  const issuesByLane = Map.groupBy(reply.issues, (issue) => issue.laneId);
  return (
    <div className="pricing-results">
      <h3>{stale ? "Previous rate recommendations" : "Rate reconciliation"}</h3>
      {issuesByLane.get(null)?.map((issue, index) => (
        <details className="pricing-exception" key={index}>
          <summary>{issue.message}</summary>
          {issue.evidence && <blockquote className="evidence-block">{issue.evidence}</blockquote>}
        </details>
      ))}
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Pricing reconciliation table">
        <table>
          <thead><tr><th scope="col">Lane</th><th scope="col">Offered scope</th><th scope="col">Rate per ton</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {active.scope.map((lane) => {
              const rate = byLane.get(lane.laneId);
              const issues = issuesByLane.get(lane.laneId) ?? [];
              return (
                <tr key={lane.laneId}>
                  <th scope="row" className="lane-code">{laneName(lane)}</th>
                  <td>{serviceDescription(lane.offered)}</td>
                  <td>{rate ? `USD ${formatUsd(rate.amountCents)}` : "—"}</td>
                  <td>
                    {rate && (
                      <details><summary>{stale ? "Previous evidence" : "Matched evidence"}</summary>
                        <blockquote className="evidence-block">{rate.evidence}<p><a href={`#pricing-message-${reply.messageId}`}>Open the source Pricing reply</a></p></blockquote>
                      </details>
                    )}
                    {issues.map((issue, index) => issue.evidence ? (
                      <details className="pricing-exception" key={index}>
                        <summary>{issue.message}</summary>
                        <blockquote className="evidence-block">{issue.evidence}</blockquote>
                      </details>
                    ) : <p className="routing-warning" key={index}>{issue.message}</p>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PricingPanel({ rfpId, workspace }: { rfpId: number; workspace: Workspace }) {
  const { active, current, job, quoteReady, reply, stale, threads, additionalOffers, requestPriced } = workspace;
  const sent = job?.status === "complete";
  const pendingSend = job?.status === "pending" || job?.status === "running";
  const demoActions = active && sent && !stale && !current.blockedReason;
  const needsUpdatedRequest = stale || additionalOffers > 0;
  const requestLabel = !active ? "Send simulated Pricing email"
    : needsUpdatedRequest ? "Send updated Pricing request" : "Request pricing again";
  const missingRateLabel = reply ? `${workspace.rates.length} of ${active?.scope.length ?? 0} rates matched · Quote blocked` : "Waiting for a Pricing reply · Quote blocked";
  const state = stale ? "Offer scope changed · Previous rates are stale"
    : current.blockedReason ?? (
      quoteReady ? "Rates ready for quote drafting" :
        requestPriced ? `Rates matched for all ${active?.scope.length ?? 0} requested ${active?.scope.length === 1 ? "lane" : "lanes"}` :
        sent ? missingRateLabel : pendingSend ? "Pricing send queued" :
          job?.status === "failed" ? "Pricing email could not be sent" : `${current.scope.length} offered ${current.scope.length === 1 ? "lane" : "lanes"} ready for Pricing`
    );
  const replyId = reply?.messageId ?? null;
  const latestBody = threads[0]?.messages.find((message) => message.direction === "inbound")?.body;
  return (
    <section id="pricing" className="panel" aria-labelledby="pricing-title">
      <div className="section-heading">
        <h2 id="pricing-title">Pricing correspondence</h2>
        <p>Request USD-per-ton rates for confirmed offers while routing review continues. Email stays in the simulated inbox.</p>
      </div>
      <p className="routing-status" data-tone={quoteReady || requestPriced ? "success" : stale || reply?.issues.length || job?.lastError ? "attention" : "neutral"} role="status">{state}</p>
      {quoteReady && <p className="pricing-note"><a href="#quote">Open customer quote</a></p>}
      {stale && current.blockedReason && <p className="routing-warning pricing-note">{current.blockedReason}</p>}
      {current.pending > 0 && !current.blockedReason && (
        <p className="muted pricing-note">You can price confirmed offers now. Before drafting the quote, <a href="#routing">decide the {current.pending} remaining {current.pending === 1 ? "lane" : "lanes"}</a>.</p>
      )}
      {additionalOffers > 0 && !stale && (
        <p className="muted pricing-note">{additionalOffers} newly confirmed {additionalOffers === 1 ? "offer needs" : "offers need"} an updated Pricing request.</p>
      )}
      {!current.blockedReason && (!pendingSend || needsUpdatedRequest) && (
        <RoutingForm
          action={sendRateRequest.bind(null, rfpId, active?.id ?? null)}
          button={requestLabel}
          pendingLabel="Sending…" primary={!active || needsUpdatedRequest}
        />
      )}
      {active && !stale && !current.blockedReason && (pendingSend || job?.status === "failed") && (
        <RoutingForm action={retryRateRequest.bind(null, rfpId, active.id)}
          button={job?.status === "failed" ? "Retry simulated send" : "Process queued send"} pendingLabel="Processing…" />
      )}
      {active && threads[0].messages.length > 0 && (
        <div className="pricing-thread">
          <h3>Pricing inbox · {pricingReference(active.id)}</h3>
          <Correspondence thread={threads[0]} />
        </div>
      )}
      {demoActions && (
        <div className="workflow-inset">
          <h3>Simulate the Pricing team’s reply</h3>
          <p className="muted">Use a complete reply to get rates for every requested lane. Incomplete and conflicting replies let you practice reviewing a missing rate or two different prices for the same lane.</p>
          <div className="pricing-reply-actions">
            <RoutingForm action={sendPricingReply.bind(null, rfpId, active.id, replyId, "complete")} button="Simulate complete reply" primary={!requestPriced} />
            <RoutingForm action={sendPricingReply.bind(null, rfpId, active.id, replyId, "incomplete")} button="Simulate incomplete reply" />
            <RoutingForm action={sendPricingReply.bind(null, rfpId, active.id, replyId, "conflicting")} button="Simulate conflicting reply" />
          </div>
          <details className="pricing-correction">
            <summary>Send a corrected reply</summary>
            <RoutingForm action={sendPricingReply.bind(null, rfpId, active.id, replyId, "corrected")} button="Send corrected reply">
              <ReplyEditor id="pricing-reply-body" label="Corrected Pricing email" rows={6}
                maxLength={maxPricingReplyLength} defaultValue={latestBody}
                help="A corrected reply replaces the previous one. Include every requested lane, with one recommendation per line. Use an explicit USD amount per ton and the exact services offered, or standard handling only. Load an example for this request, then edit it before sending."
                examples={[{ label: "Load complete Pricing example", body: mockPricingReply(active.scope, "complete") }]} />
            </RoutingForm>
          </details>
        </div>
      )}
      <RateResults workspace={workspace} />
      {threads.length > 1 && (
        <details className="pricing-history">
          <summary>Earlier Pricing threads ({threads.length - 1})</summary>
          {threads.slice(1).map((thread) => (
            <details key={thread.request.id} className="pricing-history">
              <summary>{pricingReference(thread.request.id)} · {formatDate(thread.request.createdAt)}</summary>
              {thread.messages.length ? <Correspondence thread={thread} /> : <p className="muted">No email delivered.</p>}
            </details>
          ))}
        </details>
      )}
    </section>
  );
}
