# Air freight RFP automation
## Phased implementation plan

Build a working web app that imports the supplied RFP, generates auditable route and service decisions, gets a mock Pricing recommendation, sends an approved quote to a simulated shipper inbox, and records the accepted proposal in SQLite before scheduling a simulated kickoff. The response team can run the exercise repeatedly with predictable inputs and see where a human decision is required.

[Design specification](design-spec.md) · [Component map](component-map.html) · [Original walkthrough](../demo/index.html) · [Mock workbook](../Air_Freight_RFP_Mock_Data.xlsx)

### Exercise scope and defaults

- **Implemented in the app** · XLSX and text intake, route evaluation, review decisions, pricing reconciliation, quote approval and versioning, acceptance rules, SQL persistence, and the Agent Orchestration panel.
- **Simulated integrations** · Email and calendar adapters store mock messages and invitations in SQLite. The simulator injects plain-text Pricing and customer replies into the same inbound processing path used by the app. Calendar scheduling runs automatically after acceptance, with an exercise control to trigger a temporary failure and a visible retry.
- **AI modes** · Include a configured AI adapter for requirement extraction, reply parsing and classification, and optional quote prose. Provide deterministic fixture mode for the supplied scenarios and automated tests, so the exercise works without an API key. Both modes return the same typed results and pass through the same validation.
- **Working assumptions** · One local carrier workspace with a seeded reviewer identity. Use USD per ton, treat time limits as inclusive, sum listed flight days, and use the service flags on every leg. Schedule kickoff using demo attendees and a configurable seeded slot and timezone. The app records the reviewer who approves the quote.
- **Client decisions for a live rollout** · Mail and calendar providers, authentication and roles, unit and currency conventions, transfer and capacity rules, service exception policy, and kickoff availability. The exercise uses the defaults above.

## Proposed technology

