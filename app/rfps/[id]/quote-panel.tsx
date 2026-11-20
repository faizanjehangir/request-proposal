import { type getQuoteWorkspace } from "@/src/quotes/quote";
import { quoteAiAvailable } from "@/src/quotes/wording";
import { formatDate } from "../../components/dates";
import {
  approveCustomerQuote, generateAiQuote, generateQuote, retryCustomerQuote, saveQuoteWording, sendCustomerQuote,
} from "./quote-actions";
import { RoutingForm } from "./routing-form";

type Workspace = Awaited<ReturnType<typeof getQuoteWorkspace>>;
type Message = { recipient: string; subject: string; body: string };

function EmailPreview({ message, label }: { message: Message; label: string }) {
  return (
    <>
      <dl className="pricing-addresses">
        <dt>To</dt><dd>{message.recipient}</dd>
        <dt>Subject</dt><dd>{message.subject}</dd>
      </dl>
      <pre className="pricing-email quote-email" role="region" aria-label={label} tabIndex={0}>{message.body}</pre>
    </>
  );
}

export function QuotePanel({ rfpId, workspace }: { rfpId: number; workspace: Workspace }) {
  const { current, versions, approved, job, messages, ready, stale, closed } = workspace;
  const version = current ? `v${current.version}` : "";
  const sent = job?.status === "complete";
  const status = closed ? "Proposal accepted" : !current ? (ready ? "Ready to draft the customer quote" : "Waiting for lane decisions and validated rates")
    : sent ? `Quote ${version} delivered to the simulated customer`
      : stale ? `Quote ${version} needs updated terms`
        : job?.lastError ? "Simulated delivery failed · Retry available"
          : job?.status === "pending" || job?.status === "running" ? "Simulated delivery queued"
            : approved ? `Quote ${version} approved and ready to send` : `Quote ${version} awaiting approval`;

  return (
    <section id="quote" className="panel" aria-labelledby="quote-title">
      <div className="section-heading">
        <h2 id="quote-title">Customer quote</h2>
        <p>Review the exact proposal email and deliver it to the simulated customer inbox.</p>
      </div>
      <p className="routing-status" data-tone={closed || sent ? "success" : stale || job?.lastError ? "attention" : "neutral"} role="status">{status}</p>
      {sent && <p className="pricing-note"><a href="#closeout">Open acceptance and kickoff</a></p>}
      {!closed && stale && <p className="routing-warning pricing-note">Routing or Pricing has changed. Create an updated version once the lane terms are ready.</p>}
      {!ready && !current && <p className="pricing-note"><a href="#routing">Review lane decisions</a> or <a href="#pricing">check Pricing replies</a>.</p>}

      {!closed && ready && (!current || stale) && (
        <RoutingForm action={generateQuote.bind(null, rfpId, current?.id ?? null)}
          button={current ? "Create updated quote draft" : "Create quote draft"} primary />
      )}

      {current && (
        <div className="quote-preview">
          <h3>{sent ? `Sent quote ${version}` : `Quote draft ${version}`}</h3>
          <p className="muted">{current.lanes.length} requested lanes · {current.lanes.filter((lane) => lane.disposition !== "no_offer").length} offered</p>
          <EmailPreview message={current} label={`Quote ${version} email preview`} />
          {approved && <p className="pricing-note">Approved by {approved.reviewer} · {formatDate(approved.approvedAt)} ET</p>}
          {!closed && ready && !stale && (
            <>
              <details className="review-edit quote-wording">
                <summary>Edit email wording</summary>
                <p className="muted">Saving a wording change creates a new version for approval. Lane terms come from routing and Pricing.</p>
                <RoutingForm key={current.id} action={saveQuoteWording.bind(null, rfpId, current.id)} button="Save as new version">
                  <div className="field"><label htmlFor="quote-opening">Opening</label><textarea id="quote-opening" name="opening" rows={3} maxLength={2000} defaultValue={current.wording.opening} required /></div>
                  <div className="field"><label htmlFor="quote-closing">Closing</label><textarea id="quote-closing" name="closing" rows={3} maxLength={2000} defaultValue={current.wording.closing} required /></div>
                </RoutingForm>
                {quoteAiAvailable() && <RoutingForm action={generateAiQuote.bind(null, rfpId, current.id)} button="Generate new wording with AI" pendingLabel="Generating…" />}
              </details>
              {!approved && <RoutingForm action={approveCustomerQuote.bind(null, rfpId, current.id)} button={`Approve quote ${version}`} primary />}
              {approved && !sent && (
                job && job.status !== "canceled" ? (
                  <>
                    {job.lastError && <p className="routing-warning pricing-note">{job.lastError}</p>}
                    <RoutingForm action={retryCustomerQuote.bind(null, rfpId, current.id)}
                      button={job.lastError ? "Retry simulated send" : "Process queued send"} primary />
                  </>
                ) : (
                  <RoutingForm action={sendCustomerQuote.bind(null, rfpId, current.id)} button="Send simulated quote" pendingLabel="Sending…" primary>
                    <label className="check-option"><input type="checkbox" name="simulateFailure" />Simulate a temporary delivery failure</label>
                  </RoutingForm>
                )
              )}
            </>
          )}
        </div>
      )}

      {messages.length > 0 && (
        <section className="quote-preview" aria-labelledby="customer-inbox-title">
          <h3 id="customer-inbox-title">Simulated customer inbox</h3>
          <ul className="pricing-messages">
            {messages.map((message) => (
              <li key={message.id}>
                <details>
                  <summary>{message.subject} <small>· {formatDate(message.recordedAt)} ET</small></summary>
                  <EmailPreview message={message} label={`Delivered email · ${message.subject}`} />
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {versions.length > 1 && (
        <details className="pricing-history">
          <summary>Earlier quote versions ({versions.length - 1})</summary>
          {versions.slice(1).map((quote) => (
            <details key={quote.id} className="pricing-history">
              <summary>Version {quote.version} · {formatDate(quote.createdAt)} ET</summary>
              <EmailPreview message={quote} label={`Previous quote version ${quote.version}`} />
            </details>
          ))}
        </details>
      )}
    </section>
  );
}
