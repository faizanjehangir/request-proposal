import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { and, desc, eq, gt } from "drizzle-orm";
import { getDb, type AppDb } from "../db/client";
import type { getRfp } from "../db/queries";
import { analysisInput } from "../routing/review";
import { serviceSchema } from "../routing/contracts";
import { ensureLabStorage, insertLabCheckpoint, labRuns, readLabCheckpoint, restoreCheckpoint, serializeCheckpoint } from "./checkpoints";
import { createLabWorkflow, type ModelMode, type Review } from "./workflow";

export type LabRfp = NonNullable<Awaited<ReturnType<typeof getRfp>>>;
const ttl = 60 * 60 * 1000;

export class LabError extends Error {}

export function labMode(): ModelMode {
  return process.env.RFP_V2_MODEL_MODE === "openai" ? "openai" : "fixture";
}

function workflowFor(rfp: LabRfp, mode: ModelMode, ambiguous: boolean, saver: MemorySaver) {
  const input = analysisInput(rfp);
  if (ambiguous) input.sources.push({
    id: "lab-clarification-example", label: "Simulated clarification", laneId: null,
    text: "Please confirm which lanes need temperature controlled handling at 2 to 8 C.",
  });
  return createLabWorkflow(input, rfp.lanes, rfp.flights, mode, undefined, saver);
}

export async function startLabRun(rfp: LabRfp, simulateAmbiguity: boolean, db?: AppDb) {
  const mode = labMode();
  const ambiguous = simulateAmbiguity && mode === "fixture";
  const saver = new MemorySaver();
  const id = randomUUID();
  await workflowFor(rfp, mode, ambiguous, saver).start(id);
  const extractedAt = Date.now();
  await insertLabCheckpoint(db ?? await getDb(), {
    id, rfpId: rfp.id, snapshotId: rfp.snapshot.id, mode, ambiguous,
    revision: 0, checkpoint: serializeCheckpoint(saver), extractedAt, expiresAt: extractedAt + ttl,
  });
  return id;
}

async function findRun(db: AppDb, rfp: LabRfp, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const row = await readLabCheckpoint(db, id);
  if (!row || row.rfpId !== rfp.id || row.snapshotId !== rfp.snapshot.id || row.expiresAt <= Date.now()) return undefined;
  const saver = restoreCheckpoint(row.checkpoint);
  const workflow = workflowFor(rfp, row.mode, row.ambiguous, saver);
  return { row, saver, workflow, snapshot: await workflow.read(id) };
}

export async function getLabRun(rfp: LabRfp, id: string, db?: AppDb) {
  const run = await findRun(db ?? await getDb(), rfp, id);
  if (!run) return undefined;
  const { row, snapshot } = run;
  return {
    mode: row.mode, revision: row.revision, extractedAt: row.extractedAt, reviewedAt: row.reviewedAt,
    state: snapshot.values, awaitingReview: snapshot.next.includes("reviewRequirements"),
  };
}

export async function recentLabRuns(rfp: LabRfp) {
  const db = await getDb();
  await ensureLabStorage(db);
  return db.select({ id: labRuns.id, mode: labRuns.mode, extractedAt: labRuns.extractedAt, reviewedAt: labRuns.reviewedAt })
    .from(labRuns).where(and(eq(labRuns.rfpId, rfp.id), eq(labRuns.snapshotId, rfp.snapshot.id), gt(labRuns.expiresAt, Date.now())))
    .orderBy(desc(labRuns.extractedAt)).limit(5).all();
}

export async function resumeLabRun(rfp: LabRfp, id: string, revision: number, form: FormData, db?: AppDb) {
  const connection = db ?? await getDb();
  const run = await findRun(connection, rfp, id);
  if (!run) throw new LabError("This lab run has expired or is unavailable. Start a new analysis.");
  if (run.row.revision !== revision || !run.snapshot.next.includes("reviewRequirements")) {
    throw new LabError("This run has already been reviewed. Refresh to see the latest results.");
  }

  const { snapshot, saver, workflow } = run;
  const note = String(form.get("note") ?? "").trim();
  const unresolved = snapshot.values.lanes.filter(lane => lane.extracted.issues.length);
  const confirmed = snapshot.values.lanes.filter(lane => form.get(`confirmed-${lane.id}`) === "yes");
  if ((snapshot.values.issues.length || unresolved.length || confirmed.length) && !note) {
    throw new LabError("Describe how you resolved the flagged requirements.");
  }
  if (note.length > 2000) throw new LabError("Keep your review note under 2,000 characters.");
  if (unresolved.some(({ id }) => form.get(`confirmed-${id}`) !== "yes")) {
    throw new LabError("Confirm a service selection for each flagged lane.");
  }
  const corrections: Review["corrections"] = confirmed.map(({ id }) => {
    const selected = form.getAll(`services-${id}`).map(value => serviceSchema.safeParse(value));
    if (selected.some(result => !result.success)) throw new LabError("Choose only services listed in the lab.");
    return { laneId: id, services: [...new Set(selected.flatMap(result => result.success ? [result.data] : []))] };
  });

  await workflow.resume(id, { note, corrections });
  // Resolve from a private checkpoint copy. Only one request can publish a given revision.
  const now = Date.now();
  const updated = await connection.update(labRuns).set({
    checkpoint: serializeCheckpoint(saver), revision: revision + 1, reviewedAt: now,
  }).where(and(eq(labRuns.id, id), eq(labRuns.rfpId, rfp.id), eq(labRuns.revision, revision), gt(labRuns.expiresAt, now))).run();
  if (!Number(updated.rowsAffected)) throw new LabError("The run changed or expired. Refresh to see the latest results.");
}
