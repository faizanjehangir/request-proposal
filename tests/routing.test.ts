import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDb } from "../src/db/client";
import { getRfp } from "../src/db/queries";
import { importRfp, sampleWorkbookName } from "../src/intake/import-rfp";
import { permittedDispositions, type Service } from "../src/routing/contracts";
import { createRouteEngine } from "../src/routing/engine";
import { extractOpenAi, extractRequirements, validateExtraction, type ExtractionInput } from "../src/routing/extraction";
import { analyzeRfp, confirmCompliantOffers, confirmDisposition, correctRequirements, declinePendingLanes, getRoutingReview, pendingDispositionKey, reviewUnmatchedEmail } from "../src/routing/review";

const dangerous = "Dangerous goods";
const fragile = "Fragile handling";

function leg(id: number, origin: string, destination: string, transitDays: string, services: Service[] = []) {
  return { id, sourceRow: id + 1, origin, destination, transitDays, services };
}

test("routing uses exact decimal limits, directions, and a stable tie break", () => {
  const engine = createRouteEngine([
    leg(10, "AAA", "BBB", "0.1", [dangerous]),
    leg(11, "BBB", "CCC", "0.2", [dangerous]),
    leg(12, "BBB", "AAA", "0.1", [dangerous]),
    leg(6, "AAA", "CCC", "0.3", [dangerous]),
    leg(3, "AAA", "CCC", "0.3", [dangerous]),
    leg(7, "AAA", "DDD", "0.1", [dangerous]),
    leg(8, "DDD", "EEE", "0.2", [dangerous]),
  ], ["0.3"]);
  const tied = engine.assess("AAA", "CCC", "0.3", [dangerous]);
  assert.equal(tied.status, "compliant");
  assert.deepEqual(tied.path?.legs.map((flight) => flight.id), [3]);
  assert.equal(engine.assess("AAA", "EEE", "0.3", [dangerous]).status, "compliant");
  assert.equal(engine.assess("CCC", "AAA", "0.3", []).status, "unreachable");
});

test("routing prioritizes end-to-end service coverage among time-feasible alternatives", () => {
  const engine = createRouteEngine([
    leg(1, "AAA", "CCC", "1"),
    leg(2, "AAA", "BBB", "1", [fragile, dangerous]),
    leg(3, "BBB", "CCC", "2", [dangerous]),
    leg(4, "AAA", "CCC", "6", [fragile, dangerous]),
  ], ["3", "0.5"]);
  const assessment = engine.assess("AAA", "CCC", "3", [dangerous, fragile]);
  assert.equal(assessment.status, "service_gap");
  assert.deepEqual(assessment.path?.airports, ["AAA", "BBB", "CCC"]);
  assert.deepEqual(assessment.path?.fulfilled, [dangerous]);
  assert.deepEqual(assessment.path?.legs.map((flight) => flight.missing), [[], [fragile]]);
  assert.equal(assessment.fullServicePath?.totalDays, "6");
  assert.equal(engine.assess("AAA", "CCC", "0.5", [dangerous]).status, "over_limit");
  assert.deepEqual(permittedDispositions(engine.assess("AAA", "CCC", "1", [dangerous])), ["no_offer"]);
});

test("fixture extraction keeps lane evidence and flags ambiguity, unknown wording, and absent requirements", async () => {
  const input: ExtractionInput = {
    lanes: [
      { id: 1, origin: "MEX", destination: "CDG" },
      { id: 2, origin: "GRU", destination: "SIN" },
      { id: 3, origin: "DFW", destination: "MEX" },
      { id: 4, origin: "FAI", destination: "SIN" },
    ],
    sources: [
      { id: "workbook-row-2", label: "Row 2", laneId: 1, text: "MEX to CDG is standard general cargo." },
      { id: "email", label: "Shipper email", laneId: null, text: "MEX to CDG requires dangerous goods.\nGRU to SIN needs fragile handling.\nDFW to MEX needs secure handling and weekend delivery.\nPlease confirm dry ice." },
    ],
  };
  const result = await extractRequirements(input, "fixture");
  assert.match(result.lanes.get(1)?.issues[0].message ?? "", /conflicts/);
  assert.deepEqual(result.lanes.get(2)?.services, [fragile]);
  assert.equal(result.lanes.get(2)?.evidence[0].excerpt, "GRU to SIN needs fragile handling.");
  assert.match(result.lanes.get(3)?.issues[0].message ?? "", /unsupported/);
  assert.match(result.lanes.get(4)?.issues[0].message ?? "", /Confirm which services/);
  assert.equal(result.issues[0].excerpt, "Please confirm dry ice.");
  assert.throws(() => validateExtraction(input, {
    claims: [{ laneId: 2, sourceId: "workbook-row-2", excerpt: "standard general cargo", kind: "general_cargo", service: null, issue: null }],
    unmapped: [],
  }), /unrelated lane/);
  assert.throws(() => validateExtraction(input, {
    claims: [{ laneId: 2, sourceId: "email", excerpt: "A fabricated quote", kind: "general_cargo", service: null, issue: null }],
    unmapped: [],
  }), /outside the import/);
});

test("configured AI adapter reads structured response data and surfaces refusal and timeout", async () => {
  const input = { lanes: [], sources: [] };
  const mock: typeof fetch = async (url, config) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(config?.body));
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.store, false);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"claims":[],"unmapped":[]}' }] }] });
  };
  const config = { key: "fake-key", model: "fake-model" };
  assert.deepEqual(await extractOpenAi(input, config, mock), { claims: [], unmapped: [] });
  await assert.rejects(extractOpenAi(input, config, async () => Response.json({
    status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }],
  })), /declined/);
  await assert.rejects(extractOpenAi(input, config, async () => { throw new DOMException("Timed out", "TimeoutError"); }), /Timed out/);
});

