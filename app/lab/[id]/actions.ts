"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRfp } from "@/src/db/queries";
import { answerLabQuestion, type LabAnswer } from "@/src/lab/assistant";
import { startLabCommercial } from "@/src/lab/commercial";
import type { LabTarget } from "@/src/lab/commercial-target";
import { labEnabled } from "@/src/lab/config";
import { getLabRun, LabError, resumeLabRun, startLabRun } from "@/src/lab/runs";

type ActionState = { error: string | null };

export async function startRun(rfpId: number, _state: ActionState, form: FormData): Promise<ActionState> {
  if (!labEnabled()) return { error: "The AI Lab is disabled." };
  let id: string;
  try {
    const rfp = await getRfp(rfpId);
    if (!rfp) return { error: "This RFP could not be found." };
    id = await startLabRun(rfp, form.get("simulateAmbiguity") === "yes");
  } catch (error) {
    if (!(error instanceof LabError)) console.error("AI Lab start failed", error);
    return { error: error instanceof LabError ? error.message : "The lab analysis could not start. Try again." };
  }
  redirect(`/lab/${rfpId}?run=${id}`);
}

export async function reviewRun(rfpId: number, id: string, revision: number, _state: ActionState, form: FormData): Promise<ActionState> {
  if (!labEnabled()) return { error: "The AI Lab is disabled." };
  try {
    const rfp = await getRfp(rfpId);
    if (!rfp) return { error: "This RFP could not be found." };
    await resumeLabRun(rfp, id, revision, form);
  } catch (error) {
    if (!(error instanceof LabError)) console.error("AI Lab resume failed", error);
    return { error: error instanceof LabError ? error.message : "The lab could not resume. Try starting a new analysis." };
  }
  revalidatePath(`/lab/${rfpId}`);
  return { error: null };
}

export async function askRun(rfpId: number, id: string, prompt: string): Promise<LabAnswer> {
  if (!labEnabled()) return { text: "The AI Lab is disabled." };
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 500) return { text: "Enter a question up to 500 characters." };
  const rfp = await getRfp(rfpId);
  const run = rfp && await getLabRun(rfp, id);
  if (!run || !rfp) return { text: "Start a new lab run to ask about this RFP." };
  return answerLabQuestion(prompt.trim(), {
    lanes: rfp.lanes,
    routes: run.state.routes ?? [],
    flagged: run.state.lanes.filter(lane => lane.extracted.issues.length).length,
    unassigned: run.state.issues.length,
    awaitingReview: run.awaitingReview,
  }, run.mode);
}

export async function openProposal(target: LabTarget, _state: ActionState, _form: FormData): Promise<ActionState> {
  if (!labEnabled()) return { error: "The AI Lab is disabled." };
  try {
    await startLabCommercial(target);
  } catch (error) {
    if (error instanceof LabError) return { error: error.message };
    console.error("Could not start the lab proposal", error);
    return { error: "The lab proposal could not be opened. Try again." };
  }
  redirect(`/lab/${target.sourceId}/proposal?run=${target.runId}`);
}
