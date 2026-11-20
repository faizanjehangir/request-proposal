import { eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import { acceptedProposals, kickoffInvites, outboxJobs, quoteVersions } from "../db/schema";
import { responseFrom } from "../pricing/contracts";
import { quoteReference } from "../quotes/contracts";
import { finishJob, ownsJobLease, processJob, resetFailedJob, SimulatedDeliveryFailure, type ClaimedJob } from "../workflow/outbox";
import { getAcceptedProposal, recordCloseout } from "./proposals";

function nextWeekday(now: Date, timezone: string) {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(local.formatToParts(now).map(({ type, value }) => [type, value]));
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  do {
    day.setUTCDate(day.getUTCDate() + 1);
  } while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
    .formatToParts(day).find((part) => part.type === "timeZoneName")?.value.slice(3) || "+00:00";
  return new Date(`${day.toISOString().slice(0, 10)}T10:00:00${offset}`);
}

export function kickoffSlot(now: Date, timezone = process.env.RFP_KICKOFF_TIMEZONE || "America/Toronto", configured = process.env.RFP_KICKOFF_START) {
  let start: Date;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(now);
    start = configured ? new Date(configured) : nextWeekday(now, timezone);
  } catch {
    throw new SimulatedDeliveryFailure("Set a valid kickoff timezone and start time, then retry.");
  }
  if ((configured && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(configured))
    || !Number.isFinite(start.getTime()) || start <= now) {
    throw new SimulatedDeliveryFailure("Set a future kickoff time with an explicit UTC offset, then retry.");
  }
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60_000).toISOString(), timezone };
}

export async function bookKickoff(db: AppDb, job: ClaimedJob, now = new Date()) {
  await db.transaction(async (tx) => {
    if (job.kind !== "kickoff" || !await ownsJobLease(tx, job)) return;
    if (job.acceptedProposalId === null) throw new Error("Kickoff job has no accepted proposal.");
    const entry = await tx.select({ proposal: acceptedProposals, version: quoteVersions.version }).from(acceptedProposals)
      .innerJoin(quoteVersions, eq(quoteVersions.id, acceptedProposals.quoteVersionId))
      .where(eq(acceptedProposals.id, job.acceptedProposalId)).get();
    if (!entry || entry.proposal.rfpId !== job.rfpId) throw new Error("Kickoff proposal is missing.");

    if (job.simulateFailure) throw new SimulatedDeliveryFailure("Simulated calendar temporarily unavailable.");
    const { proposal, version } = entry;
    const providerId = `CAL-${proposal.id}`;
    await tx.insert(kickoffInvites).values({
      proposalId: proposal.id, providerId, title: `Air freight kickoff · ${quoteReference(job.rfpId, version)}`,
      ...kickoffSlot(now), attendees: [proposal.recipient, responseFrom], bookedAt: now.toISOString(),
    }).onConflictDoNothing({ target: kickoffInvites.proposalId }).run();
    await finishJob(tx, job, "complete", now);
    await recordCloseout(tx, job.rfpId, "Book simulated kickoff", providerId,
      "Saved one simulated invitation for the shipper and RFP Response Team.", "Open the kickoff details.");
  }, { behavior: "immediate" });
}

export async function processKickoff(db: AppDb, jobId?: number, now = new Date()) {
  return processJob(db, "kickoff", bookKickoff, jobId, now);
}

export async function retryKickoff(db: AppDb, rfpId: number) {
  return db.transaction(async (tx) => {
    const proposal = await getAcceptedProposal(tx, rfpId);
    if (!proposal) return undefined;
    const job = await tx.select().from(outboxJobs).where(eq(outboxJobs.acceptedProposalId, proposal.id)).get();
    if (!job || job.status === "complete" || job.status === "canceled") return undefined;
    await resetFailedJob(tx, job);
    return job.id;
  }, { behavior: "immediate" });
}
