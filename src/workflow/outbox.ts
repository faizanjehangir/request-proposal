import { randomUUID } from "node:crypto";
import { and, eq, lte, or } from "drizzle-orm";
import type { AppDb } from "../db/client";
import { activityEvents, emailMessages, outboxJobs } from "../db/schema";

type OutboxJob = typeof outboxJobs.$inferSelect;
export type WorkflowDb = Pick<AppDb, "select" | "insert" | "update">;
export type ClaimedJob = OutboxJob & { leaseToken: string };
type Delivery = (db: AppDb, job: ClaimedJob, now: Date) => void;
const maxSendAttempts = 3;

function recordFailure(db: WorkflowDb, job: OutboxJob, message: string, terminal: boolean) {
  const pricing = job.kind === "pricing_email";
  const kickoff = job.kind === "kickoff";
  const label = pricing ? "Pricing send" : kickoff ? "Kickoff scheduling" : "Customer quote send";
  const action = kickoff ? "Retry kickoff scheduling" : "Retry the simulated send";
  const stage = terminal ? `${label} failed` : kickoff ? "Kickoff failed · Retry queued" : `Schedule ${label.toLowerCase()} retry`;
  db.insert(activityEvents).values({
    rfpId: job.rfpId, stage,
    sourceName: pricing ? `PR-${job.pricingRequestId}` : kickoff ? "Simulated calendar" : "Simulated customer delivery",
    target: pricing ? "pricing" : kickoff ? "closeout" : "quote", status: terminal ? "failed" : "review_required", result: message,
    nextAction: terminal ? `${action}.` : `${action} or let the worker try again.`,
    occurredAt: new Date().toISOString(),
  }).run();
}

export function claimJob(db: AppDb, kind: OutboxJob["kind"], jobId?: number, now = new Date()): ClaimedJob | null {
  return db.transaction((tx) => {
    const current = now.toISOString();
    const job = tx.select().from(outboxJobs).where(and(
      eq(outboxJobs.kind, kind),
      jobId === undefined ? undefined : eq(outboxJobs.id, jobId),
      or(
        and(eq(outboxJobs.status, "pending"), lte(outboxJobs.availableAt, current)),
        and(eq(outboxJobs.status, "running"), lte(outboxJobs.leaseUntil, current)),
      ),
    )).orderBy(outboxJobs.availableAt, outboxJobs.id).limit(1).get();
    if (!job) return null;
    if (job.attempts >= maxSendAttempts) {
      const message = "The worker stopped before confirming the job result.";
      tx.update(outboxJobs).set({ status: "failed", lastError: message, leaseToken: null, leaseUntil: null })
        .where(eq(outboxJobs.id, job.id)).run();
      recordFailure(tx, job, message, true);
      return null;
    }
    const leaseToken = randomUUID();
    const claimed = tx.update(outboxJobs).set({
      status: "running", attempts: job.attempts + 1, leaseToken,
      leaseUntil: new Date(now.getTime() + 30_000).toISOString(),
    }).where(eq(outboxJobs.id, job.id)).returning().get();
    return { ...claimed, leaseToken };
  }, { behavior: "immediate" });
}

export function processJob(db: AppDb, kind: OutboxJob["kind"], deliver: Delivery, jobId?: number, now = new Date()) {
  const job = claimJob(db, kind, jobId, now);
  if (!job) return false;
  try {
    deliver(db, job, now);
  } catch (error) {
    if (!(error instanceof SimulatedDeliveryFailure)) console.error("Outbox job failed", error);
    db.transaction((tx) => {
      const terminal = job.attempts >= maxSendAttempts;
      const message = error instanceof SimulatedDeliveryFailure ? error.message
        : kind === "kickoff" ? "The simulated invitation could not be recorded." : "The simulated email could not be recorded.";
      const result = tx.update(outboxJobs).set({
        status: terminal ? "failed" : "pending", lastError: message, leaseToken: null, leaseUntil: null,
        availableAt: new Date(now.getTime() + 1000 * 2 ** (job.attempts - 1)).toISOString(),
        simulateFailure: false,
      }).where(and(eq(outboxJobs.id, job.id), eq(outboxJobs.leaseToken, job.leaseToken))).run();
      if (result.changes) recordFailure(tx, job, message, terminal);
    }, { behavior: "immediate" });
  }
  return true;
}

export class SimulatedDeliveryFailure extends Error {}

export function ownsJobLease(db: WorkflowDb, job: ClaimedJob) {
  const current = db.select().from(outboxJobs).where(eq(outboxJobs.id, job.id)).get();
  return current?.status === "running" && current.leaseToken === job.leaseToken;
}

export function finishJob(db: WorkflowDb, job: ClaimedJob, status: "complete" | "canceled", now: Date) {
  db.update(outboxJobs).set({ status, leaseToken: null, leaseUntil: null, completedAt: now.toISOString(), lastError: null })
    .where(eq(outboxJobs.id, job.id)).run();
}

export function writeSimulatedEmail(db: WorkflowDb, message: typeof emailMessages.$inferInsert) {
  db.insert(emailMessages).values(message).onConflictDoNothing({ target: emailMessages.messageKey }).run();
}

export function resetFailedJob(db: WorkflowDb, job: OutboxJob) {
  if (job.status === "failed" || (job.status === "pending" && job.lastError)) {
    db.update(outboxJobs).set({
      status: "pending", attempts: job.status === "failed" ? 0 : job.attempts,
      availableAt: new Date().toISOString(), lastError: null, simulateFailure: false,
    }).where(eq(outboxJobs.id, job.id)).run();
  }
}
