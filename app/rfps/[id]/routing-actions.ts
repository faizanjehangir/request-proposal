"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/src/db/client";
import { dispositionSchema, serviceSchema } from "@/src/routing/contracts";
import { analyzeRfp, confirmCompliantOffers, confirmDisposition, correctRequirements, declinePendingLanes, reviewUnmatchedEmail, ReviewError } from "@/src/routing/review";

export type RoutingActionState = { error: string | null };
const reason = z.string().trim().max(2000, "Use 2,000 characters or fewer.");

async function perform(rfpId: number, operation: () => unknown): Promise<RoutingActionState> {
  try {
    await operation();
    revalidatePath(`/rfps/${rfpId}`);
    revalidatePath("/");
    return { error: null };
  } catch (error) {
    if (error instanceof ReviewError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Check the selected options and keep the reason under 2,000 characters." };
    console.error("Routing review could not be saved", error);
    return { error: "The routing action could not be saved. Try again." };
  }
}

export async function runAnalysis(rfpId: number, _state: RoutingActionState, _form: FormData) {
  return perform(rfpId, async () => analyzeRfp(await getDb(), rfpId));
}

export async function resolveEmail(rfpId: number, _state: RoutingActionState, form: FormData) {
  return perform(rfpId, async () => reviewUnmatchedEmail(await getDb(), rfpId, reason.parse(form.get("reason") ?? "")));
}

export async function saveRequirements(rfpId: number, laneId: number, revision: number, _state: RoutingActionState, form: FormData) {
  return perform(rfpId, async () => correctRequirements(
    await getDb(), rfpId, laneId, revision, z.array(serviceSchema).parse(form.getAll("service")), reason.parse(form.get("reason") ?? ""),
  ));
}

export async function saveLaneDisposition(rfpId: number, laneId: number, revision: number, _state: RoutingActionState, form: FormData) {
  return perform(rfpId, async () => confirmDisposition(
    await getDb(), rfpId, laneId, revision, dispositionSchema.parse(form.get("disposition")), reason.parse(form.get("reason") ?? ""),
  ));
}

export async function confirmAllCompliant(rfpId: number, _state: RoutingActionState, _form: FormData) {
  return perform(rfpId, async () => confirmCompliantOffers(await getDb(), rfpId));
}

export async function declineAllOpen(rfpId: number, expectedKey: string, _state: RoutingActionState, form: FormData) {
  return perform(rfpId, async () => declinePendingLanes(await getDb(), rfpId, expectedKey, reason.parse(form.get("reason") ?? "")));
}
