import { asc, desc, eq } from "drizzle-orm";
import { getDb, type AppDb } from "./client";
import { activityEvents, flightLegs, lanes, reviewers, rfps, sourceFiles, transitSnapshots } from "./schema";

export async function listRfps(db?: AppDb) {
  const conn = db ?? await getDb();
  return conn.select({
    id: rfps.id,
    title: rfps.title,
    importedAt: rfps.importedAt,
    laneCount: conn.$count(lanes, eq(lanes.rfpId, rfps.id)),
    flightCount: conn.$count(flightLegs, eq(flightLegs.snapshotId, transitSnapshots.id)),
  })
    .from(rfps)
    .innerJoin(transitSnapshots, eq(transitSnapshots.rfpId, rfps.id))
    .orderBy(desc(rfps.id))
    .all();
}

export async function recentImportActivity(db?: AppDb) {
  const conn = db ?? await getDb();
  return conn.select().from(activityEvents)
    .orderBy(desc(activityEvents.id)).limit(5).all();
}

export async function getRfp(id: number, db?: Pick<AppDb, "select">) {
  const conn = db ?? await getDb();
  const rfp = await conn.select({
    id: rfps.id, title: rfps.title, importedAt: rfps.importedAt, reviewer: reviewers.name,
  }).from(rfps).innerJoin(reviewers, eq(rfps.reviewerId, reviewers.id)).where(eq(rfps.id, id)).get();
  if (!rfp) return null;

  const snapshot = await conn.select().from(transitSnapshots).where(eq(transitSnapshots.rfpId, id)).get();
  if (!snapshot) throw new Error("Imported RFP is missing its transit snapshot.");

  return {
    ...rfp,
    snapshot,
    sources: await conn.select({ name: sourceFiles.name, kind: sourceFiles.kind, emailText: sourceFiles.emailText })
      .from(sourceFiles).where(eq(sourceFiles.rfpId, id)).orderBy(asc(sourceFiles.id)).all(),
    lanes: await conn.select().from(lanes).where(eq(lanes.rfpId, id)).orderBy(asc(lanes.sourceRow)).all(),
    flights: await conn.select().from(flightLegs).where(eq(flightLegs.snapshotId, snapshot.id)).orderBy(asc(flightLegs.sourceRow)).all(),
    activity: await conn.select().from(activityEvents).where(eq(activityEvents.rfpId, id)).orderBy(asc(activityEvents.id)).all(),
  };
}
