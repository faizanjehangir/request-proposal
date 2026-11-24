import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { demoReviewerId, getDb, openDb, type AppDb } from "../db/client";
import { getRfp } from "../db/queries";
import { flightLegs, lanes, laneReviews, rfps, routingAnalyses, sourceFiles, transitSnapshots } from "../db/schema";
import type { AssessedPath } from "../routing/contracts";
import { labEnabled } from "./config";
import { getLabRun, LabError } from "./runs";
import type { ModelMode } from "./workflow";

import type { LabTarget } from "./commercial-target";

const commercialRuns = sqliteTable("lab_commercial_runs", {
  runId: text().primaryKey(),
  sourceId: integer().notNull(),
  rfpId: integer().notNull().unique(),
  mode: text({ enum: ["fixture", "openai"] }).$type<ModelMode>().notNull(),
});

let connection: Promise<AppDb> | undefined;

function commercialDb() {
  if (!connection) connection = (async () => {
    const url = process.env.RFP_V2_DATABASE_URL;
    const originalUrl = process.env.TURSO_DATABASE_URL;
    if ((originalUrl || process.env.VERCEL === "1") && !url) {
      throw new LabError("Configure a separate RFP_V2_DATABASE_URL to enable hosted lab proposals.");
    }
    if (url && (!["libsql:", "https:"].includes(new URL(url).protocol)
      || (originalUrl && new URL(url).hostname === new URL(originalUrl).hostname))) {
      throw new LabError("The AI Lab requires its own remote database, separate from the original workflow.");
    }

    const opened = await openDb(`${process.env.RFP_DB_PATH ?? ".data/rfp.sqlite"}.lab.sqlite`, {
      url, authToken: process.env.RFP_V2_DATABASE_AUTH_TOKEN,
    });
    try {
      await opened.db.run(sql`CREATE TABLE IF NOT EXISTS lab_commercial_runs (
        runId TEXT PRIMARY KEY NOT NULL, sourceId INTEGER NOT NULL,
        rfpId INTEGER NOT NULL UNIQUE REFERENCES rfps(id), mode TEXT NOT NULL
      )`);
      return opened.db;
    } catch (error) {
      opened.close();
      throw error;
    }
  })().catch(error => {
    connection = undefined;
    throw error;
  });
  return connection;
}

function checkTarget(target: LabTarget) {
  if (!labEnabled() || !/^[0-9a-f-]{36}$/i.test(target.runId)) throw new LabError("This lab proposal is unavailable.");
}

export async function getLabCommercial(target: LabTarget) {
  checkTarget(target);
  const db = await commercialDb();
  const row = await db.select().from(commercialRuns).where(eq(commercialRuns.runId, target.runId)).get();
  if (!row || row.sourceId !== target.sourceId) return undefined;
  return { db, rfpId: row.rfpId, mode: row.mode };
}

export async function startLabCommercial(target: LabTarget) {
  const existing = await getLabCommercial(target);
  if (existing) return;
  const source = await getRfp(target.sourceId);
  const run = source && await getLabRun(source, target.runId);
  if (!source || !run?.state.routes || run.awaitingReview) throw new LabError("Finish the lab route review before starting a proposal.");

  const routes = new Map(run.state.routes.map(route => [route.id, route]));
  const extracted = new Map(run.state.lanes.map(lane => [lane.id, lane.extracted]));
  if (source.lanes.some(lane => !routes.has(lane.id) || !extracted.has(lane.id))) {
    throw new LabError("The saved review does not cover every imported lane.");
  }
  const primary = await getDb();
  const inputs = await primary.select().from(sourceFiles).where(eq(sourceFiles.rfpId, source.id)).all();
  const db = await commercialDb();

  await db.transaction(async tx => {
    const duplicate = await tx.select().from(commercialRuns).where(eq(commercialRuns.runId, target.runId)).get();
    if (duplicate) {
      if (duplicate.sourceId !== source.id) throw new LabError("This lab run belongs to a different request.");
      return;
    }
    const { id: rfpId } = await tx.insert(rfps).values({
      title: source.title, reviewerId: demoReviewerId, importedAt: source.importedAt,
    }).returning({ id: rfps.id }).get();
    const savedSources = await tx.insert(sourceFiles).values(inputs.map(({ id: _id, rfpId: _rfpId, ...file }) => ({
      ...file, rfpId,
    }))).returning({ id: sourceFiles.id, kind: sourceFiles.kind }).all();
    const workbook = savedSources.find(file => file.kind === "workbook");
    if (!workbook) throw new LabError("The original workbook is missing.");
    const { id: snapshotId } = await tx.insert(transitSnapshots).values({
      rfpId, sourceFileId: workbook.id, sheetName: source.snapshot.sheetName,
    }).returning({ id: transitSnapshots.id }).get();

    const flightIds = new Map<number, number>();
    for (let i = 0; i < source.flights.length; i += 100) {
      const copied = await tx.insert(flightLegs).values(source.flights.slice(i, i + 100).map(({ id: _id, snapshotId: _snapshotId, ...leg }) => ({
        ...leg, snapshotId,
      }))).returning({ id: flightLegs.id, sourceRow: flightLegs.sourceRow }).all();
      for (const leg of copied) flightIds.set(leg.sourceRow, leg.id);
    }
    function copyPath(path: AssessedPath | null): AssessedPath | null {
      if (!path) return null;
      return { ...path, legs: path.legs.map(leg => {
        const id = flightIds.get(leg.sourceRow);
        if (!id) throw new LabError("A reviewed flight leg is missing from the snapshot.");
        return { ...leg, id };
      }) };
    }

    const importedByRow = new Map(source.lanes.map(lane => [lane.sourceRow, lane.id]));
    const reviewedAt = new Date(run.reviewedAt ?? run.extractedAt).toISOString();
    await tx.insert(routingAnalyses).values({
      rfpId, mode: run.mode, issues: run.state.issues, issuesReviewedAt: reviewedAt,
      analyzedAt: new Date(run.extractedAt).toISOString(),
    }).run();

    for (let i = 0; i < source.lanes.length; i += 100) {
      const copied = await tx.insert(lanes).values(source.lanes.slice(i, i + 100).map(({ id: _id, rfpId: _rfpId, ...lane }) => ({
        ...lane, rfpId,
      }))).returning({ id: lanes.id, sourceRow: lanes.sourceRow }).all();
      await tx.insert(laneReviews).values(copied.map(lane => {
        const original = importedByRow.get(lane.sourceRow)!;
        const { assessment, requirements } = routes.get(original)!;
        return {
          laneId: lane.id, requirements, extracted: extracted.get(original)!,
          assessment: { ...assessment, path: copyPath(assessment.path), fullServicePath: copyPath(assessment.fullServicePath) },
          updatedAt: reviewedAt,
        };
      })).run();
    }
    await tx.insert(commercialRuns).values({ ...target, rfpId, mode: run.mode }).run();
  }, { behavior: "immediate" });
}
