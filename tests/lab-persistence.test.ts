import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { openDb } from "../src/db/client";
import { getRfp } from "../src/db/queries";
import { importRfp, sampleWorkbookName } from "../src/intake/import-rfp";
import { getLabRun, resumeLabRun } from "../src/lab/runs";
import { getRoutingReview } from "../src/routing/review";

test("resumes a saved graph in a different process and publishes only one review revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rfp-lab-persistence-"));
  const databasePath = join(directory, "rfp.sqlite");
  const original = await openDb(databasePath);
  try {
    const workbook = new File([new Uint8Array(await readFile(sampleWorkbookName))], sampleWorkbookName);
    const rfpId = await importRfp(original.db, workbook, null, true);
    const rfp = await getRfp(rfpId, original.db);
    assert.ok(rfp);
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "-e", `
      const { openDb } = require("./src/db/client.ts");
      const { getRfp } = require("./src/db/queries.ts");
      const { startLabRun } = require("./src/lab/runs.ts");
      (async () => {
        const connection = await openDb(process.argv[1]);
        try {
          const rfp = await getRfp(Number(process.argv[2]), connection.db);
          console.log(await startLabRun(rfp, true, connection.db));
        } finally {
          connection.close();
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, databasePath, String(rfpId)], { env: { ...process.env, RFP_V2_MODEL_MODE: "fixture" } });

    const id = stdout.trim();
    const paused = await getLabRun(rfp, id, original.db);
    assert.equal(paused?.awaitingReview, true);
    assert.match(paused?.state.issues[0].excerpt ?? "", /which lanes need temperature/);
    assert.equal(await getLabRun({ ...rfp, snapshot: { ...rfp.snapshot, id: rfp.snapshot.id + 1 } }, id, original.db), undefined);

    const form = new FormData();
    form.set("note", "The original requirements are still correct.");
    const second = await openDb(databasePath);
    try {
      const results = await Promise.allSettled([
        resumeLabRun(rfp, id, 0, form, original.db),
        resumeLabRun(rfp, id, 0, form, second.db),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const lost = results.find(result => result.status === "rejected");
      assert.match(String(lost?.reason), /changed|already been reviewed/);

      const reviewed = await getLabRun(rfp, id, second.db);
      assert.equal(reviewed?.revision, 1);
      assert.equal(reviewed?.awaitingReview, false);
      assert.equal(reviewed?.state.routes?.length, 100);
      assert.equal(reviewed?.state.review.note, "The original requirements are still correct.");
      assert.equal((await getRoutingReview(second.db, rfp)).analysis, undefined);
      await assert.rejects(resumeLabRun(rfp, id, 0, form, second.db), /already been reviewed/);
    } finally {
      second.close();
    }
  } finally {
    original.close();
    await rm(directory, { recursive: true, force: true });
  }
});
