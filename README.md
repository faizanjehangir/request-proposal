# Air Freight RFP

The app implements workbook intake, routing review, simulated Pricing, customer quote delivery, and proposal closeout for the carrier’s RFP Response Team.

[Open the deployed app](https://request-proposal.vercel.app/).

[Run the guided exercise from import to kickoff](docs/exercise-guide.md).

## Run locally

Use Node.js 22. If you use nvm, run `nvm use` from the workspace root. Then install and start the app:

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The app migrates the local SQLite file and creates the demo reviewer on its first request. To prepare the database separately, run `npm run db:setup`.

Click **Load sample RFP** to import the supplied workbook. The detail page shows the 100 shipper lanes, 100 directed flight legs, source files, and Agent Orchestration history. You can also upload an `.xlsx` workbook using the same two sheet names and headers, with an optional UTF-8 `.txt` shipper email. Workbook and email limits are 5 MB and 256 KB, respectively. Validation errors identify the sheet and row when available.

SQLite defaults to `.data/rfp.sqlite`. To use a different file, set `RFP_DB_PATH` in the shell or copy `.env.example` to `.env.local` and edit the path.

## Review routes

Open an imported RFP and select **Extract requirements and find routes**. The default fixture mode interprets the supplied sample notes and runs without credentials.

- Open **MEX → CDG** for the compliant 11-day direct route and its dangerous-goods service evidence.
- Open **GRU → SIN** for the 4-day alternative and the fragile-handling gap. The exercise permits this disclosed gap with a reviewer’s reason. Other service gaps stay ineligible for offers.
- Open **FAI → SIN** for the unreachable route and a no-offer disposition.

Use **Find a lane** and **Filter by decision** to locate decisions. Review offers individually or open **Bulk decisions** to confirm compliant offers together. After saving any alternatives you want to offer, use **Mark remaining lanes as no offer** to apply one reason to all open lanes. For an unclear requirement, confirm the affected services and enter a reason to recalculate that lane. A separate email can produce unmatched passages that require review before confirming offers. Each disposition is saved to SQLite and the Agent Orchestration timeline. Routing is complete when all lane dispositions and unmatched passages are resolved.

To use model-backed extraction, set `RFP_EXTRACTION_MODE=openai`, `OPENAI_API_KEY`, and `RFP_OPENAI_MODEL` in `.env.local`. This sends imported request text to the OpenAI API. Use mock data for the exercise. If extraction fails, the app opens manual requirement review. [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

## Request simulated Pricing

Once at least one lane has a confirmed offer, open **Pricing** and select **Send simulated Pricing email**. The request includes all offers confirmed at that point. Other lanes can stay in review. A disclosed service gap stays visible, and Pricing receives the services actually being offered.

Use **Simulate incomplete reply** to omit one rate, **Simulate conflicting reply** to receive two rates for one lane, or **Simulate complete reply** to clear the exceptions. A corrected reply replaces the current recommendation for the request, so include every offered lane. The app keeps the original email and evidence in the inbox. If more lanes are confirmed, send an updated request covering the current offers. Rates in the earlier request remain valid for its unchanged lanes. Changing the scope of a previously priced lane makes its request stale. Quote drafting requires a disposition for every requested lane and current rates for all offers.

The web app attempts simulated delivery immediately. Run `npm run worker` in a second terminal to process queued sends and recover retries automatically. The Pricing screen can also process a queued send or retry a failed one. The mailbox uses example addresses and records everything locally in SQLite.

## Draft and send the customer quote

Once every lane has a disposition and Pricing has validated all offered rates, open **Customer quote** and choose **Create quote draft**. The email includes all requested lanes, with routes, service coverage and rates for offers and reasons for no-offer lanes. Review the exact email before approving. Editing the opening or closing creates a new version that needs its own approval. If the OpenAI settings are configured, you can also generate new opening and closing text with AI.

Select **Approve quote v1** (or the current version) and **Send simulated quote**. The email is addressed to `shipper@example.test` and appears in the **Simulated customer inbox**. To exercise recovery, select **Simulate a temporary delivery failure** before sending and then use **Retry simulated send**. The same worker command handles Pricing, quote delivery, and kickoff jobs.

## Record acceptance and schedule kickoff

After a quote is delivered to the simulated customer, open **Acceptance and kickoff**. Try **Simulate partial acceptance** first to see the reply and its review options. You can also simulate a counteroffer, rejection, or ambiguous reply. Deliver a newer quote version to try a reply to an earlier version. Review actions can send a simulated clarification, record a rejection, or send the case back for a revised quote.

**Simulate full acceptance** records the exact delivered quote and all lane dispositions in SQLite. The app automatically processes a kickoff job for the simulated shipper and RFP Response Team. To verify recovery, select **Simulate a temporary calendar failure**, accept the proposal, then click **Retry kickoff scheduling**. **Replay acceptance reply** leaves the original proposal and invitation in place.

The default meeting is the next weekday at 10:00 a.m. Toronto time for 30 minutes. Set `RFP_KICKOFF_TIMEZONE` and an optional future `RFP_KICKOFF_START` with an explicit UTC offset in `.env.local` to choose a slot. Run `npm run worker` for automatic background retries. Email and calendar delivery use local simulation records.

## SQLite driver and Node versions

Install dependencies using the same Node major version that runs the app. If you switch Node majors, reinstall with `npm ci` under the new runtime. On macOS, the app commands can use a versioned Homebrew Node 22 install when the shell still points to an older Node. For installs on this machine, select Homebrew Node first:

```sh
export PATH="$(brew --prefix node@22)/bin:$PATH"
npm ci
```

## Verify

```sh
npm test
npm run typecheck
npx playwright install chromium
npm run test:e2e
```

The browser test uses a fresh temporary SQLite file. Set `PLAYWRIGHT_CHANNEL=chrome` to use a local Chrome installation. [Verification details](docs/exercise-guide.md#verify-or-enable-optional-ai)

[Phased implementation plan](docs/implementation-plan.md) · [Design specification](docs/design-spec.md) · [Original walkthrough](demo/index.html)
