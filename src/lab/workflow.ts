import { Annotation, Command, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { extractOpenAi, extractRequirements, validateExtraction, type ExtractionResult } from "../routing/extraction";
import { createRouteEngine } from "../routing/engine";
import { serviceSchema, type AssessedPath, type ExtractedLane, type RequirementIssue, type RouteAssessment, type Service } from "../routing/contracts";
import type { analysisInput } from "../routing/review";

type Input = ReturnType<typeof analysisInput>;
type Lane = Input["lanes"][number] & { maxTransitDays: string };
type Flights = Parameters<typeof createRouteEngine>[0];
export type ModelMode = "fixture" | "openai";
export type LaneRoute = { id: number; requirements: Service[]; assessment: RouteAssessment; fasterWithGap: AssessedPath | null };
type Event = { step: string; result: string };

const reviewSchema = z.strictObject({
  note: z.string().trim().max(2000),
  corrections: z.array(z.strictObject({ laneId: z.number().int(), services: z.array(serviceSchema) })),
});

export type Review = z.infer<typeof reviewSchema>;

type LabState = {
  lanes: { id: number; extracted: ExtractedLane }[];
  issues: RequirementIssue[];
  review: Review;
  routes?: LaneRoute[];
  events: Event[];
};

const state = Annotation.Root({
  lanes: Annotation<LabState["lanes"]>(),
  issues: Annotation<RequirementIssue[]>(),
  review: Annotation<Review>(),
  routes: Annotation<LaneRoute[]>(),
  events: Annotation<Event[]>({ reducer: (earlier, later) => [...earlier, ...later], default: () => [] }),
});

function suggestedRoutes(engine: ReturnType<typeof createRouteEngine>, lane: Lane, requirements: Service[]): LaneRoute {
  const assessment = engine.assess(lane.origin, lane.destination, lane.maxTransitDays, requirements);
  let fasterWithGap: AssessedPath | null = null;
  if (assessment.status === "compliant" && requirements.length) {
    const fastest = engine.assess(lane.origin, lane.destination, lane.maxTransitDays, []).path;
    if (fastest && fastest.totalDays !== assessment.path?.totalDays) {
      const legs = fastest.legs.map(leg => ({
        ...leg, missing: requirements.filter(service => !leg.services.includes(service)),
      }));
      const missing = requirements.filter(service => legs.some(leg => leg.missing.includes(service)));
      if (missing.length) fasterWithGap = { ...fastest, legs, missing, fulfilled: requirements.filter(service => !missing.includes(service)) };
    }
  }
  return { id: lane.id, requirements, assessment, fasterWithGap };
}

export function createLabWorkflow(
  input: Input, lanes: Lane[], flights: Flights, mode: ModelMode,
  provider: (input: Input, mode: ModelMode) => Promise<ExtractionResult> = async (input, mode) => {
    if (mode === "fixture") return extractRequirements(input, "fixture");
    const key = process.env.OPENAI_API_KEY;
    const model = process.env.RFP_V2_OPENAI_MODEL;
    if (!key || !model) throw new Error("Set the V2 model and server API key.");
    return validateExtraction(input, await extractOpenAi(input, { key, model }));
  },
  checkpointer = new MemorySaver(),
) {
  const graph = new StateGraph(state)
    .addNode("extract", async () => {
      let result: ExtractionResult;
      let message: string;
      try {
        result = await provider(input, mode);
        message = mode === "fixture" ? "Ran the fixture extractor and checked source evidence." : "Validated structured model output against source evidence.";
      } catch {
        result = validateExtraction(input, { claims: [], unmapped: [] });
        message = "Extraction could not complete. Confirm the requirements manually.";
      }
      return {
        lanes: [...result.lanes].map(([id, extracted]) => ({ id, extracted })),
        issues: result.issues,
        events: [{ step: "Extract requirements", result: message }],
      };
    })
    .addNode("reviewRequirements", (current: LabState) => {
      const needsReview = current.lanes.filter(lane => lane.extracted.issues.length).map(lane => lane.id);
      const review = reviewSchema.parse(interrupt({ stage: "requirements", needsReview, unmatchedCount: current.issues.length }));
      return { review, events: [{ step: "Review requirements", result: "Reviewer confirmed the requirements and resolved any flagged text." }] };
    })
    .addNode("assess", (current: LabState) => {
      const engine = createRouteEngine(flights, lanes.map(lane => lane.maxTransitDays));
      const original = new Map(current.lanes.map(lane => [lane.id, lane.extracted.services]));
      const corrected = new Map(current.review.corrections.map(lane => [lane.laneId, lane.services]));
      return {
        routes: lanes.map(lane => suggestedRoutes(engine, lane, corrected.get(lane.id) ?? original.get(lane.id) ?? [])),
        events: [{ step: "Compare routes", result: `Evaluated ${lanes.length} lanes against the imported inventory snapshot.` }],
      };
    })
    .addEdge(START, "extract")
    .addEdge("extract", "reviewRequirements")
    .addEdge("reviewRequirements", "assess")
    .addEdge("assess", END)
    .compile({ checkpointer });

  return {
    start: (id: string) => graph.invoke({}, { configurable: { thread_id: id } }),
    read: async (id: string) => {
      const snapshot = await graph.getState({ configurable: { thread_id: id } });
      return { values: snapshot.values as LabState, next: snapshot.next };
    },
    resume: (id: string, decision: Review) => graph.invoke(new Command({ resume: decision }), { configurable: { thread_id: id } }),
  };
}
