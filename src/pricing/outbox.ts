import { eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import { outboxJobs, pricingRequests } from "../db/schema";
import { claimJob, finishJob, ownsJobLease, processJob, resetFailedJob, writeSimulatedEmail, type ClaimedJob } from "../workflow/outbox";
import { pricingFrom, responseFrom } from "./contracts";
import { comparePricingScope, latestPricingRequest, pricingReference, readPricingScope, recordPricing, requestBody, threadKey } from "./requests";

export function claimPricingEmail(db: AppDb, jobId?: number, now = new Date()) {
  return claimJob(db, "pricing_email", jobId, now);
}

export function deliverPricingEmail(db: AppDb, job: ClaimedJob, now = new Date()) {
  return db.transaction((tx) => {
    if (job.kind !== "pricing_email" || !ownsJobLease(tx, job)) return;
    if (job.pricingRequestId === null) throw new Error("Pricing request ID is missing.");
    const request = tx.select().from(pricingRequests).where(eq(pricingRequests.id, job.pricingRequestId)).get();
    if (!request) throw new Error("Pricing request is missing.");
    const scope = readPricingScope(tx, job.rfpId);
    const active = latestPricingRequest(tx, job.rfpId);
    if (request.id !== active?.id || scope.blockedReason || comparePricingScope(request.scope, scope.scope).stale) {
      finishJob(tx, job, "canceled", now);
      recordPricing(tx, job.rfpId, "Cancel stale Pricing send", pricingReference(request.id),
        "Routing or the active request changed before delivery.", "Request Pricing for the current offers.", "review_required");
      return;
    }

    writeSimulatedEmail(tx, {
      rfpId: job.rfpId, messageKey: `pricing-outbound:${request.id}`, threadKey: threadKey(request.id),
      direction: "outbound", sender: responseFrom, recipient: pricingFrom, subject: `Rate request · ${pricingReference(request.id)}`,
      body: requestBody(request), recordedAt: now.toISOString(),
    });
    finishJob(tx, job, "complete", now);
    recordPricing(tx, job.rfpId, "Send simulated Pricing email", pricingReference(request.id),
      `Sent ${request.scope.length} ${request.scope.length === 1 ? "lane" : "lanes"} with their offered service scope.`, "Simulate a reply from Pricing.");
  }, { behavior: "immediate" });
}

export function processPricingEmail(db: AppDb, jobId?: number, now = new Date(), deliver = deliverPricingEmail) {
  return processJob(db, "pricing_email", deliver, jobId, now);
}

export function retryPricingEmail(db: AppDb, rfpId: number, requestId: number) {
  return db.transaction((tx) => {
    if (latestPricingRequest(tx, rfpId)?.id !== requestId) return undefined;
    const job = tx.select().from(outboxJobs).where(eq(outboxJobs.pricingRequestId, requestId)).get();
    if (!job || job.status === "complete" || job.status === "canceled") return undefined;
    resetFailedJob(tx, job);
    return job.id;
  }, { behavior: "immediate" });
}
