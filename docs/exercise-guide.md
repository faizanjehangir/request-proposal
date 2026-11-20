# Air freight RFP exercise

Start with a fresh sample RFP and finish with one accepted proposal and one simulated kickoff. The main exercise prices two lanes so you can review the decisions quickly while the customer quote still accounts for all 100 requested lanes.

## Start locally

From the workspace root, use Node.js 22 and run:

```sh
npm ci
RFP_EXTRACTION_MODE=fixture npm run dev
```

Open [the local app](http://127.0.0.1:3000). Fixture mode uses the provided wording and mock replies without an API key. **Load sample RFP** creates another RFP each time, so you can repeat the exercise alongside earlier runs. To try a separate shipper email, upload both files through **Import workbook** instead. [Sample workbook](../Air_Freight_RFP_Mock_Data.xlsx) · [Multi-lane shipper email](../fixtures/shipper-email.txt)

The default database is `.data/rfp.sqlite`. For a separate run, set `RFP_DB_PATH` to a fresh file before starting the app. The app applies migrations on startup or when you run `npm run db:setup`. If you choose to run the worker, give it the same database path in a second terminal.

## Run the exercise

1. **Import.** Confirm the RFP has 100 shipper lanes and 100 flight legs. In **Routing review**, click **Extract requirements and find routes**. Use **Find a lane** and **Filter by decision** to work through individual decisions.
2. **Decide what to offer.** Find **MEX → CDG**, expand the lane, and save **Compliant offer**. Find **GRU → SIN** and save **Offer with disclosed gap** with a reason explaining that fragile handling is unavailable. Find **FAI → SIN** to inspect the unreachable outcome. You can save its no-offer reason individually or include it in the bulk step.
3. **Request early rates.** Open **Pricing** and click **Send simulated Pricing email**. Pricing should list only the two offered lanes. Click **Simulate incomplete reply**. Compare the original reply with the table and find the missing GRU → SIN rate. Click **Simulate complete reply**. The two rates match while quote drafting waits for the other lane dispositions.
4. **Finish routing review.** If you are following the two-lane exercise, open **Mark remaining lanes as no offer** and enter a shared reason such as “No offer on this lane under the exercise proposal.” This applies to all open lanes, including any compliant lanes you left undecided. Pricing now shows **Rates ready for quote drafting** with the two offers.
5. **Approve and send.** In **Customer quote**, click **Create quote draft**. Review both offers and the reasons for the no-offer lanes. To exercise versioning, approve v1, edit the opening through **Edit email wording**, and save as v2. Approve the version you intend to send, then click **Send simulated quote**. Open it in the simulated customer inbox.
6. **Close the proposal.** In **Acceptance and kickoff**, click **Simulate partial acceptance** and inspect the reply and review options. Then click **Simulate full acceptance**. Open **View accepted proposal in SQLite** and check the **Simulated kickoff invitation**. Click **Replay acceptance reply** and verify the proposal and invite identifiers are the same.

### Expected lane outcomes

| Lane | Routing decision | Simulated quote |
|---|---|---|
| MEX → CDG | Direct, 11 days, dangerous-goods handling covers the requested service | USD 1,840.00 per ton with dangerous-goods handling |
| GRU → SIN | Direct, 4 days, fragile handling unavailable | USD 2,240.00 per ton for standard handling only, with the gap disclosed |
| FAI → SIN | Unreachable in the flight inventory | No offer and the recorded reason |

### Other scenarios to try

| Exercise | Expected result |
|---|---|
| Conflicting Pricing reply | A conflicting or missing recommendation blocks quote readiness. A complete reply clears the exception. |
| Stale Pricing | After a valid reply, use **Correct requirements** on an offered lane and save. Confirm its new disposition and send an updated Pricing request. Earlier rates stay visible with a stale label. |
| Quote approval | Save new email wording after approval. The new version needs its own approval. |
| Customer counteroffer or older quote reply | The response enters review. The older-version option appears after you send a second quote version. |
| Calendar failure | Select **Simulate a temporary calendar failure** before full acceptance. The proposal saves immediately. Click **Retry kickoff scheduling** and verify one invitation appears. |
| Worker restart | With a pending retry in the app, run `npm run worker`. Refresh the RFP to see the result. The worker uses the same jobs as the web app. |

The default kickoff slot is the next weekday at 10:00 a.m. Toronto time for 30 minutes. Set `RFP_KICKOFF_TIMEZONE` and a future `RFP_KICKOFF_START` with an explicit UTC offset to use a different slot. [Example configuration](../.env.example)

## Verify or enable optional AI

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

The browser suite builds the production app and launches a temporary server at `127.0.0.1:3187` with a fresh SQLite file. It checks the delivered quote against the accepted SQL snapshot, all 100 stored lane dispositions, and the single kickoff invitation after replay. Set `RFP_E2E_PORT` to use another port. If Chrome is already installed, `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` uses it.

To try the configured AI mode, copy `.env.example` to `.env.local`, set `RFP_EXTRACTION_MODE=openai`, `OPENAI_API_KEY`, and `RFP_OPENAI_MODEL` to a Structured Outputs model you can use, then restart and import a fresh sample. Check that extraction cites the workbook and optional shipper email. Follow the same workflow to try a corrected Pricing reply, **Generate new wording with AI**, or an ambiguous custom customer reply. Mock provider tests exercise the adapter contracts and evidence validation without credentials. Email and calendar delivery stay in the local simulator in both modes.
