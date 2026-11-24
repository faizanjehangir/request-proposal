"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { commercialContext, commercialModel, commercialPath, CommercialContextError, type CommercialTarget } from "@/src/lab/commercial-target";
import type { AppDb } from "@/src/db/client";
import { maxPricingReplyLength, replyScenarios, type ReplyScenario } from "@/src/pricing/contracts";
import { processPricingEmail, retryPricingEmail } from "@/src/pricing/outbox";
import { simulatePricingReply } from "@/src/pricing/replies";
import { PricingError, requestPricing } from "@/src/pricing/requests";

type ActionState = { error: string | null };

async function perform(target: CommercialTarget, operation: (db: AppDb, rfpId: number, mode?: "fixture" | "openai") => unknown): Promise<ActionState> {
  try {
    const { db, rfpId, mode } = await commercialContext(target);
    await operation(db, rfpId, mode);
    revalidatePath(commercialPath(target));
    if (typeof target === "number") revalidatePath("/");
    return { error: null };
  } catch (error) {
    if (error instanceof CommercialContextError) return { error: error.message };
    if (error instanceof PricingError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Enter a valid simulated Pricing reply." };
    console.error("Pricing action could not be saved", error);
    return { error: "The Pricing action could not be saved. Try again." };
  }
}

export async function sendRateRequest(target: CommercialTarget, previousRequestId: number | null, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => {
    const jobId = await requestPricing(db, rfpId, previousRequestId);
    if (jobId !== null) await processPricingEmail(db, jobId);
  });
}

export async function retryRateRequest(target: CommercialTarget, requestId: number, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => {
    const jobId = await retryPricingEmail(db, rfpId, requestId);
    if (jobId !== undefined) await processPricingEmail(db, jobId);
  });
}

export async function sendPricingReply(
  target: CommercialTarget, requestId: number, previousReplyId: number | null, scenario: ReplyScenario, _state: ActionState, form: FormData,
) {
  return perform(target, async (db, rfpId, mode) => {
    const parsed = z.enum(replyScenarios).parse(scenario);
    const body = parsed === "corrected" ? z.string().max(maxPricingReplyLength).parse(form.get("body")) : undefined;
    await simulatePricingReply(db, rfpId, requestId, previousReplyId, parsed, body, commercialModel(mode));
  });
}
