import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDb } from "../src/db/client";
import { getRfp } from "../src/db/queries";
import { importRfp, sampleWorkbookName } from "../src/intake/import-rfp";
import { processPricingEmail } from "../src/pricing/outbox";
import { mockPricingReply } from "../src/pricing/rates";
import { getPricingState, simulatePricingReply } from "../src/pricing/replies";
import { pricingScope, requestPricing } from "../src/pricing/requests";
import { customerMailbox, quoteThread } from "../src/quotes/contracts";
import { processQuoteEmail, requestQuoteDelivery, retryQuoteDelivery } from "../src/quotes/outbox";
import { approveQuote, createQuoteDraft, getQuoteWorkspace } from "../src/quotes/quote";
import { extractRequirements } from "../src/routing/extraction";
import { analyzeRfp, confirmDisposition, declinePendingLanes, getRoutingReview, pendingDispositionKey } from "../src/routing/review";

async function sampleQuote(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "rfp-quote-"));
  const connection = openDb(join(directory, "rfp.sqlite"));
  t.after(async () => { connection.close(); await rm(directory, { recursive: true, force: true }); });
  const db = connection.db;
  const workbook = new File([new Uint8Array(readFileSync(sampleWorkbookName))], sampleWorkbookName);
  const id = await importRfp(db, workbook, null, true);
  await analyzeRfp(db, id, (input) => extractRequirements(input, "fixture"));

  function snapshot() {
    const rfp = getRfp(id, db);
    assert.ok(rfp);
    const routing = getRoutingReview(db, rfp);
    return { rfp, routing };
  }

  function review(origin: string, destination: string) {
    const { rfp, routing } = snapshot();
    const lane = rfp.lanes.find((item) => item.origin === origin && item.destination === destination);
    const result = routing.reviews.find((item) => item.laneId === lane?.id);
    assert.ok(result);
    return result;
  }

  const mex = review("MEX", "CDG");
  const gru = review("GRU", "SIN");
  const fai = review("FAI", "SIN");
  confirmDisposition(db, id, mex.laneId, mex.revision, "offer", "");
  confirmDisposition(db, id, gru.laneId, gru.revision, "alternative", "Disclose the fragile-handling exclusion.");
  confirmDisposition(db, id, fai.laneId, fai.revision, "no_offer", "No feasible route in the available network.");
  declinePendingLanes(db, id, pendingDispositionKey(snapshot().routing.reviews), "No offer for this lane.");

  const job = requestPricing(db, id, null);
  assert.ok(job);
  processPricingEmail(db, job);

  const pricing = () => {
    const { rfp, routing } = snapshot();
    return getPricingState(db, id, pricingScope(rfp, routing));
  };
  const read = () => {
    const { rfp, routing } = snapshot();
    return getQuoteWorkspace(db, rfp, routing, pricing());
  };
  async function completePricing() {
    const state = pricing();
    assert.ok(state.active);
    return simulatePricingReply(db, id, state.active.id, state.reply?.messageId ?? null, "complete");
  }
  return { db, id, pricing, read, completePricing };
}

test("drafts every requested lane after rates reconcile, but requires approval to send", async (t) => {
  const { db, id, read, pricing, completePricing } = await sampleQuote(t);
  const request = pricing().active!;
  await simulatePricingReply(db, id, request.id, null, "incomplete");
  assert.throws(() => createQuoteDraft(db, id, null), /reconcile rates/);
  await completePricing();
  const quoteId = createQuoteDraft(db, id, null);
  const draft = read().current!;
  assert.equal(draft.lanes.length, 100);
  assert.equal(draft.lanes.filter((lane) => lane.disposition !== "no_offer").length, 2);
  assert.match(draft.body, /FAI → SIN · 46.1 tons\nNo offer — No feasible route/);
  assert.match(draft.body, /MEX → CDG · 12.3 tons\nRoute: MEX → CDG · 11 days\nServices fulfilled: Dangerous goods/);
  assert.match(draft.body, /GRU → SIN · 19.1 tons\nRoute: GRU → SIN · 4 days\nServices fulfilled: Standard handling only\nRequested services unavailable: Fragile handling\nRate: USD 2,240.00 per ton/);
  assert.throws(() => requestQuoteDelivery(db, id, quoteId), /Approve this exact quote version/);
  assert.equal(read().messages.length, 0);
  approveQuote(db, id, quoteId);
  const jobId = requestQuoteDelivery(db, id, quoteId);
  assert.equal(requestQuoteDelivery(db, id, quoteId), jobId);
  assert.equal(processQuoteEmail(db, jobId), true);
  assert.equal(processQuoteEmail(db, jobId), false);
  assert.equal(retryQuoteDelivery(db, id, quoteId), undefined);
  const { messages, approved } = read();
  assert.equal(approved?.reviewer, "Demo reviewer");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, draft.body);
  assert.equal(messages[0].subject, draft.subject);
  assert.equal(messages[0].recipient, customerMailbox);
  assert.equal(messages[0].threadKey, quoteThread(id));
});

test("new wording needs another approval and a queued superseded version cannot be sent", async (t) => {
  const { db, id, read, completePricing } = await sampleQuote(t);
  await completePricing();
  const v1 = createQuoteDraft(db, id, null);
  const original = read().current!.body;
  approveQuote(db, id, v1);
  const oldJob = requestQuoteDelivery(db, id, v1);
  const v2 = createQuoteDraft(db, id, v1, { opening: "Hello from the freight team.", closing: "Please confirm by replying." });
  assert.equal(read().current?.version, 2);
  assert.equal(read().versions[1].body, original);
  assert.equal(read().approved, undefined);
  assert.throws(() => approveQuote(db, id, v1), /superseded/);
  assert.throws(() => requestQuoteDelivery(db, id, v2), /Approve/);
  processQuoteEmail(db, oldJob);
  assert.equal(read().messages.length, 0);
  approveQuote(db, id, v2);
  processQuoteEmail(db, requestQuoteDelivery(db, id, v2));
  assert.equal(read().messages[0].body, read().current?.body);
  assert.match(read().messages[0].subject, /v2$/);
});

test("changed Pricing invalidates a queued quote, and retry sends the new approved version once", async (t) => {
  const { db, id, read, pricing, completePricing } = await sampleQuote(t);
  await completePricing();
  const v1 = createQuoteDraft(db, id, null);
  approveQuote(db, id, v1);
  const stale = requestQuoteDelivery(db, id, v1);
  const state = pricing();
  const request = state.active!;
  const corrected = mockPricingReply(request.scope, "complete").replace("2,240.00", "2,240.75");
  await simulatePricingReply(db, id, request.id, state.reply!.messageId, "corrected", corrected);
  assert.equal(read().stale, true);
  assert.throws(() => requestQuoteDelivery(db, id, v1), /out of date/);
  processQuoteEmail(db, stale);
  assert.equal(read().job?.status, "canceled");
  assert.equal(read().messages.length, 0);

  const v2 = createQuoteDraft(db, id, v1);
  assert.equal(read().approved, undefined);
  approveQuote(db, id, v2);
  const job = requestQuoteDelivery(db, id, v2, true);
  processQuoteEmail(db, job);
  assert.match(read().job?.lastError ?? "", /temporarily unavailable/);
  assert.equal(read().messages.length, 0);
  assert.equal(retryQuoteDelivery(db, id, v2), job);
  assert.equal(processQuoteEmail(db, job), true);
  assert.equal(processQuoteEmail(db, job), false);
  assert.equal(read().messages.length, 1);
  assert.match(read().messages[0].body, /USD 2,240.75 per ton/);
});
