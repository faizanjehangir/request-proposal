import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { sql } from "drizzle-orm";
import { openDb } from "../src/db/client";
import { getRfp } from "../src/db/queries";
import { importRfp, sampleWorkbookName } from "../src/intake/import-rfp";
import { processPricingEmail } from "../src/pricing/outbox";
import { simulatePricingReply } from "../src/pricing/replies";
import { latestPricingRequest, requestPricing } from "../src/pricing/requests";
import { processQuoteEmail, requestQuoteDelivery } from "../src/quotes/outbox";
import { approveQuote, createQuoteDraft } from "../src/quotes/quote";
import { analyzeRfp, confirmDisposition, declinePendingLanes, getRoutingReview, pendingDispositionKey } from "../src/routing/review";
import { extractRequirements } from "../src/routing/extraction";
import { classifyCustomerReply } from "../src/closeout/classification";
import { getCloseoutWorkspace, receiveCustomerReply, replayAcceptance, resolveCustomerReply, simulateCustomerReply } from "../src/closeout/proposals";
import { kickoffSlot, processKickoff, retryKickoff } from "../src/closeout/calendar";

async function sample(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "rfp-closeout-"));
  const databasePath = join(directory, "rfp.sqlite");
  const connection = openDb(databasePath);
  t.after(async () => { connection.close(); await rm(directory, { recursive: true, force: true }); });
  const db = connection.db;
  const workbook = new File([new Uint8Array(readFileSync(sampleWorkbookName))], sampleWorkbookName);
  const id = await importRfp(db, workbook, null, true);
  await analyzeRfp(db, id, (input) => extractRequirements(input, "fixture"));
  const rfp = getRfp(id, db)!;
  const mex = rfp.lanes.find((lane) => lane.origin === "MEX" && lane.destination === "CDG")!;
  const gru = rfp.lanes.find((lane) => lane.origin === "GRU" && lane.destination === "SIN")!;
  confirmDisposition(db, id, mex.id, 0, "offer", "");
  confirmDisposition(db, id, gru.id, 0, "alternative", "Disclose the fragile-handling gap.");
  declinePendingLanes(db, id, pendingDispositionKey(getRoutingReview(db, rfp).reviews), "No offer for the remaining lanes.");
  processPricingEmail(db, requestPricing(db, id, null)!);
  await simulatePricingReply(db, id, latestPricingRequest(db, id)!.id, null, "complete");
  const v1 = createQuoteDraft(db, id, null);
  const deliver = (quote: number) => {
    approveQuote(db, id, quote);
    processQuoteEmail(db, requestQuoteDelivery(db, id, quote));
  };
  const read = () => getCloseoutWorkspace(db, id);
  return { db, databasePath, id, v1, deliver, read };
}

test("classifies explicit acceptance, changed terms, and mismatched references conservatively", () => {
  assert.equal(classifyCustomerReply("We accept all offered lanes and terms in RFP-1 · v2.", 1, 2).intent, "accepted");
  assert.equal(classifyCustomerReply("We accept this proposal in full.", 1, 2).intent, "accepted");
  assert.equal(classifyCustomerReply("We accept this proposal in full, subject to a lower rate.", 1, 2).intent, "counteroffer");
  assert.equal(classifyCustomerReply("We accept all offered lanes and terms in RFP-1 · v1.", 1, 2).intent, "unclear");
  assert.equal(classifyCustomerReply("We accept only the first offered lane.", 1, 2).intent, "partial");
  assert.equal(classifyCustomerReply("This looks promising.", 1, 2).intent, "unclear");
});

test("checks customer identity, latest delivered version and human-review outcomes", async (t) => {
  const { db, id, v1, deliver, read } = await sample(t);
  await assert.rejects(simulateCustomerReply(db, id, v1, 0, "full"), /delivered quote/);
  deliver(v1);

  const partial = await simulateCustomerReply(db, id, v1, 0, "partial");
  assert.equal(partial.jobId, undefined);
  assert.equal(read().proposal, undefined);
  assert.equal(read().replies[0].reply.intent, "partial");
  resolveCustomerReply(db, id, partial.replyId, "clarified", "Please confirm whether you accept all offered lanes.");
  assert.equal(read().clarifications.length, 1);
  assert.equal(read().replies[0].reply.resolution, "clarified");
  assert.throws(() => resolveCustomerReply(db, id, partial.replyId, "clarified", "Duplicate clarification."), /already has/);

  const counter = await simulateCustomerReply(db, id, v1, partial.replyId, "counteroffer");
  assert.equal(read().replies[0].reply.intent, "counteroffer");
  resolveCustomerReply(db, id, counter.replyId, "revise", "Prepare a revised proposal.");
  const outdated = await simulateCustomerReply(db, id, v1, counter.replyId, "full");
  assert.equal(read().replies[0].reply.intent, "unclear");
  assert.equal(outdated.jobId, undefined);

  const v2 = createQuoteDraft(db, id, v1, { opening: "Revised proposal.", closing: "Please confirm by replying." });
  deliver(v2);
  const old = await simulateCustomerReply(db, id, v2, outdated.replyId, "superseded");
  assert.equal(read().replies[0].reply.intent, "superseded");
  const unclear = await simulateCustomerReply(db, id, v2, old.replyId, "unclear");
  assert.equal(read().replies[0].reply.intent, "unclear");
  const rejection = await simulateCustomerReply(db, id, v2, unclear.replyId, "rejection");
  assert.equal(read().replies[0].reply.intent, "rejection");
  resolveCustomerReply(db, id, rejection.replyId, "rejected", "The customer declined this version.");
  assert.equal(read().replies[0].reply.resolution, "rejected");
  const latest = read().delivered[0];
  assert.throws(() => receiveCustomerReply(db, {
    rfpId: id, inReplyTo: latest.messageId, messageKey: "wrong-sender",
    thread: latest.thread, sender: "other@example.test", body: "We accept this proposal in full.",
  }), /match the customer and thread/);
  assert.equal(read().proposal, undefined);
});

