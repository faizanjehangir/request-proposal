import type { getCloseoutWorkspace } from "@/src/closeout/proposals";
import type { getPricingWorkspace } from "@/src/pricing/replies";
import type { getQuoteWorkspace } from "@/src/quotes/quote";
import type { getRoutingReview } from "@/src/routing/review";

type Workflow = {
  total: number;
  routing: Awaited<ReturnType<typeof getRoutingReview>>;
  pricing: Awaited<ReturnType<typeof getPricingWorkspace>>;
  quote: Awaited<ReturnType<typeof getQuoteWorkspace>>;
  closeout: Awaited<ReturnType<typeof getCloseoutWorkspace>>;
};

type Stage = "routing" | "pricing" | "quote" | "closeout";
type NextStep = { stage: Stage; title: string; detail: string; action: string; target?: string };

function nextStep({ routing, pricing, quote, closeout }: Workflow): NextStep {
  const delivered = closeout.delivered[0];
  const latest = closeout.replies[0];
  const reply = delivered && latest && latest.message.id > delivered.messageId ? latest.reply : undefined;

  if (closeout.proposal) {
    return closeout.invite
      ? { stage: "closeout", title: "Proposal accepted and kickoff booked", detail: "The accepted terms and meeting details are saved. Open closeout to see both records.", action: "View closeout" }
      : { stage: "closeout", title: closeout.job?.lastError ? "Retry kickoff scheduling" : "Process the queued kickoff", detail: "The proposal is already saved. You can finish scheduling from closeout.", action: "Open closeout" };
  }
  if (reply && !reply.resolution) {
    return { stage: "closeout", title: "Review the customer’s reply", detail: "Read the latest email and choose whether to clarify, revise, or record a rejection.", action: "Review reply", target: "current-customer-reply" };
  }
  if (delivered && !reply?.resolution && (!quote.ready || quote.job?.status === "complete")) {
    return { stage: "closeout", title: "Simulate the customer’s reply", detail: "Try full acceptance to save the proposal and schedule kickoff, or choose a scenario to practice human review.", action: "Open customer replies" };
  }
  if (delivered && reply?.resolution && reply.resolution !== "revise" && quote.job?.status === "complete") {
    return { stage: "closeout", title: reply.resolution === "clarified" ? "Wait for a reply to the clarification" : "Customer rejection recorded", detail: "Review the reply history or use the simulator to try the next customer response.", action: "View reply history" };
  }
  if (!routing.analysis) {
    return { stage: "routing", title: "Analyze the shipper’s request", detail: "Extract service requirements and find routes for each lane. Then review what the carrier can offer.", action: "Open routing" };
  }
  if (routing.emailNeedsReview) {
    return { stage: "routing", title: "Review unmatched email instructions", detail: "Resolve the passages that could not be assigned to a lane before confirming offers.", action: "Review shipper email", target: "email-review" };
  }
  if (routing.pending) {
    const lanes = routing.pending === 1 ? "lane still needs" : "lanes still need";
    return { stage: "routing", title: "Decide what to offer", detail: `${routing.pending} ${lanes} a decision. Open a lane to compare its route and service gaps, then save a decision.`, action: "Review lanes" };
  }
  if (!routing.offered) {
    return { stage: "routing", title: "Routing finished with no offers", detail: "There are no lanes to price. If you meant to offer an eligible lane, update its decision in routing.", action: "View lane decisions" };
  }
  if (!pricing.quoteReady) {
    if (!pricing.active || pricing.stale || pricing.additionalOffers || pricing.job?.status === "canceled") {
      return { stage: "pricing", title: pricing.active ? "Send an updated Pricing request" : "Request rates for your offers", detail: "Send the confirmed routes and services to the simulated Pricing team.", action: "Open Pricing" };
    }
    if (pricing.job?.status !== "complete") {
      return { stage: "pricing", title: pricing.job?.lastError ? "Retry the Pricing email" : "Process the queued Pricing email", detail: "Once the request is sent, you can simulate a Pricing reply.", action: "Open Pricing" };
    }
    return pricing.reply
      ? { stage: "pricing", title: "Resolve the Pricing reply", detail: "Review the unmatched rates. To continue the demo, simulate a complete reply or submit a corrected reply covering every requested lane.", action: "Review Pricing" }
      : { stage: "pricing", title: "Simulate a Pricing reply", detail: "Use the complete reply to move forward, or try an incomplete or conflicting reply to see what needs review.", action: "Open Pricing" };
  }
  if (!quote.current || quote.stale) {
    return { stage: "quote", title: quote.current ? "Create an updated quote" : "Draft the customer quote", detail: "The draft includes the matched rates, disclosed gaps, and reasons for lanes you declined.", action: "Open quote" };
  }
  if (reply?.resolution === "revise" && quote.job?.status === "complete") {
    return { stage: "quote", title: "Prepare a revised quote", detail: "Update lane decisions or rates if the terms changed. For a wording change, edit the email to create a new version for approval.", action: "Open quote" };
  }
  if (!quote.approved) {
    return { stage: "quote", title: "Review and approve the draft", detail: "Check the preview before approving this exact version for delivery.", action: "Review quote" };
  }
  const deliveryQueued = quote.job?.status === "pending" || quote.job?.status === "running";
  return { stage: "quote", title: quote.job?.lastError ? "Retry quote delivery" : deliveryQueued ? "Process the queued quote" : "Send the approved quote", detail: "Once delivered to the simulated inbox, the customer can reply to this version.", action: "Open quote" };
}

