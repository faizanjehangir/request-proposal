"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/src/db/client";
import { processKickoff, retryKickoff } from "@/src/closeout/calendar";
import { customerScenario, responseAction, type CustomerScenario } from "@/src/closeout/contracts";
import { CloseoutError, maxCustomerReplyLength, replayAcceptance, resolveCustomerReply, simulateCustomerReply } from "@/src/closeout/proposals";

type ActionState = { error: string | null };

async function perform(rfpId: number, operation: () => void | Promise<void>): Promise<ActionState> {
  try {
    await operation();
    revalidatePath(`/rfps/${rfpId}`);
    revalidatePath("/");
    return { error: null };
  } catch (error) {
    if (error instanceof CloseoutError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Check the reply or review details and try again." };
    console.error("Proposal closeout action failed", error);
    return { error: "The closeout action could not be saved. Try again." };
  }
}

export async function sendCustomerReply(
  rfpId: number, quoteId: number, previousReplyId: number, scenario: CustomerScenario, _state: ActionState, form: FormData,
) {
  return perform(rfpId, async () => {
    const db = getDb();
    const parsed = customerScenario.parse(scenario);
    const body = parsed === "custom" ? z.string().max(maxCustomerReplyLength).parse(form.get("body")) : undefined;
    const result = await simulateCustomerReply(db, rfpId, quoteId, previousReplyId, parsed, form.get("simulateFailure") === "on", body);
    if (result.jobId !== undefined) processKickoff(db, result.jobId);
  });
}

export async function saveReplyReview(rfpId: number, replyId: number, _state: ActionState, form: FormData) {
  return perform(rfpId, () => resolveCustomerReply(getDb(), rfpId, replyId,
    responseAction.parse(form.get("resolution")), z.string().max(2000).parse(form.get("note"))));
}

export async function replayCustomerAcceptance(rfpId: number, _state: ActionState, _form: FormData) {
  return perform(rfpId, () => replayAcceptance(getDb(), rfpId));
}

export async function retryCalendar(rfpId: number, _state: ActionState, _form: FormData) {
  return perform(rfpId, () => {
    const db = getDb();
    const jobId = retryKickoff(db, rfpId);
    if (jobId !== undefined) processKickoff(db, jobId);
  });
}
