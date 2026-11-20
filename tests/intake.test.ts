import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { openDb } from "../src/db/client";
import { getRfp, listRfps, recentImportActivity } from "../src/db/queries";
import { flightLegs, lanes, rfps, sourceFiles, transitSnapshots } from "../src/db/schema";
import { importRfp, recordImportFailure, sampleWorkbookName } from "../src/intake/import-rfp";
import { InvalidImport } from "../src/intake/workbook";

const sampleData = readFileSync(sampleWorkbookName);
const sampleFile = () => new File([new Uint8Array(sampleData)], sampleWorkbookName);

async function tempDb(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "rfp-intake-"));
  const path = join(directory, "rfp.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path;
}

test("imports the original workbook and optional email, then reopens the saved RFP", async (t) => {
  const path = await tempDb(t);
  const emailText = "Please include fragile handling for GRU to SIN.\nThank you.\n";
  const first = await openDb(path);
  let rfpId: number;
  try {
    const email = new File([emailText], "shipper.txt", { type: "text/plain" });
    rfpId = await importRfp(first.db, sampleFile(), email, true);
  } finally {
    first.close();
  }

  const reopened = await openDb(path);
  try {
    const rows = await listRfps(reopened.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].laneCount, 100);
    assert.equal(rows[0].flightCount, 100);

    const rfp = await getRfp(rfpId, reopened.db);
    assert.ok(rfp);
    assert.equal(rfp.reviewer, "Demo reviewer");
    assert.equal(rfp.snapshot.sheetName, "Transit Table");
    assert.equal(rfp.lanes[0].sourceRow, 2);
    assert.equal(rfp.lanes[0].tons, "46.1");
    assert.match(rfp.lanes[1].shipperNote ?? "", /dangerous-goods handling/);
    assert.deepEqual(rfp.flights.find((leg) => leg.sourceRow === 46)?.services,
      ["Dangerous goods", "High-value security", "Oversized cargo"]);
    assert.equal(rfp.sources.find((source) => source.kind === "shipper_email")?.emailText, emailText);
    assert.equal((await reopened.db.select().from(sourceFiles).all())[0].content.compare(sampleData), 0);
    assert.deepEqual(rfp.activity.map((event) => event.target), ["sources", "lanes", "transit"]);
  } finally {
    reopened.close();
  }
});

test("rejects duplicate lanes and invalid values with workbook row references", async (t) => {
  const path = await tempDb(t);
  const connection = await openDb(path);
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Shipper RFP").addRows([
      ["Origin (airport)", "Destination (airport)", "Tons of freight", "Maximum transit time (days)"],
      ["FAI", "SIN", 4.5, 10],
      ["fai", "SIN", 2, 6],
      [],
      ["MEX", "CDG", -2, 7],
    ]);
    workbook.addWorksheet("Transit Table").addRows([
      ["Origin (airport)", "Destination (airport)", "Transit time (days)", "Available special requirements"],
      ["MEX", "CDG", 7, ""],
    ]);
    const bytes = await workbook.xlsx.writeBuffer();
    const invalid = new File([new Uint8Array(Buffer.from(bytes))], "invalid.xlsx");

    let captured: InvalidImport | undefined;
    await assert.rejects(importRfp(connection.db, invalid, null), (error) => {
      assert.ok(error instanceof InvalidImport);
      assert.deepEqual(error.issues.map(({ source, row }) => [source, row]), [["Shipper RFP", 3], ["Shipper RFP", 5]]);
      assert.match(error.issues[0].message, /already appears on row 2/);
      assert.equal(error.issues[1].field, "Tons of freight");
      captured = error;
      return true;
    });
    await recordImportFailure(connection.db, invalid.name, captured!);
    assert.equal(await connection.db.$count(rfps), 0);
    assert.equal(await connection.db.$count(lanes), 0);
    assert.equal(await connection.db.$count(sourceFiles), 0);
    assert.equal(await connection.db.$count(transitSnapshots), 0);
    assert.equal(await connection.db.$count(flightLegs), 0);
    assert.equal((await recentImportActivity(connection.db))[0]?.status, "failed");
  } finally {
    connection.close();
  }
});

test("rolls back an RFP if storing a flight leg fails after earlier inserts", async (t) => {
  const path = await tempDb(t);
  const connection = await openDb(path);
  try {
    await connection.db.run(sql`
      CREATE TRIGGER reject_test_flight BEFORE INSERT ON flight_legs
      WHEN new.sourceRow = 20
      BEGIN SELECT RAISE(ABORT, 'test insert failure'); END
    `);
    await assert.rejects(importRfp(connection.db, sampleFile(), null));
    assert.equal(await connection.db.$count(rfps), 0);
    assert.equal(await connection.db.$count(lanes), 0);
    assert.equal(await connection.db.$count(sourceFiles), 0);
    assert.equal(await connection.db.$count(transitSnapshots), 0);
    assert.equal(await connection.db.$count(flightLegs), 0);
    assert.equal((await recentImportActivity(connection.db)).length, 0);
  } finally {
    connection.close();
  }
});
