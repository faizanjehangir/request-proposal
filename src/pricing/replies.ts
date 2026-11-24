import type { ModelConfig } from "../ai/structured";
import { getPricingExcerpts } from "./ai-extraction";
import { and, desc, eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import { emailMessages, outboxJobs, pricingRates, pricingReplies, pricingRequests } from "../db/schema";
import { maxPricingReplyLength, pricingFrom, responseFrom, type ReplyScenario } from "./contracts";
import { mockPricingReply, reconcileRates } from "./rates";
import {
  comparePricingScope, latestPricingRequest, pricingHash, pricingReference, readPricingScope, recordPricing, threadKey, PricingError, type PricingDb,
} from "./requests";

async function latestReply(db: PricingDb, requestId: number) {
  return db.select().from(pricingReplies).where(eq(pricingReplies.requestId, requestId))
    .orderBy(desc(pricingReplies.messageId)).limit(1).get();
}

type InboundEmail = {
  requestId: number;
  rfpId: number;
  messageKey: string;
  thread: string;
  sender: string;
  body: string;
};

export async function receivePricingReply(
  db: AppDb, email: InboundEmail, expectedReplyId: number | null, excerpts?: string[],
) {
  return db.transaction(async (tx) => {
    const active = await latestPricingRequest(tx, email.rfpId);
    const scope = await readPricingScope(tx, email.rfpId);
    if (active?.id !== email.requestId || scope.blockedReason || comparePricingScope(active.scope, scope.scope).stale) {
      throw new PricingError("The offer scope has changed. Request Pricing for the current lanes.");
    }
    const job = await tx.select().from(outboxJobs).where(eq(outboxJobs.pricingRequestId, active.id)).get();
    if (job?.status !== "complete") throw new PricingError("Wait until the simulated Pricing request is sent.");
    if (email.thread !== threadKey(active.id) || email.sender !== pricingFrom) {
      throw new PricingError("The reply must match the active Pricing thread and sender.");
    }
    if (!email.body.trim() || email.body.length > maxPricingReplyLength) {
      throw new PricingError("Enter a nonempty Pricing reply under 1,000,000 characters.");
    }

    const duplicate = await tx.select().from(emailMessages).where(eq(emailMessages.messageKey, email.messageKey)).get();
    if (duplicate) {
      if (duplicate.threadKey !== email.thread || duplicate.direction !== "inbound" || duplicate.body !== email.body) {
        throw new PricingError("The reply reference already belongs to another message.");
      }
      return duplicate.id;
    }
    const previous = await latestReply(tx, active.id);
    if ((previous?.messageId ?? null) !== expectedReplyId) {
      throw new PricingError("There is a newer reply. Refresh Pricing before submitting a correction.");
    }

    const result = reconcileRates(active.scope, email.body, excerpts);
    const message = await tx.insert(emailMessages).values({
      rfpId: email.rfpId, messageKey: email.messageKey, threadKey: email.thread,
      direction: "inbound", sender: email.sender, recipient: responseFrom, subject: `Re: Rate request · ${pricingReference(active.id)}`,
      body: email.body, recordedAt: new Date().toISOString(),
    }).returning({ id: emailMessages.id }).get();
    await tx.insert(pricingReplies).values({ messageId: message.id, requestId: active.id, issues: result.issues }).run();
    for (let i = 0; i < result.rates.length; i += 100) {
      await tx.insert(pricingRates).values(result.rates.slice(i, i + 100).map((rate) => ({ ...rate, replyId: message.id }))).run();
    }
    await recordPricing(tx, email.rfpId, "Receive simulated Pricing reply", pricingReference(active.id),
      "Saved the original email in the Pricing inbox.", "Inspect the rate reconciliation.");
    const { additionalOffers } = comparePricingScope(active.scope, scope.scope);
    await recordPricing(tx, email.rfpId, "Reconcile per-ton rates", pricingReference(active.id),
      `${result.rates.length} of ${active.scope.length} rates matched. ${result.issues.length} Pricing ${result.issues.length === 1 ? "exception" : "exceptions"}.`,
      result.issues.length ? "Provide a complete corrected Pricing reply."
        : additionalOffers ? "Request rates for the newly confirmed offers."
          : scope.pending ? "Continue routing review for the undecided lanes."
            : "Rates are ready for quote drafting.",
      result.issues.length ? "review_required" : "complete");
    return message.id;
  }, { behavior: "immediate" });
}

export async function simulatePricingReply(
  db: AppDb, rfpId: number, requestId: number, expectedReplyId: number | null, scenario: ReplyScenario, text?: string, model?: ModelConfig | null,
) {
  const request = await latestPricingRequest(db, rfpId);
  if (request?.id !== requestId) throw new PricingError("Refresh Pricing to use the active request.");
  const body = scenario === "corrected" ? text ?? "" : mockPricingReply(request.scope, scenario);
  if (!body.trim() || body.length > maxPricingReplyLength) {
    throw new PricingError("Enter a nonempty Pricing reply under 1,000,000 characters.");
  }
  const excerpts = scenario === "corrected" ? await getPricingExcerpts(body, model) : undefined;
  return receivePricingReply(db, {
    rfpId, requestId, body, sender: pricingFrom, thread: threadKey(requestId),
    messageKey: `pricing-reply:${requestId}:${expectedReplyId ?? 0}:${pricingHash(body)}`,
  }, expectedReplyId, excerpts);
}

export async function getPricingState(db: PricingDb, rfpId: number, current: Awaited<ReturnType<typeof readPricingScope>>) {
  const active = await latestPricingRequest(db, rfpId);
  const job = active ? await db.select().from(outboxJobs).where(eq(outboxJobs.pricingRequestId, active.id)).get() : undefined;
  const reply = active ? await latestReply(db, active.id) : undefined;
  const rates = reply ? await db.select().from(pricingRates).where(eq(pricingRates.replyId, reply.messageId)).all() : [];
  const { stale, additionalOffers } = active ? comparePricingScope(active.scope, current.scope) : { stale: false, additionalOffers: 0 };
  const requestPriced = Boolean(active && !stale && !current.blockedReason && job?.status === "complete"
    && reply && !reply.issues.length && rates.length === active.scope.length);
  const quoteReady = requestPriced && current.pending === 0 && additionalOffers === 0;
  return { current, active, job, reply, rates, stale, additionalOffers, requestPriced, quoteReady };
}

export async function getPricingWorkspace(db: AppDb, rfpId: number, current: Awaited<ReturnType<typeof readPricingScope>>) {
  const state = await getPricingState(db, rfpId, current);
  const requests = await db.select().from(pricingRequests).where(eq(pricingRequests.rfpId, rfpId)).orderBy(desc(pricingRequests.id)).all();
  const messages = await db.select().from(emailMessages).where(eq(emailMessages.rfpId, rfpId)).orderBy(desc(emailMessages.id)).all();
  const threads = requests.map((request) => ({
    request, messages: messages.filter((message) => message.threadKey === threadKey(request.id)),
  }));
  return { ...state, threads };
}
