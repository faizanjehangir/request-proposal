"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/src/db/client";
import { approveQuote, createQuoteDraft, currentQuoteTerms, QuoteError } from "@/src/quotes/quote";
import { processQuoteEmail, requestQuoteDelivery, retryQuoteDelivery } from "@/src/quotes/outbox";
import { draftQuoteWording, quoteWordingSchema } from "@/src/quotes/wording";

type ActionState = { error: string | null };

async function perform(rfpId: number, operation: () => void | Promise<void>): Promise<ActionState> {
  try {
    await operation();
    revalidatePath(`/rfps/${rfpId}`);
    revalidatePath("/");
    return { error: null };
  } catch (error) {
    if (error instanceof QuoteError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Enter opening and closing text, each up to 2,000 characters." };
    console.error("Customer quote action failed", error);
    return { error: "The quote action could not be saved. Try again." };
  }
}

export async function generateQuote(rfpId: number, expectedId: number | null, _state: ActionState, _form: FormData) {
  return perform(rfpId, () => { createQuoteDraft(getDb(), rfpId, expectedId); });
}

export async function saveQuoteWording(rfpId: number, quoteId: number, _state: ActionState, form: FormData) {
  return perform(rfpId, () => {
    const wording = quoteWordingSchema.parse({ opening: form.get("opening"), closing: form.get("closing") });
    createQuoteDraft(getDb(), rfpId, quoteId, wording);
  });
}

export async function generateAiQuote(rfpId: number, expectedId: number | null, _state: ActionState, _form: FormData) {
  return perform(rfpId, async () => {
    const db = getDb();
    if (!currentQuoteTerms(db, rfpId)) throw new QuoteError("Finish routing and reconcile rates for all offers before drafting the quote.");
    createQuoteDraft(db, rfpId, expectedId, await draftQuoteWording());
  });
}

export async function approveCustomerQuote(rfpId: number, quoteId: number, _state: ActionState, _form: FormData) {
  return perform(rfpId, () => approveQuote(getDb(), rfpId, quoteId));
}

export async function sendCustomerQuote(rfpId: number, quoteId: number, _state: ActionState, form: FormData) {
  return perform(rfpId, () => {
    const db = getDb();
    processQuoteEmail(db, requestQuoteDelivery(db, rfpId, quoteId, form.get("simulateFailure") === "on"));
  });
}

export async function retryCustomerQuote(rfpId: number, quoteId: number, _state: ActionState, _form: FormData) {
  return perform(rfpId, () => {
    const db = getDb();
    const job = retryQuoteDelivery(db, rfpId, quoteId);
    if (job !== undefined) processQuoteEmail(db, job);
  });
}
