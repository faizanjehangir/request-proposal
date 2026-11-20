import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDb } from "../src/db/client";
import { getRfp } from "../src/db/queries";
import { emailMessages, outboxJobs, pricingRequests } from "../src/db/schema";
import { importRfp, sampleWorkbookName } from "../src/intake/import-rfp";
import { pricingFrom } from "../src/pricing/contracts";
import { claimPricingEmail, deliverPricingEmail, processPricingEmail, retryPricingEmail } from "../src/pricing/outbox";
import { mockPricingReply, reconcileRates } from "../src/pricing/rates";
import { getPricingWorkspace, receivePricingReply, simulatePricingReply } from "../src/pricing/replies";
import { readPricingScope, requestPricing, threadKey } from "../src/pricing/requests";
import { extractRequirements } from "../src/routing/extraction";
import { analyzeRfp, confirmDisposition, correctRequirements, declinePendingLanes, getRoutingReview, pendingDispositionKey } from "../src/routing/review";

async function samplePricing(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "rfp-pricing-"));
  const connection = await openDb(join(directory, "rfp.sqlite"));
  t.after(async () => { connection.close(); await rm(directory, { recursive: true, force: true }); });
  const db = connection.db;
  const workbook = new File([new Uint8Array(readFileSync(sampleWorkbookName))], sampleWorkbookName);
  const id = await importRfp(db, workbook, null, true);
  await analyzeRfp(db, id, (input) => extractRequirements(input, "fixture"));

  const rawRfp = async () => {
    const rfp = await getRfp(id, db);
    assert.ok(rfp);
    return rfp;
  };
  const rfp = await rawRfp();
  const routing = async () => getRoutingReview(db, await rawRfp());
  async function lane(origin: string, destination: string) {
    const selected = rfp.lanes.find((item) => item.origin === origin && item.destination === destination);
    const review = (await routing()).reviews.find((item) => item.laneId === selected?.id);
    assert.ok(review);
    return review;
  }
  const gru = await lane("GRU", "SIN");
  const mex = await lane("MEX", "CDG");
  const approve = async () => {
    const available = new Map([[gru.laneId, "alternative"], [mex.laneId, "offer"]] as const);
    for (const review of (await routing()).reviews) {
      await confirmDisposition(db, id, review.laneId, review.revision, available.get(review.laneId) ?? "no_offer",
        review.laneId === gru.laneId ? "Disclose the fragile handling gap." : "Reviewed for this exercise.");
    }
  };
  const read = async () => getPricingWorkspace(db, id, await readPricingScope(db, id));
  return { db, id, approve, lane, read };
}

test("prices only offered scopes and holds quote readiness through missing and conflicting replies", async (t) => {
  const { db, id, approve, read } = await samplePricing(t);
  await assert.rejects(requestPricing(db, id, null), /Confirm at least one offer/);
  await approve();
  const job = await requestPricing(db, id, null);
  assert.ok(job);
  assert.equal(await requestPricing(db, id, null), null);
  assert.equal(await db.$count(pricingRequests), 1);
  assert.equal((await read()).job?.status, "pending");
  assert.equal(await processPricingEmail(db, job), true);
  assert.equal(await processPricingEmail(db, job), false);
  assert.equal(await db.$count(emailMessages), 1);
  const sent = (await read()).threads[0].messages[0];
  assert.match(sent.body, /GRU → SIN · 19.1 tons.*\(4 days\).*Requested: Fragile handling.*Standard handling only.*Excluded: Fragile handling/);
  assert.doesNotMatch(sent.body, /FAI → SIN/);
  const request = (await read()).active!;
  const incomplete = await simulatePricingReply(db, id, request.id, null, "incomplete");
  assert.equal(await simulatePricingReply(db, id, request.id, null, "incomplete"), incomplete);
  assert.equal((await read()).quoteReady, false);
  assert.equal((await read()).rates.length, 1);
  assert.match((await read()).reply?.issues[0].message ?? "", /Missing rate/);

  const conflict = await simulatePricingReply(db, id, request.id, incomplete, "conflicting");
  assert.equal((await read()).quoteReady, false);
  assert.match((await read()).reply?.issues[0].message ?? "", /conflicting amounts/);

  const complete = await simulatePricingReply(db, id, request.id, conflict, "complete");
  assert.equal((await read()).quoteReady, true);
  assert.deepEqual((await read()).rates.map(({ amountCents, services }) => [amountCents, services]), [
    [184000, ["Dangerous goods"]], [224000, []],
  ]);
  const before = request.scope[0];
  await assert.rejects(receivePricingReply(db, {
    requestId: request.id, rfpId: id, sender: pricingFrom, messageKey: "invalid-thread", thread: "unknown",
    body: mockPricingReply(request.scope, "complete"),
  }, complete), /match the active Pricing thread/);
  assert.equal((await read()).threads[0].messages.length, 4);
  assert.ok(before.legIds.length);
});

