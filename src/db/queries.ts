import { asc, desc, eq } from "drizzle-orm";
import { getDb, type AppDb } from "./client";
import { activityEvents, flightLegs, lanes, reviewers, rfps, sourceFiles, transitSnapshots } from "./schema";

export function listRfps(db = getDb()) {
  return db.select({
    id: rfps.id,
    title: rfps.title,
    importedAt: rfps.importedAt,
    laneCount: db.$count(lanes, eq(lanes.rfpId, rfps.id)),
    flightCount: db.$count(flightLegs, eq(flightLegs.snapshotId, transitSnapshots.id)),
  })
    .from(rfps)
    .innerJoin(transitSnapshots, eq(transitSnapshots.rfpId, rfps.id))
    .orderBy(desc(rfps.id))
    .all();
}

export function recentImportActivity(db = getDb()) {
  return db.select().from(activityEvents)
    .orderBy(desc(activityEvents.id)).limit(5).all();
}

export function getRfp(id: number, db: Pick<AppDb, "select"> = getDb()) {
  const rfp = db.select({
    id: rfps.id, title: rfps.title, importedAt: rfps.importedAt, reviewer: reviewers.name,
  }).from(rfps).innerJoin(reviewers, eq(rfps.reviewerId, reviewers.id)).where(eq(rfps.id, id)).get();
  if (!rfp) return null;

  const snapshot = db.select().from(transitSnapshots).where(eq(transitSnapshots.rfpId, id)).get();
  if (!snapshot) throw new Error("Imported RFP is missing its transit snapshot.");

  return {
    ...rfp,
    snapshot,
    sources: db.select({ name: sourceFiles.name, kind: sourceFiles.kind, emailText: sourceFiles.emailText })
      .from(sourceFiles).where(eq(sourceFiles.rfpId, id)).orderBy(asc(sourceFiles.id)).all(),
    lanes: db.select().from(lanes).where(eq(lanes.rfpId, id)).orderBy(asc(lanes.sourceRow)).all(),
    flights: db.select().from(flightLegs).where(eq(flightLegs.snapshotId, snapshot.id)).orderBy(asc(flightLegs.sourceRow)).all(),
    activity: db.select().from(activityEvents).where(eq(activityEvents.rfpId, id)).orderBy(asc(activityEvents.id)).all(),
  };
}