| Area | Recommendation | Why it fits |
|---|---|---|
| Web app | **Next.js App Router, React, TypeScript, CSS Modules** | One codebase for the reviewer UI, upload and simulation endpoints, and server-side queries. Reuse the static walkthrough’s interaction and visual patterns. [Next.js App Router](https://nextjs.org/docs/app) · [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers) |
| SQL and migrations | **SQLite, better-sqlite3, Drizzle ORM and Drizzle Kit** | Store workflow records, audit events and jobs in a local database file. Use checked-in migrations, foreign keys, unique constraints, transactions, and integer cents for USD rates. [Drizzle SQLite setup](https://orm.drizzle.team/docs/sqlite/get-started-sqlite) |
| Intake and contracts | **read-excel-file, Zod** | Read the workbook server-side and validate mapped rows, API input and AI results at their boundaries. [read-excel-file](https://www.npmjs.com/package/read-excel-file) · [Zod](https://zod.dev/) |
| Routing and workflow | **Plain TypeScript domain modules and a small Node worker** | Keep flight search, permitted state transitions and pricing reconciliation deterministic. The worker processes the SQLite outbox with retries and uses the same application services as the web app. Each job claim uses a short write transaction. [SQLite transactions](https://sqlite.org/lang_transaction.html) |
| AI | **OpenAI Responses API with Structured Outputs, behind a typed adapter** | Bind extraction to schemas for lane references, requirements and evidence, pricing recommendations, and customer reply intent. Application code verifies scope and authorizes all changes and outbound actions. [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) |
| Email and calendar | **SQL-backed simulated adapters** | Provide a believable inbox, sent messages, reply threads, and calendar events. Share provider-shaped IDs and idempotency keys with the worker so retry and duplicate behavior can be exercised. |
| Test tooling | **Vitest and Playwright** | Cover route and workflow rules in unit tests, transactional behavior against a temporary SQLite file, and reviewer tasks through the browser. [Vitest](https://vitest.dev/guide/) · [Playwright](https://playwright.dev/docs/intro) |

Run the web process and one worker on the same machine against the same local database file. Enable write-ahead logging, set a busy timeout on each connection, and keep write transactions short. Use an explicit workflow service for state transitions and durable activity events. The UI reads the stored messages, exceptions, approvals and job outcomes after refresh. Revisit PostgreSQL if deployment needs multiple hosts sharing the database or sustained concurrent writes. [SQLite write-ahead logging](https://sqlite.org/wal.html)

## Phase 1 · Foundation and workbook intake

**Outcome** · A reviewer can load the workbook and inspect a persisted RFP and flight inventory.

| Issue | Work and acceptance criteria |
|---|---|
| **RFP-01 · Scaffold the app and local services** | Initialize the Next.js app, scripts, environment template and seeded reviewer. Configure a workspace-local SQLite path, enable foreign keys and write-ahead logging, and set connection timeouts. Verify that a clean checkout can create and migrate the database file and start the app. |
| **RFP-02 · Create the intake schema** | Add RFP, source file/text, lane, transit snapshot and directed flight-leg records. Persist row references, original inputs and exact tonnage as canonical decimal text. Enforce unique lane keys per RFP and preserve separate flight records when appropriate. |
| **RFP-03 · Implement the XLSX and text importer** | Support the two supplied sheets, lane-level notes, and an optional separate multi-lane plain-text email. Validate headers, route keys, numeric values and file limits. Return actionable sheet and row errors, with no partial RFP committed on a rejected import. |
| **RFP-04 · Build the RFP list and intake screens** | Support upload, load sample, import results and lane inspection. Show the transit snapshot and original shipper text. Confirm that imported records survive a refresh. |
| **RFP-05 · Start the workflow timeline** | Define the activity event record with stage, status, input references, result, timestamp and next action. Show intake outcomes in the Agent Orchestration panel and link users to the affected records. |

**Phase check** · Load the supplied workbook and see 100 unique lanes and 100 flight records. Verify that a malformed workbook reports actionable errors and creates no partial data.

## Phase 2 · Requirements, routing, and exception review

**Depends on Phase 1.** A reviewer can reach a disposition for every lane.

| Issue | Work and acceptance criteria |
|---|---|
| **RFP-06 · Define service and extraction contracts** | Normalize the workbook’s service vocabulary. Represent requested services, explicit general cargo, unknown requirements, ambiguous lane associations and original evidence. Validate semantically that referenced lanes and source excerpts exist. |
| **RFP-07 · Implement AI and fixture extraction** | Extract structured requirements from row notes or a separate multi-lane email. Implement the fixture adapter and configured AI adapter. Model refusal, malformed output, timeout, and conflicting or unclear requests produce review items. |
| **RFP-08 · Implement deterministic routing** | Model flights as directed, preserve per-leg service flags and find the fastest route that satisfies all services and the time cap. Break ties by fewest legs and stable flight IDs. Find the best time-feasible alternative by end-to-end service coverage, then days and legs. Classify fully compliant, service gap, over limit and unreachable. |
| **RFP-09 · Build the lane review queue** | Surface selected routes, exact gap legs, duration and evidence. Let reviewers correct requirements, confirm a disclosed alternative where permitted, or record no offer and the reason. Reroute when requirements change and preserve prior decisions in the timeline. |
| **RFP-10 · Verify routing against the workbook** | Check MEX → CDG chooses the 11-day dangerous-goods direct route over the 10-day path with a gap, GRU → SIN requires a decision on the fragile-handling exclusion, and FAI → SIN is unreachable. Cover exact time cap, directionality, cycles and services missing on one leg. |

**Phase check** · Review all lanes in a single RFP. Complete routing review once each lane has a confirmed offer or no-offer disposition. Pricing can start earlier for confirmed offers. An RFP with zero offered lanes can close as no offer.

## Phase 3 · Simulated Pricing and rate reconciliation

**Depends on Phase 2.** Each offered lane receives a validated rate or a visible Pricing exception.

| Issue | Work and acceptance criteria |
|---|---|
| **RFP-11 · Add the message store and simulated email adapter** | Store mock inbox and sent items, participants, original body, thread and message IDs, and message direction. Support duplicate message detection and an inbox view for the response team. |
| **RFP-12 · Implement the SQL outbox and worker** | Queue outbound work in the same transaction as the workflow change. Claim work atomically in a short SQLite write transaction, lease it for crash recovery, and handle bounded retries and terminal failures. Process each job after the claim transaction commits. Use idempotency keys so retries create one mock message per send. |
| **RFP-13 · Generate and send Pricing requests** | Request all offers confirmed at the time of sending, even while other lanes remain in review. Include the selected route, tonnage, requested and offered services, currency, rate unit and request reference. Record the exact priced scope per lane. |
| **RFP-14 · Generate mock Pricing replies** | Add controls for complete, incomplete and conflicting free-text replies. Insert each through the simulated inbound adapter with the matching request and thread. |
| **RFP-15 · Parse and reconcile rates** | Extract amount, currency, per-ton unit, lane, included services and source evidence. Validate USD precision and store amounts as integer cents. Match against the active request. Flag missing, duplicate-conflicting, unrecognized and out-of-scope rates for follow-up. Invalidate rates and any affected draft when the priced route, tonnage or service scope changes. |
| **RFP-16 · Build Pricing review and status** | Show the original email alongside matched rates and specific exceptions. Allow another Pricing request or a corrected reply. Keep quote readiness blocked until every requested lane has a disposition and every offered lane has a valid current rate. Log send, reply and reconciliation results. |

**Phase check** · Offer GRU → SIN with the disclosed gap, simulate a missing rate, then send a complete reply. Confirm the quote becomes eligible only after the correct rate is applied to the offered service scope.

## Phase 4 · Quote drafting, approval, and simulated delivery

**Depends on Phase 3.** The simulated shipper receives the exact approved version.

| Issue | Work and acceptance criteria |
|---|---|
| **RFP-17 · Render the quote from validated terms** | Include every requested lane. Show route sequence, transit time, fulfilled and unfulfilled services and price per ton for priced offers, plus an explicit reason for each no-offer lane. Generate the terms from stored data and optionally generate surrounding prose with AI. |
| **RFP-18 · Implement versioning and review** | Store exact draft content and lane snapshots. Bind approval to that version and reviewer. Changes to terms or content result in a new draft and another approval. Concurrent actions cannot send an unapproved or stale version. |
| **RFP-19 · Send through the simulated email adapter** | Queue the approved version, persist the delivery result and thread, and show the recipient view. Recover from a simulated send error. Double-clicking send or retrying a completed job creates one customer message. |

**Phase check** · Verify the simulated shipper receives the exact approved quote. Every lane is accounted for, including declined and unreachable lanes.

## Phase 5 · Customer acceptance, SQL record, and simulated kickoff

**Depends on Phase 4.** A clear acceptance produces one accepted proposal and one kickoff invitation.

| Issue | Work and acceptance criteria |
|---|---|
| **RFP-20 · Simulate and classify customer replies** | Exercise clear full acceptance, partial acceptance, counteroffer, rejection, ambiguous wording and a reply to a superseded version. Process replies through the simulated inbox. Validate sender, thread and quote version, and retain evidence for the classification. |
| **RFP-21 · Add customer reply review and revision** | Show the original reply and why it needs a decision. Allow the team to record a rejection, request clarification, or revise and reapprove terms. Replies proposing different terms or referencing a superseded quote remain outside automatic acceptance. |
| **RFP-22 · Persist the accepted proposal transactionally** | Store the accepted quote version, reply evidence and immutable lane dispositions, including route, service and price terms on offered lanes. In the same transaction, queue the kickoff. Unique constraints prevent duplicate proposals and jobs even if an acceptance is repeated with a different message ID. |
| **RFP-23 · Implement the simulated calendar adapter** | Automatically process the kickoff job with the configured slot, attendees and timezone. Store the simulated invite ID. Support an injected temporary failure and retry, with one invitation after recovery or replay. |
| **RFP-24 · Build the closeout view** | Show acceptance evidence, the persisted proposal and lane details, and invitation status. Show pending, failed and booked states in the Agent Orchestration panel, with an actionable retry when eligible. |

**Phase check** · A partial reply leaves the proposal in review. A later full acceptance records one proposal, the worker schedules a kickoff, and duplicate replies or calendar retries preserve one proposal and one invite.

## Phase 6 · End-to-end verification and exercise handoff

**Depends on Phases 1–5.** A fresh user can run and repeat the full exercise. [Demo and verification guide](exercise-guide.md)

| Issue | Work and acceptance criteria |
|---|---|
| **RFP-25 · Package fixtures and guided scenarios** | Include the supplied workbook, a separate multi-lane email, known review outcomes, mock reply choices and configurable kickoff data. Document how to create a fresh demo RFP and run the exercise without service credentials. |
| **RFP-26 · Add browser and SQL integration coverage** | Test happy path, routing exception, missing and stale rates, quote revision, partial acceptance, duplicate acceptance, worker restart and calendar retry. Verify SQL proposal details and counts after refresh and job replay. |
| **RFP-27 · Polish the reviewer experience** | Check keyboard interaction, responsive layout, a 100-lane review, clear blocked states and source evidence links. Verify that errors tell reviewers what they can do next. |
| **RFP-28 · Verify both AI modes and document startup** | Run the full fixture-mode exercise against a clean database. Test the same contracts in configured AI mode with mock data when credentials are available. Document configuration, migrations, tests, worker startup and the simulated integration boundaries. |

**Complete when** · A fresh local run imports the supplied workbook and completes a persisted proposal from intake through simulated kickoff. A reviewer can trace the requirement, routing, pricing, approval and acceptance evidence for any quoted lane. Repeat deliveries, duplicate replies and temporary scheduling failures preserve consistent records.
