"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/src/db/client";
import { maxPricingReplyLength, replyScenarios, type ReplyScenario } from "@/src/pricing/contracts";
import { processPricingEmail, retryPricingEmail } from "@/src/pricing/outbox";
import { simulatePricingReply } from "@/src/pricing/replies";
import { PricingError, requestPricing } from "@/src/pricing/requests";

type ActionState = { error: string | null };

async function perform(rfpId: number, operation: () => unknown): Promise<ActionState> {
  try {
    await operation();
    revalidatePath(`/rfps/${rfpId}`);
    revalidatePath("/");
    return { error: null };
  } catch (error) {
    if (error instanceof PricingError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Enter a valid simulated Pricing reply." };
    console.error("Pricing action could not be saved", error);
    return { error: "The Pricing action could not be saved. Try again." };
  }
}

export async function sendRateRequest(rfpId: number, previousRequestId: number | null, _state: ActionState, _form: FormData) {
  return perform(rfpId, async () => {
    const db = await getDb();
    const jobId = await requestPricing(db, rfpId, previousRequestId);
    if (jobId !== null) await processPricingEmail(db, jobId);
  });
}

export async function retryRateRequest(rfpId: number, requestId: number, _state: ActionState, _form: FormData) {
  return perform(rfpId, async () => {
    const db = await getDb();
    const jobId = await retryPricingEmail(db, rfpId, requestId);
    if (jobId !== undefined) await processPricingEmail(db, jobId);
  });
}

export async function sendPricingReply(
  rfpId: number, requestId: number, previousReplyId: number | null, scenario: ReplyScenario, _state: ActionState, form: FormData,
) {
  return perform(rfpId, async () => {
    const parsed = z.enum(replyScenarios).parse(scenario);
    const body = parsed === "corrected" ? z.string().max(maxPricingReplyLength).parse(form.get("body")) : undefined;
    await simulatePricingReply(await getDb(), rfpId, requestId, previousReplyId, parsed, body);
  });
}
