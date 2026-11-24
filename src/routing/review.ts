import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { demoReviewerId, type AppDb } from "../db/client";
import { getRfp } from "../db/queries";
import { activityEvents, lanes, laneReviews, routingAnalyses } from "../db/schema";
import {
  permittedDispositions, routeLabels, services, type Disposition, type RequirementSource, type Service,
} from "./contracts";
import { createRouteEngine } from "./engine";
import { extractRequirements, extractionMode, validateExtraction, type ExtractionInput } from "./extraction";

type ImportedRfp = NonNullable<Awaited<ReturnType<typeof getRfp>>>;
type LaneReview = typeof laneReviews.$inferSelect;

export class ReviewError extends Error {}

async function record(
  db: Pick<AppDb, "insert">, rfpId: number, stage: string, sourceName: string,
  result: string, nextAction: string, status: typeof activityEvents.$inferInsert.status = "complete",
) {
  await db.insert(activityEvents).values({
    rfpId, stage, sourceName, result, nextAction, status, target: "routing", occurredAt: new Date().toISOString(),
  }).run();
}

export function analysisInput(rfp: ImportedRfp): ExtractionInput {
  const sources: RequirementSource[] = rfp.lanes.flatMap((lane) => lane.shipperNote?.trim() ? [{
    id: `workbook-row-${lane.sourceRow}`, label: `Shipper RFP · row ${lane.sourceRow}`,
    text: lane.shipperNote, laneId: lane.id,
  }] : []);
  const email = rfp.sources.find((source) => source.kind === "shipper_email");
  if (email?.emailText) {
    sources.push({ id: "shipper-email", label: email.name, text: email.emailText, laneId: null });
  }
  return { lanes: rfp.lanes.map(({ id, origin, destination }) => ({ id, origin, destination })), sources };
}

async function findAnalysis(db: Pick<AppDb, "select">, rfpId: number) {
  return db.select().from(routingAnalyses).where(eq(routingAnalyses.rfpId, rfpId)).get();
}

async function reviewsFor(db: Pick<AppDb, "select">, rfpId: number) {
  return (await db.select({ review: laneReviews }).from(laneReviews)
    .innerJoin(lanes, eq(laneReviews.laneId, lanes.id)).where(eq(lanes.rfpId, rfpId)).all())
    .map(({ review }) => review);
}

export async function getRoutingReview(db: Pick<AppDb, "select">, rfp: ImportedRfp) {
  const analysis = await findAnalysis(db, rfp.id);
  const reviews = analysis ? await reviewsFor(db, rfp.id) : [];
  const sourceLabels = new Map(analysisInput(rfp).sources.map(({ id, label }) => [id, label]));
  const pending = rfp.lanes.length - reviews.filter((review) => review.disposition).length;
  const offered = reviews.filter((review) => review.disposition === "offer" || review.disposition === "alternative").length;
  const emailNeedsReview = Boolean(analysis?.issues.length && !analysis.issuesReviewedAt);
  return { analysis, reviews, sourceLabels, pending, offered, emailNeedsReview };
}

