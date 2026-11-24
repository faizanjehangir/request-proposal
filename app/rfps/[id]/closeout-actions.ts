"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { commercialContext, commercialModel, commercialPath, CommercialContextError, type CommercialTarget } from "@/src/lab/commercial-target";
import type { AppDb } from "@/src/db/client";
import { processKickoff, retryKickoff } from "@/src/closeout/calendar";
import { customerScenario, responseAction, type CustomerScenario } from "@/src/closeout/contracts";
import { CloseoutError, maxCustomerReplyLength, replayAcceptance, resolveCustomerReply, simulateCustomerReply } from "@/src/closeout/proposals";

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
    if (error instanceof CloseoutError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Check the reply or review details and try again." };
    console.error("Proposal closeout action failed", error);
    return { error: "The closeout action could not be saved. Try again." };
  }
}

export async function sendCustomerReply(
  target: CommercialTarget, quoteId: number, previousReplyId: number, scenario: CustomerScenario, _state: ActionState, form: FormData,
) {
  return perform(target, async (db, rfpId, mode) => {
    const parsed = customerScenario.parse(scenario);
    const body = parsed === "custom" ? z.string().max(maxCustomerReplyLength).parse(form.get("body")) : undefined;
    const result = await simulateCustomerReply(db, rfpId, quoteId, previousReplyId, parsed, form.get("simulateFailure") === "on", body, commercialModel(mode));
    if (result.jobId !== undefined) await processKickoff(db, result.jobId);
  });
}

export async function saveReplyReview(target: CommercialTarget, replyId: number, _state: ActionState, form: FormData) {
  return perform(target, async (db, rfpId) => resolveCustomerReply(db, rfpId, replyId,
    responseAction.parse(form.get("resolution")), z.string().max(2000).parse(form.get("note"))));
}

export async function replayCustomerAcceptance(target: CommercialTarget, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => replayAcceptance(db, rfpId));
}

export async function retryCalendar(target: CommercialTarget, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => {
    const jobId = await retryKickoff(db, rfpId);
    if (jobId !== undefined) await processKickoff(db, jobId);
  });
}
