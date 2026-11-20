import { z } from "zod";

export const services = [
  "Temperature controlled (2-8 C)",
  "Dangerous goods",
  "High-value security",
  "Fragile handling",
  "Oversized cargo",
] as const;

export const serviceSchema = z.enum(services);
export type Service = z.infer<typeof serviceSchema>;

function normalizedLabel(value: string) {
  return value.toLowerCase().replace(/[–—−]/g, "-").replace(/°/g, "").replace(/\s+/g, " ").trim();
}

export function inventoryServices(values: string[]) {
  const labels = new Set(values.map(normalizedLabel));
  return services.filter((service) => labels.has(normalizedLabel(service)));
}

export type RequirementSource = {
  id: string;
  label: string;
  text: string;
  laneId: number | null;
};

export type Evidence = { sourceId: string; excerpt: string };
export type RequirementIssue = Evidence & { message: string };
export type ExtractedLane = {
  services: Service[];
  explicitGeneralCargo: boolean;
  evidence: Evidence[];
  issues: RequirementIssue[];
};

export type ExtractionCandidate = z.infer<typeof extractionSchema>;
export const extractionSchema = z.strictObject({
  claims: z.array(z.strictObject({
    laneId: z.number().int(),
    sourceId: z.string(),
    excerpt: z.string(),
    kind: z.enum(["service", "general_cargo", "review"]),
    service: serviceSchema.nullable(),
    issue: z.string().nullable(),
  })),
  unmapped: z.array(z.strictObject({
    sourceId: z.string(),
    excerpt: z.string(),
    message: z.string(),
  })),
});

export const dispositionSchema = z.enum(["offer", "alternative", "no_offer"]);
export type Disposition = z.infer<typeof dispositionSchema>;

export type AssessedLeg = {
  id: number;
  sourceRow: number;
  origin: string;
  destination: string;
  transitDays: string;
  services: Service[];
  missing: Service[];
};

export type AssessedPath = {
  airports: string[];
  totalDays: string;
  fulfilled: Service[];
  missing: Service[];
  legs: AssessedLeg[];
};

export type RouteAssessment = {
  status: "compliant" | "service_gap" | "over_limit" | "unreachable";
  path: AssessedPath | null;
  fullServicePath: AssessedPath | null;
};

export const routeLabels = {
  compliant: "Meets request",
  service_gap: "Service gap",
  over_limit: "Over time limit",
  unreachable: "Unreachable",
} as const;

export function permittedDispositions(assessment: RouteAssessment | null): Disposition[] {
  if (assessment?.status === "compliant") return ["offer", "no_offer"];
  if (assessment?.status === "service_gap" && assessment.path?.missing.every((service) => service === "Fragile handling")) {
    return ["alternative", "no_offer"];
  }
  return ["no_offer"];
}