export async function analyzeRfp(db: AppDb, rfpId: number, extract = extractRequirements) {
  const rfp = await getRfp(rfpId, db);
  if (!rfp) throw new ReviewError("This RFP could not be found.");
  if (await findAnalysis(db, rfpId)) return;

  const input = analysisInput(rfp);
  const mode = extractionMode();
  let result;
  let extractionFailed = false;
  try {
    result = await extract(input, mode);
  } catch {
    extractionFailed = true;
    result = validateExtraction(input, { claims: [], unmapped: [] });
  }
  const now = new Date().toISOString();
  const engine = createRouteEngine(rfp.flights, rfp.lanes.map((lane) => lane.maxTransitDays));
  const analyzed = rfp.lanes.map((lane) => {
    const extracted = result.lanes.get(lane.id)!;
    const requirements = extracted.issues.length ? null : extracted.services;
    const assessment = requirements === null ? null
      : engine.assess(lane.origin, lane.destination, lane.maxTransitDays, requirements);
    return { laneId: lane.id, extracted, requirements, assessment, updatedAt: now };
  });

  await db.transaction(async (tx) => {
    if (await findAnalysis(tx, rfpId)) return;
    await tx.insert(routingAnalyses).values({ rfpId, mode, issues: result.issues, analyzedAt: now }).run();
    for (let i = 0; i < analyzed.length; i += 100) {
      await tx.insert(laneReviews).values(analyzed.slice(i, i + 100)).run();
    }

    const unresolved = analyzed.filter(({ requirements }) => requirements === null).length;
    const compliant = analyzed.filter(({ assessment }) => assessment?.status === "compliant").length;
    await record(tx, rfpId, "Extract shipper requirements", mode === "fixture" ? "Demo fixture" : "Configured AI",
      extractionFailed ? "Extraction did not complete. Requirements can be entered manually."
        : `${analyzed.length - unresolved} of ${analyzed.length} lanes have interpretable requirements.`,
      unresolved || result.issues.length ? "Review unclear requirements and unmatched email passages."
        : "Inspect the extracted requirements and their evidence.",
      extractionFailed ? "failed" : unresolved || result.issues.length ? "review_required" : "complete");
    await record(tx, rfpId, "Evaluate directed flight paths", rfp.snapshot.sheetName,
      `${compliant} compliant routes. ${analyzed.length - unresolved - compliant} routing exceptions. ${unresolved} awaiting requirements.`,
      "Confirm compliant offers and resolve exceptions.", compliant < analyzed.length ? "review_required" : "complete");
  }, { behavior: "immediate" });
}

async function assertEmailReviewed(db: Pick<AppDb, "select">, rfpId: number) {
  const analysis = await findAnalysis(db, rfpId);
  if (!analysis) throw new ReviewError("Analyze the RFP before reviewing lanes.");
  if (analysis.issues.length && !analysis.issuesReviewedAt) {
    throw new ReviewError("Resolve the unmatched shipper email passages before confirming offers.");
  }
}

export async function reviewUnmatchedEmail(db: AppDb, rfpId: number, note: string) {
  if (!note.trim()) throw new ReviewError("Describe how the unmatched passages were resolved.");
  await db.transaction(async (tx) => {
    const analysis = await findAnalysis(tx, rfpId);
    if (!analysis?.issues.length || analysis.issuesReviewedAt) return;
    await tx.update(routingAnalyses).set({ issuesReviewedAt: new Date().toISOString() })
      .where(eq(routingAnalyses.rfpId, rfpId)).run();
    await record(tx, rfpId, "Review unmatched email", "Demo reviewer", note, "Confirm each lane’s disposition.");
  }, { behavior: "immediate" });
}

async function findReview(db: Pick<AppDb, "select">, rfpId: number, laneId: number, revision: number) {
  const entry = await db.select({ review: laneReviews, lane: lanes }).from(laneReviews)
    .innerJoin(lanes, eq(laneReviews.laneId, lanes.id))
    .where(and(eq(lanes.rfpId, rfpId), eq(lanes.id, laneId))).get();
  if (!entry) throw new ReviewError("This lane could not be found in the analyzed RFP.");
  if (entry.review.revision !== revision) throw new ReviewError("This lane changed. Refresh it before saving.");
  return entry;
}

export async function correctRequirements(db: AppDb, rfpId: number, laneId: number, revision: number, selected: Service[], note: string) {
  if (!note.trim()) throw new ReviewError("Add a reason for the requirement correction.");
  const rfp = await getRfp(rfpId, db);
  if (!rfp) throw new ReviewError("This RFP could not be found.");
  const engine = createRouteEngine(rfp.flights, rfp.lanes.map((lane) => lane.maxTransitDays));

  await db.transaction(async (tx) => {
    const { lane, review } = await findReview(tx, rfpId, laneId, revision);
    const requirements = services.filter((service) => selected.includes(service));
    const assessment = engine.assess(lane.origin, lane.destination, lane.maxTransitDays, requirements);
    await tx.update(laneReviews).set({
      requirements, assessment, disposition: null, dispositionReason: null, reviewerId: demoReviewerId,
      revision: revision + 1, updatedAt: new Date().toISOString(),
    }).where(eq(laneReviews.laneId, laneId)).run();
    await record(tx, rfpId, "Correct lane requirements and reroute", `${lane.origin} → ${lane.destination} · Demo reviewer`,
      `${review.requirements?.join(", ") || (review.requirements ? "General cargo" : "Unconfirmed")} → ${requirements.join(", ") || "General cargo"}. ${note}`,
      `${routeLabels[assessment.status]}. Reconfirm the lane disposition.`, "review_required");
  }, { behavior: "immediate" });
}