async function importSample(t: TestContext, email: File | null = null) {
  const directory = await mkdtemp(join(tmpdir(), "rfp-routing-"));
  const connection = await openDb(join(directory, "rfp.sqlite"));
  t.after(async () => { connection.close(); await rm(directory, { recursive: true, force: true }); });
  const file = new File([new Uint8Array(readFileSync(sampleWorkbookName))], sampleWorkbookName);
  const rfpId = await importRfp(connection.db, file, email);
  const read = async () => {
    const rfp = await getRfp(rfpId, connection.db);
    assert.ok(rfp);
    return { ...await getRoutingReview(connection.db, rfp), rfp };
  };
  return { db: connection.db, rfpId, read };
}

test("analyzes an existing import and persists rerouting, stale-write protection and final dispositions", async (t) => {
  const { db, rfpId, read } = await importSample(t);
  assert.equal((await read()).analysis, undefined);
  await analyzeRfp(db, rfpId, (input) => extractRequirements(input, "fixture"));
  const workspace = await read();
  assert.equal(workspace.reviews.length, 100);
  assert.equal(workspace.reviews.filter((review) => review.assessment?.status === "compliant").length, 45);
  async function lane(origin: string, destination: string) {
    const item = workspace.rfp.lanes.find((lane) => lane.origin === origin && lane.destination === destination);
    const review = (await read()).reviews.find((review) => review.laneId === item?.id);
    assert.ok(review);
    return review;
  }
  const mex = await lane("MEX", "CDG");
  assert.deepEqual(mex.assessment?.path?.airports, ["MEX", "CDG"]);
  assert.equal(mex.assessment?.path?.totalDays, "11");
  assert.deepEqual(mex.requirements, [dangerous]);
  const gru = await lane("GRU", "SIN");
  assert.equal(gru.assessment?.path?.totalDays, "4");
  assert.equal(gru.assessment?.fullServicePath?.totalDays, "11");
  assert.deepEqual(gru.assessment?.path?.legs[0].missing, [fragile]);
  const fai = await lane("FAI", "SIN");
  assert.equal(fai.assessment?.status, "unreachable");
  await assert.rejects(confirmDisposition(db, rfpId, fai.laneId, fai.revision, "offer", ""), /unavailable/);

  await confirmCompliantOffers(db, rfpId);
  await confirmDisposition(db, rfpId, gru.laneId, gru.revision, "alternative", "Disclose the fragile-handling gap.");
  assert.equal((await lane("GRU", "SIN")).disposition, "alternative");
  await assert.rejects(confirmDisposition(db, rfpId, gru.laneId, gru.revision, "no_offer", "Stale"), /changed/);

  await correctRequirements(db, rfpId, gru.laneId, (await lane("GRU", "SIN")).revision, [], "Shipper confirmed general cargo.");
  assert.equal((await lane("GRU", "SIN")).assessment?.status, "compliant");
  assert.equal((await lane("GRU", "SIN")).disposition, null);
  await confirmCompliantOffers(db, rfpId);
  assert.equal((await read()).offered, 46);
  await analyzeRfp(db, rfpId);
  assert.equal((await read()).offered, 46);

  const beforeBulk = await read();
  const oldKey = pendingDispositionKey(beforeBulk.reviews);
  await confirmDisposition(db, rfpId, fai.laneId, fai.revision, "no_offer", "No directed route.");
  await assert.rejects(declinePendingLanes(db, rfpId, oldKey, "Bulk review"), /open lanes changed/);
  const key = pendingDispositionKey((await read()).reviews);
  await assert.rejects(declinePendingLanes(db, rfpId, key, " "), /Add a reason/);
  await declinePendingLanes(db, rfpId, key, "Unable to meet requested terms.");
  assert.equal((await read()).pending, 0);
  assert.equal((await read()).offered, 46);
  assert.equal((await lane("FAI", "SIN")).dispositionReason, "No directed route.");
  assert.ok((await read()).rfp.activity.some((event) => event.stage === "Mark remaining lanes as no offer"));
  assert.ok((await read()).rfp.activity.some((event) => event.stage === "Correct lane requirements and reroute"));
});

test("failed extraction produces manual review and holds offers until unmatched email is resolved", async (t) => {
  const email = new File(["Extra details pending"], "shipper.txt");
  const { db, rfpId, read } = await importSample(t, email);
  await analyzeRfp(db, rfpId, async () => { throw new Error("Malformed model output"); });
  const workspace = await read();
  assert.equal(workspace.emailNeedsReview, true);
  assert.ok(workspace.reviews.every((review) => review.assessment === null));
  assert.ok(workspace.rfp.activity.some((event) => event.stage === "Extract shipper requirements" && event.status === "failed"));
  const lane = workspace.rfp.lanes.find((lane) => lane.origin === "MEX" && lane.destination === "CDG");
  assert.ok(lane);
  await correctRequirements(db, rfpId, lane.id, 0, [dangerous], "Confirmed from the shipper note.");
  await assert.rejects(confirmDisposition(db, rfpId, lane.id, 1, "offer", ""), /unmatched/);
  await reviewUnmatchedEmail(db, rfpId, "Confirmed the separate email had no extra requirements.");
  await confirmDisposition(db, rfpId, lane.id, 1, "offer", "");
  assert.equal((await read()).offered, 1);
});
