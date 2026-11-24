import { getDb } from "../db/client";

export type LabTarget = { sourceId: number; runId: string };
export type CommercialTarget = number | LabTarget;

export class CommercialContextError extends Error {}

export async function commercialContext(target: CommercialTarget) {
  if (typeof target === "number") return { db: await getDb(), rfpId: target, mode: undefined };
  const { getLabCommercial } = await import("./commercial");
  const context = await getLabCommercial(target);
  if (!context) throw new CommercialContextError("Open the lab proposal before editing it.");
  return context;
}

export function commercialPath(target: CommercialTarget) {
  return typeof target === "number" ? `/rfps/${target}` : `/lab/${target.sourceId}/proposal`;
}

export function commercialModel(mode?: "fixture" | "openai") {
  return mode === undefined ? undefined : mode === "openai" && process.env.OPENAI_API_KEY && process.env.RFP_V2_OPENAI_MODEL
    ? { key: process.env.OPENAI_API_KEY, model: process.env.RFP_V2_OPENAI_MODEL }
    : null;
}