const dispositionLabel = {
  offer: "Confirmed compliant offer",
  alternative: "Confirmed alternative with a disclosed gap",
  no_offer: "Confirmed no offer",
} satisfies Record<Disposition, string>;

async function saveDisposition(db: Pick<AppDb, "update">, review: LaneReview, disposition: Disposition, note: string) {
  await db.update(laneReviews).set({
    disposition, dispositionReason: note || null, reviewerId: demoReviewerId,
    revision: review.revision + 1, updatedAt: new Date().toISOString(),
  }).where(eq(laneReviews.laneId, review.laneId)).run();
}

export async function confirmDisposition(db: AppDb, rfpId: number, laneId: number, revision: number, disposition: Disposition, note: string) {
  await db.transaction(async (tx) => {
    const { lane, review } = await findReview(tx, rfpId, laneId, revision);
    if (disposition !== "no_offer") await assertEmailReviewed(tx, rfpId);
    if (!permittedDispositions(review.assessment).includes(disposition)) {
      throw new ReviewError("This disposition is unavailable for the current route and service requirements.");
    }
    if (disposition !== "offer" && !note.trim()) throw new ReviewError("Add a reason for this disposition.");
    await saveDisposition(tx, review, disposition, note);
    const route = disposition === "no_offer" ? null : review.assessment?.path;
    const routeSummary = route ? ` ${route.airports.join(" → ")} in ${route.totalDays} days.` : "";
    const gap = route?.missing.length ? ` Unavailable: ${route.missing.join(", ")}.` : "";
    await record(tx, rfpId, "Confirm lane disposition", `${lane.origin} → ${lane.destination} · Demo reviewer`,
      `${dispositionLabel[disposition]}.${routeSummary}${gap}${note ? ` ${note}` : ""}`, "Review the remaining lanes.");
  }, { behavior: "immediate" });
}

export async function confirmCompliantOffers(db: AppDb, rfpId: number) {
  await db.transaction(async (tx) => {
    await assertEmailReviewed(tx, rfpId);
    const compliant = (await reviewsFor(tx, rfpId)).filter((review) => !review.disposition && review.assessment?.status === "compliant");
    if (!compliant.length) return;
    for (const review of compliant) await saveDisposition(tx, review, "offer", "");
    await record(tx, rfpId, "Confirm compliant offers", "Demo reviewer", `${compliant.length} compliant lanes confirmed as offers.`,
      "Review any remaining lanes before closing routing.");
  }, { behavior: "immediate" });
}

export function pendingDispositionKey(reviews: LaneReview[]) {
  const open = reviews.filter((review) => !review.disposition).toSorted((a, b) => a.laneId - b.laneId);
  return createHash("sha256").update(JSON.stringify(open.map(({ laneId, revision }) => [laneId, revision]))).digest("hex");
}

export async function declinePendingLanes(db: AppDb, rfpId: number, expectedKey: string, note: string) {
  const reason = note.trim();
  if (!reason) throw new ReviewError("Add a reason for marking the remaining lanes as no offer.");

  await db.transaction(async (tx) => {
    const open = (await reviewsFor(tx, rfpId)).filter((review) => !review.disposition);
    if (pendingDispositionKey(open) !== expectedKey) {
      throw new ReviewError("The open lanes changed. Refresh the RFP before applying the bulk disposition.");
    }
    if (!open.length) return;
    for (const review of open) await saveDisposition(tx, review, "no_offer", reason);
    await record(tx, rfpId, "Mark remaining lanes as no offer", "Demo reviewer",
      `${open.length} ${open.length === 1 ? "lane marked" : "lanes marked"} as no offer. ${reason}`,
      "Check routing and Pricing readiness.");
  }, { behavior: "immediate" });
}