test("persists accepted terms and retries kickoff once across replay and duplicate messages", async (t) => {
  const { db, id, v1, deliver, read } = await sample(t);
  deliver(v1);
  const partial = await simulateCustomerReply(db, id, v1, 0, "partial");
  const result = await simulateCustomerReply(db, id, v1, partial.replyId, "full", true);
  const { proposal, delivered, job } = read();
  assert.ok(proposal && job && result.jobId);
  assert.equal(proposal.quoteVersionId, v1);
  assert.deepEqual(proposal.lanes, delivered[0].quote.lanes);
  assert.equal(proposal.body, delivered[0].quote.body);
  assert.equal(proposal.lanes.length, 100);
  assert.equal(job.status, "pending");
  assert.equal(processKickoff(db, result.jobId), true);
  assert.match(read().job?.lastError ?? "", /temporarily unavailable/);
  assert.equal(read().proposal?.id, proposal.id);
  assert.equal(read().invite, undefined);
  const retry = retryKickoff(db, id);
  assert.equal(processKickoff(db, retry), true);
  const booked = read().invite!;
  assert.equal(booked.providerId, `CAL-${proposal.id}`);
  assert.equal(booked.attendees.length, 2);
  assert.equal(new Date(booked.endAt).getTime() - new Date(booked.startAt).getTime(), 30 * 60_000);

  replayAcceptance(db, id);
  assert.equal(read().replies.length, 2);
  const repeat = await simulateCustomerReply(db, id, v1, result.replyId, "full");
  assert.equal(repeat.jobId, undefined);
  assert.equal(read().replies[0].reply.intent, "duplicate");
  assert.equal(retryKickoff(db, id), undefined);
  assert.deepEqual(read().invite, booked);
  assert.equal(read().proposal?.id, proposal.id);
  assert.throws(() => createQuoteDraft(db, id, v1, { opening: "Another quote", closing: "Thanks" }), /already accepted/);
});

test("rolls acceptance back if the kickoff job cannot be queued", async (t) => {
  const { db, id, v1, deliver, read } = await sample(t);
  deliver(v1);
  db.run(sql`CREATE TRIGGER reject_test_kickoff BEFORE INSERT ON outbox_jobs
    WHEN NEW.kind = 'kickoff' BEGIN SELECT RAISE(ABORT, 'test kickoff insert failure'); END`);
  await assert.rejects(simulateCustomerReply(db, id, v1, 0, "full"), /test kickoff insert failure/);
  assert.equal(read().proposal, undefined);
  assert.equal(read().replies.length, 0);
  assert.equal(read().job, undefined);
});

test("schedules the next Toronto weekday across daylight saving and validates configured slots", () => {
  const now = new Date("2026-03-06T20:00:00Z");
  assert.equal(kickoffSlot(now, "America/Toronto", "").startAt, "2026-03-09T14:00:00.000Z");
  assert.equal(kickoffSlot(now, "America/Toronto", "2026-03-10T09:30:00-04:00").startAt, "2026-03-10T13:30:00.000Z");
  assert.throws(() => kickoffSlot(now, "America/Toronto", "2026-03-10T09:30:00"), /explicit UTC offset/);
});

test("a restarted worker reclaims a kickoff lease and books one invitation", async (t) => {
  const { db, databasePath, id, v1, deliver, read } = await sample(t);
  deliver(v1);
  const { jobId } = await simulateCustomerReply(db, id, v1, 0, "full");
  assert.ok(jobId);
  const env = {
    ...process.env, RFP_DB_PATH: databasePath, RFP_EXTRACTION_MODE: "fixture",
    RFP_KICKOFF_TIMEZONE: "America/Toronto", RFP_KICKOFF_START: "",
  };
  await promisify(execFile)(process.execPath, ["--import", "tsx", "-e", `
    const { openDb } = require("./src/db/client.ts");
    const { claimJob } = require("./src/workflow/outbox.ts");
    const connection = openDb();
    if (!claimJob(connection.db, "kickoff", ${jobId})) throw new Error("Kickoff was not leased");
    connection.close();
  `], { env });
  assert.equal(read().job?.status, "running");
  assert.equal(read().invite, undefined);

  // Advance the abandoned lease to its expiry without a wall-clock wait.
  db.run(sql`update outbox_jobs set leaseUntil = '2000-01-01T00:00:00.000Z' where id = ${jobId}`);
  const worker = spawn(process.execPath, ["--import", "tsx", "scripts/workflow-worker.ts"], {
    env, stdio: ["ignore", "ignore", "pipe"],
  });
  const exit = once(worker, "close");
  let errors = "";
  worker.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    for (let i = 0; i < 80 && !read().invite && worker.exitCode === null; i++) await delay(50);
    const booked = read();
    assert.ok(booked.invite, errors);
    assert.equal(booked.job?.status, "complete");
    assert.equal(booked.job?.attempts, 2);
    replayAcceptance(db, id);
    assert.deepEqual(read().invite, booked.invite);
  } finally {
    worker.kill();
    await exit;
  }
});