export function WorkflowOverview(workflow: Workflow) {
  const { routing, pricing, quote, closeout, total } = workflow;
  const next = nextStep(workflow);
  const decided = total - routing.pending;
  const canPriceEarly = routing.pending > 0 && !pricing.current.blockedReason
    && (!pricing.active || pricing.stale || pricing.additionalOffers > 0 || !pricing.requestPriced);
  const stages = [
    { id: "routing", label: "Routing", status: routing.analysis ? `${decided} of ${total} decided` : "Ready to analyze", done: Boolean(routing.analysis && !routing.pending && !routing.emailNeedsReview) },
    { id: "pricing", label: "Pricing", status: pricing.quoteReady ? "Rates validated" : pricing.stale || pricing.additionalOffers ? "Update request" : pricing.active ? `${pricing.rates.length} of ${pricing.active.scope.length} rates matched` : `${routing.offered} confirmed offers`, done: pricing.quoteReady },
    { id: "quote", label: "Customer quote", status: quote.job?.status === "complete" ? "Delivered" : quote.stale ? "Needs an update" : quote.approved ? "Approved" : quote.current ? "Draft created" : pricing.quoteReady ? "Ready to draft" : "Waiting on lanes and rates", done: quote.job?.status === "complete" },
    { id: "closeout", label: "Acceptance & kickoff", status: closeout.invite ? "Kickoff booked" : closeout.proposal ? "Accepted · Kickoff pending" : closeout.delivered.length ? "Customer reply" : "Waiting on quote", done: Boolean(closeout.invite) },
  ];

  return (
    <>
      <section className="workflow-hero" aria-labelledby="next-step-title">
        <div>
          <p className="workflow-eyebrow">{closeout.invite ? "Complete" : "Next step"}</p>
          <h2 id="next-step-title">{next.title}</h2>
          <p>{next.detail}</p>
        </div>
        <div className="workflow-actions">
          <a className="button primary" href={`#${next.target ?? next.stage}`}>{next.action} <span aria-hidden="true">↗</span></a>
          {canPriceEarly && next.stage === "routing" && <a className="workflow-secondary" href="#pricing">Work on Pricing in parallel</a>}
        </div>
      </section>
      <nav className="workflow-nav" aria-label="Proposal progress">
        <ol>
          {stages.map((stage, index) => (
            <li key={stage.id}>
              <a href={`#${stage.id}`} aria-current={stage.id === next.stage ? "step" : undefined} data-done={stage.done}>
                <span className="step-number" aria-hidden="true">{stage.done ? "✓" : index + 1}</span>
                <span><strong>{stage.label}</strong><small>{stage.status}</small></span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
