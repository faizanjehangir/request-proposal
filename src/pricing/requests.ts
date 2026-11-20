import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { AppDb } from "../db/client";
import { getRfp } from "../db/queries";
import { activityEvents, outboxJobs, pricingRequests } from "../db/schema";
import { getRoutingReview } from "../routing/review";
import type { PricingScope } from "./contracts";
import { serviceDescription } from "./rates";

export type PricingRequest = typeof pricingRequests.$inferSelect;
export type PricingDb = Pick<AppDb, "insert" | "update" | "select">;

export class PricingError extends Error {}

export function threadKey(requestId: number) {
  return `pricing:${requestId}`;
}

export function pricingReference(requestId: number) {
  return `PR-${requestId}`;
}

export function pricingHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function recordPricing(
  db: PricingDb, rfpId: number, stage: string, sourceName: string,
  result: string, nextAction: string, status: typeof activityEvents.$inferInsert.status = "complete",
) {
  await db.insert(activityEvents).values({
    rfpId, stage, sourceName, result, nextAction, status, target: "pricing", occurredAt: new Date().toISOString(),
  }).run();
}

export function pricingScope(
  rfp: NonNullable<Awaited<ReturnType<typeof getRfp>>>,
  routing: Awaited<ReturnType<typeof getRoutingReview>>,
) {
  const reviews = new Map(routing.reviews.map((review) => [review.laneId, review]));
  const scope = rfp.lanes.flatMap((lane): PricingScope[] => {
    const review = reviews.get(lane.id);
    const path = review?.assessment?.path;
    if (!review || !path || !review.requirements || (review.disposition !== "offer" && review.disposition !== "alternative")) return [];
    return [{
      laneId: lane.id, revision: review.revision, origin: lane.origin, destination: lane.destination,
      tons: lane.tons, airports: path.airports, legIds: path.legs.map((leg) => leg.id), transitDays: path.totalDays,
      requested: review.requirements, offered: path.fulfilled, unavailable: path.missing,
    }];
  });
  const scopeHash = pricingHash(JSON.stringify(scope));
  const blockedReason = !routing.analysis ? "Analyze the RFP and confirm an offer to start Pricing."
    : routing.emailNeedsReview ? "Review the unmatched shipper email before requesting Pricing."
      : scope.length ? null
        : routing.pending ? "Confirm at least one offer to request Pricing." : "Routing is complete with no offered lanes to price.";
  return { scope, scopeHash, blockedReason, pending: routing.pending };
}

export function comparePricingScope(requested: PricingScope[], current: PricingScope[]) {
  const currentByLane = new Map(current.map((lane) => [lane.laneId, lane]));
  const requestedIds = new Set(requested.map((lane) => lane.laneId));
  const stale = requested.some((lane) => JSON.stringify(lane) !== JSON.stringify(currentByLane.get(lane.laneId)));
  const additionalOffers = current.filter((lane) => !requestedIds.has(lane.laneId)).length;
  return { stale, additionalOffers };
}

export async function readPricingScope(db: PricingDb, rfpId: number) {
  const rfp = await getRfp(rfpId, db);
  if (!rfp) throw new PricingError("This RFP could not be found.");
  return pricingScope(rfp, await getRoutingReview(db, rfp));
}

export async function latestPricingRequest(db: PricingDb, rfpId: number) {
  return db.select().from(pricingRequests).where(eq(pricingRequests.rfpId, rfpId)).orderBy(desc(pricingRequests.id)).get();
}

export async function requestPricing(db: AppDb, rfpId: number, previousId: number | null) {
  return db.transaction(async (tx) => {
    const { scope, scopeHash, blockedReason } = await readPricingScope(tx, rfpId);
    if (blockedReason) throw new PricingError(blockedReason);
    const latest = await latestPricingRequest(tx, rfpId);
    if ((latest?.id ?? null) !== previousId) return null;

    if (latest?.scopeHash === scopeHash) {
      const existing = await tx.select().from(outboxJobs).where(eq(outboxJobs.pricingRequestId, latest.id)).get();
      if (existing?.status === "pending" || existing?.status === "running") return existing.id;
    }

    const now = new Date().toISOString();
    const request = await tx.insert(pricingRequests).values({ rfpId, scope, scopeHash, createdAt: now }).returning({ id: pricingRequests.id }).get();
    const job = await tx.insert(outboxJobs).values({
      rfpId, pricingRequestId: request.id, kind: "pricing_email", status: "pending", availableAt: now, createdAt: now,
    }).returning({ id: outboxJobs.id }).get();
    await recordPricing(tx, rfpId, "Queue Pricing request", pricingReference(request.id),
      `${scope.length} offered ${scope.length === 1 ? "lane" : "lanes"} queued for simulated delivery.`, "Wait for the Pricing email to be recorded.");
    return job.id;
  }, { behavior: "immediate" });
}

export function requestBody(request: PricingRequest) {
  const lines = request.scope.map((lane) => {
    const gap = lane.unavailable.length ? ` · Excluded: ${lane.unavailable.join(", ")}` : "";
    return `${lane.origin} → ${lane.destination} · ${lane.tons} tons · Route: ${lane.airports.join(" → ")} (${lane.transitDays} days) · Requested: ${serviceDescription(lane.requested)} · Offer to price: ${serviceDescription(lane.offered)}${gap}`;
  });
  return [
    "Hi Pricing team,", "",
    `Please recommend a USD per ton rate for each offered lane in ${pricingReference(request.id)}. Price the route, tonnage, and services shown below.`,
    "", ...lines, "", "Thanks,", "RFP Response Team",
  ].join("\n");
}
