import { MemorySaver } from "@langchain/langgraph";
import { eq, lt, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AppDb } from "../db/client";
import type { ModelMode } from "./workflow";

export const labRuns = sqliteTable("lab_v2_runs", {
  id: text().primaryKey(),
  rfpId: integer().notNull(),
  snapshotId: integer().notNull(),
  mode: text({ enum: ["fixture", "openai"] }).$type<ModelMode>().notNull(),
  ambiguous: integer({ mode: "boolean" }).notNull(),
  revision: integer().notNull(),
  checkpoint: text().notNull(),
  extractedAt: integer().notNull(),
  reviewedAt: integer(),
  expiresAt: integer().notNull(),
});

const setup = new WeakMap<AppDb, Promise<unknown>>();

export async function ensureLabStorage(db: AppDb) {
  let ready = setup.get(db);
  if (!ready) {
    // Lab tables are initialized by the lab only, independently of V1 migrations.
    ready = db.run(sql`CREATE TABLE IF NOT EXISTS lab_v2_runs (
      id TEXT PRIMARY KEY NOT NULL, rfpId INTEGER NOT NULL, snapshotId INTEGER NOT NULL,
      mode TEXT NOT NULL, ambiguous INTEGER NOT NULL, revision INTEGER NOT NULL,
      checkpoint TEXT NOT NULL, extractedAt INTEGER NOT NULL, reviewedAt INTEGER,
      expiresAt INTEGER NOT NULL
    )`).catch(error => {
      setup.delete(db);
      throw error;
    });
    setup.set(db, ready);
  }
  await ready;
}

type SavedCheckpoint = { version: 1; storage: MemorySaver["storage"]; writes: MemorySaver["writes"] };

export function serializeCheckpoint(saver: MemorySaver) {
  const data: SavedCheckpoint = { version: 1, storage: saver.storage, writes: saver.writes };
  return JSON.stringify(data, (_, value: unknown) => value instanceof Uint8Array
    ? { bytes: Buffer.from(value).toString("base64") }
    : value);
}

export function restoreCheckpoint(serialized: string) {
  const data = JSON.parse(serialized, (_, value) => value && typeof value === "object" && typeof value.bytes === "string"
    ? new Uint8Array(Buffer.from(value.bytes, "base64"))
    : value) as SavedCheckpoint;
  if (data.version !== 1) throw new Error("Unsupported lab checkpoint version");
  const saver = new MemorySaver();
  saver.storage = data.storage;
  saver.writes = data.writes;
  return saver;
}

export async function insertLabCheckpoint(db: AppDb, run: typeof labRuns.$inferInsert) {
  await ensureLabStorage(db);
  await db.delete(labRuns).where(lt(labRuns.expiresAt, Date.now())).run();
  await db.insert(labRuns).values(run).run();
}

export async function readLabCheckpoint(db: AppDb, id: string) {
  await ensureLabStorage(db);
  return db.select().from(labRuns).where(eq(labRuns.id, id)).get();
}