test("requests early rates and keeps quote drafting blocked until all lanes are resolved and covered", async (t) => {
  const { db, id, read, lane } = await samplePricing(t);
  const mex = await lane("MEX", "CDG");
  await confirmDisposition(db, id, mex.laneId, mex.revision, "offer", "");
  assert.equal((await read()).current.pending, 99);
  const firstJob = await requestPricing(db, id, null);
  assert.ok(firstJob);
  const first = (await read()).active!;
  assert.deepEqual(first.scope.map((offer) => offer.laneId), [mex.laneId]);

  const gru = await lane("GRU", "SIN");
  await confirmDisposition(db, id, gru.laneId, gru.revision, "alternative", "Disclose the fragile-handling gap.");
  assert.equal((await read()).additionalOffers, 1);
  assert.equal((await read()).stale, false);
  assert.equal(await processPricingEmail(db, firstJob), true);
  assert.equal((await read()).job?.status, "complete");
  await simulatePricingReply(db, id, first.id, null, "complete");
  assert.equal((await read()).requestPriced, true);
  assert.equal((await read()).quoteReady, false);
  assert.equal((await read()).rates[0].amountCents, 184000);

  const secondJob = await requestPricing(db, id, first.id);
  assert.ok(secondJob);
  await processPricingEmail(db, secondJob);
  const second = (await read()).active!;
  assert.deepEqual(second.scope.map((offer) => offer.laneId), [mex.laneId, gru.laneId]);
  await simulatePricingReply(db, id, second.id, null, "complete");
  assert.equal((await read()).requestPriced, true);
  assert.equal((await read()).quoteReady, false);

  const rfp = await getRfp(id, db);
  assert.ok(rfp);
  await declinePendingLanes(db, id, pendingDispositionKey((await getRoutingReview(db, rfp)).reviews), "Reviewed all other lanes.");
  assert.equal((await read()).current.pending, 0);
  assert.equal((await read()).quoteReady, true);
  assert.equal((await read()).active?.id, second.id);
});

test("reconciliation flags unrequested lanes, amount, currency, unit and scope errors", async (t) => {
  const { id, approve, db, read } = await samplePricing(t);
  await approve();
  assert.ok(await requestPricing(db, id, null));
  const scope = (await read()).active!.scope;
  const reply = [
    "For MEX to CDG, use USD 1840.00 per ton, for standard handling only.",
    "For MEX to CDG, a second quote is CAD 1200 per ton, including Dangerous goods.",
    "For MEX to CDG, use USD 1800.009 per ton, including Dangerous goods.",
    "For GRU to SIN, use USD 2240 per shipment, for standard handling only.",
    "For FAI to SIN, use USD 99 per ton, for standard handling only.",
    "For GRU to SIN via JFK, use USD 2240 per ton, for standard handling only.",
    "For GRU to SIN (20 tons), use USD 2240 per ton, for standard handling only.",
  ].join("\n");
  const parsed = reconcileRates(scope, reply);
  assert.deepEqual(parsed.rates, []);
  for (const pattern of [/scope does not match/, /explicit USD/, /at most two decimal places/, /outside this request/, /Route or tonnage does not match/]) {
    assert.ok(parsed.issues.some((issue) => pattern.test(issue.message)));
  }
  const precise = reconcileRates(scope,
    "For MEX to CDG, use USD 1,840.07/ton, including Dangerous goods.\nFor GRU to SIN, use USD 2,240.5 per ton, for standard handling only.");
  assert.deepEqual(precise.rates.map((rate) => rate.amountCents), [184007, 224050]);
  assert.deepEqual(precise.issues, []);
});

