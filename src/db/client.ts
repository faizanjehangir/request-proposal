import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

const reviewer = { id: "demo-reviewer", name: "Demo reviewer" };

export function openDb(path = process.env.RFP_DB_PATH ?? ".data/rfp.sqlite") {
  const databasePath = resolve(/* turbopackIgnore: true */ path);
  mkdirSync(/* turbopackIgnore: true */ dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath, { timeout: 5000 });

  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve("drizzle") });
    db.insert(schema.reviewers).values(reviewer).onConflictDoNothing().run();
    return { db, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type AppDb = ReturnType<typeof openDb>["db"];
let instance: { connection: ReturnType<typeof openDb>; migrationStamp?: number } | undefined;

export function getDb() {
  // The dev server can keep this module alive while migration files change on disk.
  // Opening a new connection also refreshes Drizzle's cached column metadata.
  const migrationStamp = process.env.NODE_ENV === "development"
    ? statSync(resolve("drizzle/meta/_journal.json")).mtimeMs
    : undefined;
  if (!instance || instance.migrationStamp !== migrationStamp) {
    instance = { connection: openDb(), migrationStamp };
  }
  return instance.connection.db;
}

export const demoReviewerId = reviewer.id;
