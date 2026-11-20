import { and, desc, eq, like } from "drizzle-orm";
import { demoReviewerId, type AppDb } from "../db/client";
import { getRfp } from "../db/queries";
import { acceptedProposals, activityEvents, emailMessages, outboxJobs, quoteApprovals, quoteVersions, reviewers } from "../db/schema";
import type { WorkflowDb } from "../workflow/outbox";
import { formatUsd } from "../pricing/rates";
import { getPricingState } from "../pricing/replies";
import { pricingHash, pricingScope } from "../pricing/requests";
import { getRoutingReview } from "../routing/review";
import { customerMailbox, defaultQuoteWording, describeServices, quoteReference, quoteThread, type QuoteLane, type QuoteWording } from "./contracts";

type Rfp = NonNullable<ReturnType<typeof getRfp>>;
type Routing = ReturnType<typeof getRoutingReview>;
type Pricing = ReturnType<typeof getPricingState>;
export type QuoteVersion = typeof quoteVersions.$inferSelect;

export class QuoteError extends Error {}

export function recordQuote(db: WorkflowDb, rfpId: number, version: number, stage: string, result: string, nextAction: string,
  status: typeof activityEvents.$inferInsert.status = "complete") {
  db.insert(activityEvents).values({
    rfpId, stage, sourceName: quoteReference(rfpId, version), result, nextAction, status, target: "quote",
    occurredAt: new Date().toISOString(),
  }).run();
}

export function quoteTerms(rfp: Rfp, routing: Routing, pricing: Pricing) {
  if (!pricing.quoteReady || !pricing.active || !pricing.reply) return null;
  const reviews = new Map(routing.reviews.map((review) => [review.laneId, review]));
  const offers = new Map(pricing.active.scope.map((offer) => [offer.laneId, offer]));
  const rates = new Map(pricing.rates.map((rate) => [rate.laneId, rate]));
  const lanes: QuoteLane[] = [];
  for (const lane of rfp.lanes) {
    const review = reviews.get(lane.id);
    if (review?.disposition === "no_offer") {
      if (!review.dispositionReason) return null;
      lanes.push({
        laneId: lane.id, origin: lane.origin, destination: lane.destination, tons: lane.tons,
        disposition: "no_offer", reason: review.dispositionReason,
      });
      continue;
    }

    const offer = offers.get(lane.id);
    const rate = rates.get(lane.id);
    if (!offer || !rate || (review?.disposition !== "offer" && review?.disposition !== "alternative")) return null;
    const { revision: _revision, ...scope } = offer;
    lanes.push({
      ...scope, disposition: review.disposition, amountCents: rate.amountCents, currency: rate.currency, unit: rate.unit,
    });
  }
  return { lanes, termsHash: pricingHash(JSON.stringify(lanes)), pricingReplyId: pricing.reply.messageId };
}

export function currentQuoteTerms(db: WorkflowDb, rfpId: number) {
  const rfp = getRfp(rfpId, db);
  if (!rfp) throw new QuoteError("This RFP could not be found.");
  const routing = getRoutingReview(db, rfp);
  return quoteTerms(rfp, routing, getPricingState(db, rfpId, pricingScope(rfp, routing)));
}

export function latestQuote(db: WorkflowDb, rfpId: number) {
  return db.select().from(quoteVersions).where(eq(quoteVersions.rfpId, rfpId))
    .orderBy(desc(quoteVersions.version)).limit(1).get();
}

export function quoteApproval(db: WorkflowDb, quoteId: number) {
  return db.select({ reviewer: reviewers.name, approvedAt: quoteApprovals.approvedAt })
    .from(quoteApprovals).innerJoin(reviewers, eq(reviewers.id, quoteApprovals.reviewerId))
    .where(eq(quoteApprovals.quoteVersionId, quoteId)).get();
}

export const quoteMessagePrefix = "customer-quote-delivery:";
export function quoteMessageKey(versionId: number) {
  return `${quoteMessagePrefix}${versionId}`;
}

function quoteClosed(db: WorkflowDb, rfpId: number) {
  return Boolean(db.select({ id: acceptedProposals.id }).from(acceptedProposals).where(eq(acceptedProposals.rfpId, rfpId)).get());
}

