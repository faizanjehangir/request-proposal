import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

const reviewer = { id: "demo-reviewer", name: "Demo reviewer" };

export async function openDb(path = process.env.RFP_DB_PATH ?? ".data/rfp.sqlite") {
  // Hosted SQLite (Turso) when configured; otherwise a local file for development.
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const client = tursoUrl
    ? createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN })
    : createClient({
        url: `file:${(() => {
          const databasePath = resolve(/* turbopackIgnore: true */ path);
          mkdirSync(/* turbopackIgnore: true */ dirname(databasePath), { recursive: true });
          return databasePath;
        })()}`,
      });

  try {
    if (!tursoUrl) {
      await client.execute("PRAGMA busy_timeout = 5000");
      await client.execute("PRAGMA journal_mode = WAL");
    }
    await client.execute("PRAGMA foreign_keys = ON");
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: resolve("drizzle") });
    await db.insert(schema.reviewers).values(reviewer).onConflictDoNothing().run();
    return { db, close: () => client.close() };
  } catch (error) {
    client.close();
    throw error;
  }
}

export type AppDb = Awaited<ReturnType<typeof openDb>>["db"];
let instance: { connection: ReturnType<typeof openDb>; migrationStamp?: number } | undefined;

export async function getDb() {
  // The dev server can keep this module alive while migration files change on disk.
  // Opening a new connection also refreshes Drizzle's cached column metadata.
  const migrationStamp = process.env.NODE_ENV === "development"
    ? statSync(resolve("drizzle/meta/_journal.json")).mtimeMs
    : undefined;
  if (!instance || instance.migrationStamp !== migrationStamp) {
    instance = { connection: openDb(), migrationStamp };
  }
  return (await instance.connection).db;
}

export const demoReviewerId = reviewer.id;
