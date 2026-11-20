import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getDb, type AppDb } from "../src/db/client";

test("applies a newly available migration without restarting the development process", async () => {
  const workspace = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "rfp-dev-migration-"));
  const previousEnvironment = { NODE_ENV: process.env.NODE_ENV, RFP_DB_PATH: process.env.RFP_DB_PATH };
  let before: AppDb | undefined;
  let after: AppDb | undefined;

  try {
    const migrations = join(directory, "drizzle");
    await cp(join(workspace, "drizzle"), migrations, { recursive: true });
    const journalPath = join(migrations, "meta", "_journal.json");
    const journal: { entries: { tag: string }[] } = JSON.parse(await readFile(journalPath, "utf8"));
    const phase5 = journal.entries.findIndex((entry) => entry.tag.endsWith("_phase5_closeout"));
    assert.ok(phase5 > 0);
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, phase5) }));
    await utimes(journalPath, 1000, 1000);

    process.chdir(directory);
    Object.assign(process.env, { NODE_ENV: "development", RFP_DB_PATH: join(directory, "rfp.sqlite") });
    before = await getDb();
    const hasAcceptedProposalColumn = async (db: AppDb) => (await db.$client.execute({
      sql: "select 1 from pragma_table_info('outbox_jobs') where name = ?",
      args: ["acceptedProposalId"],
    })).rows[0];
    assert.equal(await hasAcceptedProposalColumn(before!), undefined);

    await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, phase5 + 1) }));
    await utimes(journalPath, 2000, 2000);
    after = await getDb();
    assert.notEqual(after, before);
    assert.ok(await hasAcceptedProposalColumn(after!));
  } finally {
    if (after && after !== before) after.$client.close();
    before?.$client.close();
    process.chdir(workspace);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
