"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { commercialContext, commercialModel, commercialPath, CommercialContextError, type CommercialTarget } from "@/src/lab/commercial-target";
import type { AppDb } from "@/src/db/client";
import { approveQuote, createQuoteDraft, currentQuoteTerms, QuoteError } from "@/src/quotes/quote";
import { processQuoteEmail, requestQuoteDelivery, retryQuoteDelivery } from "@/src/quotes/outbox";
import { draftQuoteWording, quoteWordingSchema } from "@/src/quotes/wording";

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
    if (error instanceof QuoteError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Enter opening and closing text, each up to 2,000 characters." };
    console.error("Customer quote action failed", error);
    return { error: "The quote action could not be saved. Try again." };
  }
}

export async function generateQuote(target: CommercialTarget, expectedId: number | null, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => { await createQuoteDraft(db, rfpId, expectedId); });
}

export async function saveQuoteWording(target: CommercialTarget, quoteId: number, _state: ActionState, form: FormData) {
  return perform(target, async (db, rfpId) => {
    const wording = quoteWordingSchema.parse({ opening: form.get("opening"), closing: form.get("closing") });
    await createQuoteDraft(db, rfpId, quoteId, wording);
  });
}

export async function generateAiQuote(target: CommercialTarget, expectedId: number | null, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId, mode) => {
    if (!await currentQuoteTerms(db, rfpId)) throw new QuoteError("Finish routing and reconcile rates for all offers before drafting the quote.");
    await createQuoteDraft(db, rfpId, expectedId, await draftQuoteWording(commercialModel(mode)));
  });
}

export async function approveCustomerQuote(target: CommercialTarget, quoteId: number, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => approveQuote(db, rfpId, quoteId));
}

export async function sendCustomerQuote(target: CommercialTarget, quoteId: number, _state: ActionState, form: FormData) {
  return perform(target, async (db, rfpId) => {
    await processQuoteEmail(db, await requestQuoteDelivery(db, rfpId, quoteId, form.get("simulateFailure") === "on"));
  });
}

export async function retryCustomerQuote(target: CommercialTarget, quoteId: number, _state: ActionState, _form: FormData) {
  return perform(target, async (db, rfpId) => {
    const job = await retryQuoteDelivery(db, rfpId, quoteId);
    if (job !== undefined) await processQuoteEmail(db, job);
  });
}
