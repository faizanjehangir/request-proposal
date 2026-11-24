# Air freight RFP AI V2 design specification

## Current design

The **AI Lab** runs alongside V1 in the Next.js app. Both start from the same imported workbook, notes and flight inventory. V2 checkpoints live in a dedicated SQL table. After route review, the lab copies the reviewed snapshot into a separate database for commercial work. The comparison screen reads both workflows. [README architecture diagram](../README.md#v2-ai-lab-architecture)

## What each component does today

| Component | Responsibility | Where it runs |
|---|---|---|
| LangGraph.js | Runs extraction, pauses for a reviewer, and resumes into route assessment. SQL stores the checkpoint and pending writes. A revision check lets only one submission publish a given review. | [Lab graph](../src/lab/workflow.ts) · [Checkpoints](../src/lab/checkpoints.ts) · [Run lifecycle](../src/lab/runs.ts) |
| Requirement extraction | Uses rules in fixture mode. In OpenAI mode, requests structured lane and service claims with verbatim source excerpts. Application validation checks source and lane references. Failed extraction leaves the run for manual confirmation. | [Extraction and evidence validation](../src/routing/extraction.ts) |
| Route engine | Finds directed itineraries within a time limit and checks services across every leg. The resulting durations and constraints feed the board and proposal. | [Route engine](../src/routing/engine.ts) |
| Route assistant | Answers supported questions from the saved run and can focus a lane or apply a board filter. It first checks local patterns. Configured OpenAI mode can map unfamiliar phrasing to a bounded query. Application code runs the query and formats the result. | [Route assistant](../src/lab/assistant.ts) |
| Commercial AI helpers | In configured OpenAI mode, can extract rate excerpts from a corrected Pricing reply, suggest a greeting and closing for an editable quote, or suggest a review category for an unclear custom customer reply. Each helper returns a typed result. | [Pricing evidence](../src/pricing/ai-extraction.ts) · [Quote wording](../src/quotes/wording.ts) · [Reply classification](../src/closeout/classification.ts) |
| Commercial workflow | Uses transactional application code to validate rates, reconcile offer scope, require approval of the exact quote version, verify acceptance, and queue simulated delivery or kickoff. These actions operate on the isolated copy after the route graph ends. | [Sandbox setup](../src/lab/commercial.ts) · [Rate matcher](../src/pricing/rates.ts) · [Quote approval](../src/quotes/quote.ts) · [Acceptance transaction](../src/closeout/proposals.ts) |

For GRU → SIN, extraction can identify the shipper's fragile-handling requirement and point to the excerpt. LangGraph waits for human confirmation. The route engine finds a four-day direct itinerary with a service gap and an 11-day full-service path against the eight-day cap. The assistant explains those saved results. In the proposal workspace, a reviewer decides whether to disclose the gap and offer standard handling. Pricing must match that offered scope.

## Model integration and developer workflow

- **Fixture provider.** The rules-based extractor and simulator exercise the application without API credentials. The same graph, evidence checks and reviewer checkpoint also run in live mode.
- **Live provider.** The server-side Responses API adapter requests a JSON-schema result and applies a request timeout. Each use case has a dedicated prompt and schema. Enable it with `RFP_V2_MODEL_MODE=openai`, `RFP_V2_OPENAI_MODEL`, and the server-side `OPENAI_API_KEY`. Prompt version tracking and per-node cost budgets belong in pilot evaluation. [Structured model adapter](../src/ai/structured.ts)
- **Developer workflow.** Run the sample in fixture mode, inspect the lab's workflow trace, and use the automated tests for failure and replay scenarios. A local replay command, LangSmith Studio, and a labeled evaluation corpus are optional additions for a pilot. [LangGraph TypeScript workflow example](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph) · [LangSmith local development](https://docs.langchain.com/langsmith/local-dev-testing)
- **Persistence.** Persist the serialized LangGraph checkpoint and pending writes in the separate lab run table on SQLite or Turso. Reload them before each review and use a revision check to publish the result only once. The adapter uses a versioned payload tied to the installed LangGraph checkpoint format, so rerun restart and concurrent-review tests when upgrading LangGraph.
- **Isolation.** Share read-only inputs and pure domain functions. Give V2 its own run IDs and store its proposal records, simulated mail and outbox in a separate database. The comparison screen uses the same immutable input snapshot for both versions. Deduplicate effects by run, action and input version. Use a run ID plus revision to reject stale resumes and repeated clicks.

## Interactive route explorer

Show the extraction, review and comparison stages horizontally. Display multiple lanes as rows, with competing itineraries side by side on wider screens. Direction, transit time and missing services appear on each leg. Expanding a leg reveals its inventory row and available services.

| Visual | Meaning |
|---|---|
| Green solid leg marker | The leg satisfies the lane's service requirements. |
| Amber dashed edge with a gap label | The leg has a service gap. The route can be offered only if policy permits it and a reviewer confirms the disclosure. |
| Red itinerary label | A hard constraint blocks the itinerary. Show the transit cap on the lane and an explicit no-path label for unreachable lanes. |

Show counts across the whole RFP, with filters and paged lane rows. A read-only route assistant can summarize outcomes, apply a filter or focus a directed lane. Fixture mode uses deterministic query rules. Configured OpenAI mode can interpret unfamiliar phrasing into the same bounded query types. Answers use the assessed data from the current run. Label workbook-backed data as **Inventory snapshot**. Live flight positions, schedules or disruptions would require a separate data source and a freshness indicator.

After the schematic, add a geographic view if spatial context is useful. Join IATA codes to a vetted airport-coordinate dataset and use deck.gl `ArcLayer` for selectable flight arcs. Missing coordinates should leave the leg available in the schematic and table. The geographic arc expresses connectivity, while the assessment displays workbook transit time. [deck.gl ArcLayer](https://deck.gl/docs/api-reference/layers/arc-layer)

## Proposed assistant tools

Current model calls return structured data. The app chooses when to call extraction, routing, Pricing, and closeout code. The assistant already dispatches a bounded query to application code. Model-selected tool calls become worthwhile when users need to combine several lookups in one request, such as finding blocked temperature-controlled lanes and citing the inventory rows that caused each block. [LangGraph workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) · [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

| First proposed read-only tool | Inputs | Grounded result |
|---|---|---|
| `list_routes` | Validated outcome filter, optional supported service, and page size | Matching lanes, total counts, deadlines and status reasons. |
| `explain_lane` | Directed origin and destination | Selected itinerary, alternatives, service gaps, source excerpts and inventory rows. |
| `get_proposal_status` | Scope derived from the authorized lab run | Open lane decisions, missing or stale rates, quote approval status and the next available action. |

Bind each lookup to the active authorized run on the server. Validate airport codes, filters and limits before calling existing domain functions. Return source references, and use an explicit unavailable result when inputs or source data are missing. Keep approval, sending, acceptance and scheduling on the reviewed application actions. A future external inventory or Pricing adapter can use a simulated provider in tests and return the same typed result in production.

First evaluate whether a read-only tool improves multi-step questions over the current bounded query approach. Include tests for invented airport pairs, missing and stale data, attempted cross-run reads, instructions embedded in source text, and requests to change commercial terms. Start with the existing TypeScript functions and typed contracts. Add a model tool dispatcher only when a measured use case needs it.

## Implementation phases and acceptance checks

1. **Local vertical slice.** Import the same sample, start V2 in fixture mode, extract requirements, pause for review, run the existing routing engine, and open the route explorer. Add one live extraction call as an opt-in. Recover to manual review on timeout or invalid output.
2. **Comparison and checkpoints.** Add V1 and V2 comparison for evidence, corrections, route outcomes and time to review. Persist checkpoint state across process restarts before hosted evaluation. Reject stale resumes and test that V2 runs cannot mutate V1 proposal state.
3. **Workflow parity.** Add scoped Pricing, quote approval, simulated sends, reply triage, and idempotent kickoff. Compare exact terms against V1 for equivalent reviewed inputs.
4. **Pilot evaluation.** Test on de-identified examples. Measure lane-to-service accuracy, missed mandatory requirements, reviewer correction rate, time to reviewed offer, latency and model cost. Track invalid accepted rates, false acceptance and duplicate actions as failure counts. Promote live mode after the workflow is auditable and the model shows a measurable improvement.

The minimum demo covers MEX → CDG choosing the compliant 11-day direct route, GRU → SIN comparing the 4-day service gap to the 11-day full-service alternative against an 8-day cap, and FAI → SIN showing disconnected inventory. Add an ambiguous source passage that pauses for review. Beyond the first slice, also demonstrate a wrong-scope rate and retry a simulated kickoff without creating a duplicate.

## Run the local lab

The lab implements requirement extraction, a reviewer checkpoint, route comparison, and an isolated commercial proposal workflow. Start the server in fixture mode.

```sh
npm run dev
```

Load a sample RFP from the home page, click **AI Lab** in the top-right header, and select the same RFP. Select **Add a simulated ambiguous instruction** and run extraction. Review the excerpt. For example, resolve it as a clarification that the simulated instruction adds no requirements. If it changes a lane, open that lane, adjust its services, and confirm the selection. Save a review note and continue to compare routes. The graph pauses and resumes on the same saved run. Use **Open a recent run** or reopen its URL within one hour after a restart. Use **Compare V1 and V2** to see extraction evidence, reviewed services, routing outcomes, and elapsed review times. Analyze the RFP in the original workflow to populate the V1 baseline.

V1 stays available under `/rfps/[id]` and the lab is available under `/lab/[id]`. Set `RFP_V2_ENABLED=0` to hide the lab on a local server. Vercel previews require an explicit `RFP_V2_ENABLED=1`. Lab checkpoints use the configured Turso connection there. Hosted verification and model-generated route explanations remain separate from the local workflow.

For live extraction, configure `RFP_V2_MODEL_MODE=openai`, `RFP_V2_OPENAI_MODEL` and the server-side `OPENAI_API_KEY`, then start a new lab run.

## Run the V2 proposal

After confirming requirements and comparing routes, click **Open lab proposal**. The lab copies the already-reviewed workbook snapshot into an isolated commercial workspace. Confirm lane offers, simulate Pricing replies and reconcile any issues. Generate a quote, approve its exact version and send it to the simulated inbox. Try partial acceptance, then test full acceptance with a temporary calendar failure. Retry kickoff scheduling or replay the acceptance to see its existing record.

Use **Compare V1 and V2** after both versions have a saved quote. The comparison checks the commercial terms by directed lane and resolves copied flight IDs to original inventory rows. Compare proposals made with the same offered services and rates. The saved proposal URL continues working after the one-hour analysis window.

Local commercial records use the SQLite file alongside the original file with a `.lab.sqlite` suffix. Hosted proposals require a separate Turso database configured with `RFP_V2_DATABASE_URL` and `RFP_V2_DATABASE_AUTH_TOKEN`. The lab never falls back to the V1 database for commercial writes. Simulated send and kickoff jobs can be processed or retried in the lab UI.

## Reuse in this repository

- [Workbook import](../src/intake/import-rfp.ts) and [source validation](../src/routing/extraction.ts)
- [Route search](../src/routing/engine.ts) and [offer policies](../src/routing/contracts.ts)
- [Pricing reconciliation](../src/pricing/rates.ts), [quote versioning](../src/quotes/quote.ts), and [acceptance transaction](../src/closeout/proposals.ts)
- [Outbox and retries](../src/workflow/outbox.ts) and the [sample browser walkthrough](../tests/e2e/exercise.spec.ts)