test("revising routing invalidates previous rates and allows a corrected reply on the new request", async (t) => {
  const { db, id, approve, read, lane } = await samplePricing(t);
  await approve();
  await processPricingEmail(db, (await requestPricing(db, id, null))!);
  const first = (await read()).active!;
  await simulatePricingReply(db, id, first.id, null, "complete");
  assert.equal((await read()).quoteReady, true);
  const gru = await lane("GRU", "SIN");
  await correctRequirements(db, id, gru.laneId, gru.revision, [], "Shipper confirmed standard handling.");
  assert.equal((await read()).stale, true);
  assert.equal((await read()).quoteReady, false);
  await assert.rejects(simulatePricingReply(db, id, first.id, (await read()).reply!.messageId, "complete"), /scope has changed/);
  await confirmDisposition(db, id, gru.laneId, (await lane("GRU", "SIN")).revision, "offer", "");
  await processPricingEmail(db, (await requestPricing(db, id, first.id))!);
  const current = (await read()).active!;
  assert.notEqual(current.id, first.id);
  assert.equal((await read()).threads.length, 2);
  const reply = mockPricingReply(current.scope, "complete").replace("2,240.00", "2,240.75");
  await simulatePricingReply(db, id, current.id, null, "corrected", reply);
  assert.equal((await read()).quoteReady, true);
  assert.ok((await read()).rates.some(({ amountCents }) => amountCents === 224075));
});

test("SQLite outbox recovers an expired lease without duplicating the sent email", async (t) => {
  const { db, id, approve, read } = await samplePricing(t);
  await approve();
  const jobId = (await requestPricing(db, id, null))!;
  const start = new Date(Date.now() + 100);
  const crashed = await claimPricingEmail(db, jobId, start);
  assert.ok(crashed);
  assert.equal(await claimPricingEmail(db, jobId, new Date(start.getTime() + 2000)), null);
  const resumed = await claimPricingEmail(db, jobId, new Date(start.getTime() + 31_000));
  assert.ok(resumed);
  assert.equal(resumed.attempts, 2);
  await deliverPricingEmail(db, crashed);
  assert.equal(await db.$count(emailMessages), 0);
  await deliverPricingEmail(db, resumed);
  await deliverPricingEmail(db, resumed);
  assert.equal(await db.$count(emailMessages), 1);
  assert.equal(await db.$count(outboxJobs), 1);
  assert.equal((await read()).job?.status, "complete");
});

test("bounded retries leave a failed send that can be retried explicitly", async (t) => {
  const { db, id, approve, read } = await samplePricing(t);
  await approve();
  const jobId = (await requestPricing(db, id, null))!;
  const start = Date.now();
  const fail = () => { throw new Error("Injected delivery failure"); };
  const quiet = t.mock.method(console, "error", () => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await processPricingEmail(db, jobId, new Date(start + 100 + attempt * 3000), fail), true);
  }
  quiet.mock.restore();
  assert.equal((await read()).job?.status, "failed");
  assert.equal(await db.$count(emailMessages), 0);
  assert.equal(await retryPricingEmail(db, id, (await read()).active!.id), jobId);
  assert.equal(await processPricingEmail(db, jobId), true);
  assert.equal((await read()).job?.status, "complete");
  assert.equal(await db.$count(emailMessages), 1);
});
