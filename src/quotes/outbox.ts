import { eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import { outboxJobs, quoteVersions } from "../db/schema";
import {
  finishJob, ownsJobLease, processJob, resetFailedJob, SimulatedDeliveryFailure, writeSimulatedEmail, type ClaimedJob,
} from "../workflow/outbox";
import { responseFrom } from "../pricing/contracts";
import { quoteThread } from "./contracts";
import { quoteApproval, quoteMessageKey, QuoteError, recordQuote, requireCurrentQuote } from "./quote";

export function requestQuoteDelivery(db: AppDb, rfpId: number, quoteId: number, simulateFailure = false) {
  return db.transaction((tx) => {
    const quote = requireCurrentQuote(tx, rfpId, quoteId);
    if (!quoteApproval(tx, quote.id)) throw new QuoteError("Approve this exact quote version before sending.");
    const existing = tx.select().from(outboxJobs).where(eq(outboxJobs.quoteVersionId, quote.id)).get();
    const now = new Date().toISOString();
    if (existing) {
      if (existing.status === "canceled") {
        tx.update(outboxJobs).set({
          status: "pending", attempts: 0, completedAt: null, availableAt: now, simulateFailure,
        }).where(eq(outboxJobs.id, existing.id)).run();
        recordQuote(tx, rfpId, quote.version, "Requeue approved customer email",
          "The approved terms match the current RFP.", "Check the simulated customer inbox.");
      }
      return existing.id;
    }
    const job = tx.insert(outboxJobs).values({
      rfpId, quoteVersionId: quote.id, kind: "quote_email", status: "pending",
      availableAt: now, createdAt: now, simulateFailure,
    }).returning({ id: outboxJobs.id }).get();
    recordQuote(tx, rfpId, quote.version, "Queue approved customer email", "Queued the approved email for simulated delivery.",
      "Check the simulated customer inbox.");
    return job.id;
  }, { behavior: "immediate" });
}

export function deliverQuoteEmail(db: AppDb, job: ClaimedJob, now = new Date()) {
  db.transaction((tx) => {
    if (job.kind !== "quote_email" || !ownsJobLease(tx, job)) return;
    if (job.quoteVersionId === null) throw new Error("Quote job has no version.");
    const queued = tx.select().from(quoteVersions).where(eq(quoteVersions.id, job.quoteVersionId)).get();
    if (!queued) throw new Error("Queued quote version is missing.");

    try {
      requireCurrentQuote(tx, job.rfpId, queued.id);
      if (!quoteApproval(tx, queued.id)) throw new QuoteError("This quote version has no approval.");
    } catch (error) {
      if (!(error instanceof QuoteError)) throw error;
      finishJob(tx, job, "canceled", now);
      recordQuote(tx, job.rfpId, queued.version, "Cancel stale customer quote send", error.message,
        "Review and approve the current quote version.", "review_required");
      return;
    }

    if (job.simulateFailure) throw new SimulatedDeliveryFailure("Simulated customer mailbox temporarily unavailable.");
    writeSimulatedEmail(tx, {
      rfpId: job.rfpId, messageKey: quoteMessageKey(queued.id), threadKey: quoteThread(job.rfpId),
      direction: "outbound", sender: responseFrom, recipient: queued.recipient,
      subject: queued.subject, body: queued.body, recordedAt: now.toISOString(),
    });
    finishJob(tx, job, "complete", now);
    recordQuote(tx, job.rfpId, queued.version, "Send approved customer quote",
      "The exact approved email was delivered to the simulated customer inbox.", "Open the simulated customer inbox to verify delivery.");
  }, { behavior: "immediate" });
}

export function processQuoteEmail(db: AppDb, jobId?: number, now = new Date()) {
  return processJob(db, "quote_email", deliverQuoteEmail, jobId, now);
}

export function retryQuoteDelivery(db: AppDb, rfpId: number, quoteId: number) {
  return db.transaction((tx) => {
    const quote = requireCurrentQuote(tx, rfpId, quoteId);
    if (!quoteApproval(tx, quote.id)) throw new QuoteError("Approve this exact quote version before retrying.");
    const job = tx.select().from(outboxJobs).where(eq(outboxJobs.quoteVersionId, quote.id)).get();
    if (!job || job.status === "complete" || job.status === "canceled") return undefined;
    resetFailedJob(tx, job);
    return job.id;
  }, { behavior: "immediate" });
}