function renderQuote(rfpId: number, version: number, lanes: QuoteLane[], wording: QuoteWording) {
  const subject = `Air freight proposal · ${quoteReference(rfpId, version)}`;
  const terms = lanes.map((lane) => {
    const title = `${lane.origin} → ${lane.destination} · ${lane.tons} tons`;
    if (lane.disposition === "no_offer") return `${title}\nNo offer — ${lane.reason}`;
    return [
      title,
      `Route: ${lane.airports.join(" → ")} · ${lane.transitDays} ${lane.transitDays === "1" ? "day" : "days"}`,
      `Services fulfilled: ${describeServices(lane.offered, "Standard handling only")}`,
      `Requested services unavailable: ${describeServices(lane.unavailable)}`,
      `Rate: ${lane.currency} ${formatUsd(lane.amountCents)} per ${lane.unit}`,
    ].join("\n");
  });
  return { subject, body: [wording.opening, ...terms, wording.closing].join("\n\n") };
}

export function createQuoteDraft(db: AppDb, rfpId: number, expectedId: number | null, wording?: QuoteWording) {
  return db.transaction((tx) => {
    if (quoteClosed(tx, rfpId)) throw new QuoteError("This proposal is already accepted.");
    const terms = currentQuoteTerms(tx, rfpId);
    if (!terms) throw new QuoteError("Finish routing and reconcile rates for all offers before drafting the quote.");
    const previous = latestQuote(tx, rfpId);
    if ((previous?.id ?? null) !== expectedId) {
      throw new QuoteError("A newer quote version exists. Review it before drafting again.");
    }
    const copy = wording ?? previous?.wording ?? defaultQuoteWording;
    if (previous?.termsHash === terms.termsHash && previous.wording.opening === copy.opening && previous.wording.closing === copy.closing) {
      return previous.id;
    }

    const version = (previous?.version ?? 0) + 1;
    const { subject, body } = renderQuote(rfpId, version, terms.lanes, copy);
    const row = tx.insert(quoteVersions).values({
      rfpId, version, ...terms, wording: copy, recipient: customerMailbox, subject, body, createdAt: new Date().toISOString(),
    }).returning({ id: quoteVersions.id }).get();
    recordQuote(tx, rfpId, version, "Create customer quote draft",
      `Saved exact email text and terms for all ${terms.lanes.length} requested lanes.`, "Review and approve this version.");
    return row.id;
  }, { behavior: "immediate" });
}

export function requireCurrentQuote(db: WorkflowDb, rfpId: number, quoteId: number) {
  if (quoteClosed(db, rfpId)) throw new QuoteError("This proposal is already accepted.");
  const quote = latestQuote(db, rfpId);
  if (quote?.id !== quoteId) throw new QuoteError("This quote version was superseded. Review the latest version.");
  if (currentQuoteTerms(db, rfpId)?.termsHash !== quote.termsHash) {
    throw new QuoteError("The quote terms are out of date. Resolve routing or Pricing changes and create an updated draft.");
  }
  return quote;
}

export function approveQuote(db: AppDb, rfpId: number, quoteId: number) {
  db.transaction((tx) => {
    const quote = requireCurrentQuote(tx, rfpId, quoteId);
    const result = tx.insert(quoteApprovals).values({
      quoteVersionId: quote.id, reviewerId: demoReviewerId, approvedAt: new Date().toISOString(),
    }).onConflictDoNothing({ target: quoteApprovals.quoteVersionId }).run();
    if (result.changes) recordQuote(tx, rfpId, quote.version, "Approve customer quote",
      "Demo reviewer approved the exact subject, recipient and email content.", "Send the approved version to the simulated customer inbox.");
  }, { behavior: "immediate" });
}

export function getQuoteWorkspace(db: AppDb, rfp: Rfp, routing: Routing, pricing: Pricing) {
  const versions = db.select().from(quoteVersions).where(eq(quoteVersions.rfpId, rfp.id))
    .orderBy(desc(quoteVersions.version)).all();
  const current = versions[0];
  const approved = current ? quoteApproval(db, current.id) : undefined;
  const job = current ? db.select().from(outboxJobs).where(eq(outboxJobs.quoteVersionId, current.id)).get() : undefined;
  const messages = db.select().from(emailMessages).where(and(
    eq(emailMessages.rfpId, rfp.id), eq(emailMessages.threadKey, quoteThread(rfp.id)), eq(emailMessages.direction, "outbound"), like(emailMessages.messageKey, `${quoteMessagePrefix}%`),
  )).orderBy(desc(emailMessages.id)).all();
  const terms = quoteTerms(rfp, routing, pricing);
  const stale = Boolean(current && terms?.termsHash !== current.termsHash);
  return { versions, current, approved, job, messages, ready: Boolean(terms), stale, closed: quoteClosed(db, rfp.id) };
}
