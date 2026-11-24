"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { commercialContext, commercialPath, CommercialContextError, type CommercialTarget } from "@/src/lab/commercial-target";
import type { AppDb } from "@/src/db/client";
import { dispositionSchema, serviceSchema } from "@/src/routing/contracts";
import { analyzeRfp, confirmCompliantOffers, confirmDisposition, correctRequirements, declinePendingLanes, reviewUnmatchedEmail, ReviewError } from "@/src/routing/review";

export type RoutingActionState = { error: string | null };
const reason = z.string().trim().max(2000, "Use 2,000 characters or fewer.");

async function perform(target: CommercialTarget, operation: (db: AppDb, rfpId: number) => unknown): Promise<RoutingActionState> {
  try {
    const { db, rfpId } = await commercialContext(target);
    await operation(db, rfpId);
    revalidatePath(commercialPath(target));
    if (typeof target === "number") revalidatePath("/");
    return { error: null };
  } catch (error) {
    if (error instanceof CommercialContextError) return { error: error.message };
    if (error instanceof ReviewError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Check the selected options and keep the reason under 2,000 characters." };
    console.error("Routing review could not be saved", error);
    return { error: "The routing action could not be saved. Try again." };
  }
}

export async function runAnalysis(target: CommercialTarget, _state: RoutingActionState, _form: FormData) {
  if (typeof target !== "number") return { error: "Review requirements in the AI Lab first." };
  return perform(target, async (db, rfpId) => analyzeRfp(db, rfpId));
}

export async function resolveEmail(target: CommercialTarget, _state: RoutingActionState, form: FormData) {
  return perform(target, async (db, rfpId) => reviewUnmatchedEmail(db, rfpId, reason.parse(form.get("reason") ?? "")));
}

export async function saveRequirements(target: CommercialTarget, laneId: number, revision: number, _state: RoutingActionState, form: FormData) {
  return perform(target, async (db, rfpId) => correctRequirements(
    db, rfpId, laneId, revision, z.array(serviceSchema).parse(form.getAll("service")), reason.parse(form.get("reason") ?? ""),
  ));
}

export async function saveLaneDisposition(target: CommercialTarget, laneId: number, revision: number, _state: RoutingActionState, form: FormData) {
  return perform(target, async (db, rfpId) => confirmDisposition(
    db, rfpId, laneId, revision, dispositionSchema.parse(form.get("disposition")), reason.parse(form.get("reason") ?? ""),
  ));
}

export async function confirmAllCompliant(target: CommercialTarget, _state: RoutingActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => confirmCompliantOffers(db, rfpId));
}

export async function declineAllOpen(target: CommercialTarget, expectedKey: string, _state: RoutingActionState, form: FormData) {
  return perform(target, async (db, rfpId) => declinePendingLanes(db, rfpId, expectedKey, reason.parse(form.get("reason") ?? "")));
}
