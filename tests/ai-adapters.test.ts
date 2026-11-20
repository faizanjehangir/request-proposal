import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestReviewIntent } from "../src/closeout/classification";
import { getPricingExcerpts } from "../src/pricing/ai-extraction";
import { reconcileRates } from "../src/pricing/rates";
import type { PricingScope } from "../src/pricing/contracts";
import { draftQuoteWording } from "../src/quotes/wording";

test("configured AI adapters validate simulated provider responses and preserve deterministic review safeguards", async (t) => {
  const config = {
    RFP_EXTRACTION_MODE: "openai",
    OPENAI_API_KEY: "fixture-key",
    RFP_OPENAI_MODEL: "fixture-model",
  };
  const saved = Object.keys(config).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const recommendations = [
    "For GRU to SIN, I recommend USD 2,240.00 per ton,",
    "for standard handling only.",
    "For GRU to SIN, I recommend USD 2,600.00 per ton, for standard handling only.",
  ];
  const completeExcerpt = recommendations.slice(0, 2).join("\n");
  const scope: PricingScope[] = [{
    laneId: 1, revision: 1, origin: "GRU", destination: "SIN", tons: "19.1", airports: ["GRU", "SIN"],
    legIds: [1], transitDays: "4", requested: ["Fragile handling"], offered: [], unavailable: ["Fragile handling"],
  }];
  const responses: Record<string, unknown> = {
    pricing_reply_evidence: { recommendations: [completeExcerpt, "Invented quote"] },
    air_freight_quote_wording: { opening: "Hello from the freight team.", closing: "Please reply to confirm." },
    shipper_reply_review: { intent: "counteroffer", evidence: "Can you adjust the terms?" },
  };
  const mock = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const request = JSON.parse(String(options.body));
    assert.equal(request.model, "fixture-model");
    assert.equal(request.text.format.strict, true);
    assert.equal(request.store, false);
    return Response.json({ status: "completed", output: [{
      type: "message", content: [{ type: "output_text", text: JSON.stringify(responses[request.text.format.name]) }],
    }] });
  });

  const body = recommendations.join("\n");
  const excerpts = await getPricingExcerpts(body);
  assert.ok(excerpts?.includes(completeExcerpt));
  assert.equal(excerpts?.includes("Invented quote"), false);
  assert.match(reconcileRates(scope, body, excerpts).issues[0].message, /conflicting amounts/);
  assert.deepEqual(await draftQuoteWording(), responses.air_freight_quote_wording);
  assert.deepEqual(await suggestReviewIntent("Can you adjust the terms?"), responses.shipper_reply_review);
  assert.equal(await suggestReviewIntent("This looks promising."), undefined);
  assert.equal(mock.mock.callCount(), 4);
});
