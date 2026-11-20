import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { demoReviewerId, type AppDb } from "../db/client";
import { acceptedProposals, activityEvents, customerReplies, emailMessages, kickoffInvites, outboxJobs, quoteVersions } from "../db/schema";
import { writeSimulatedEmail, type WorkflowDb } from "../workflow/outbox";
import { responseFrom } from "../pricing/contracts";
import { pricingHash } from "../pricing/requests";
import { quoteReference, quoteThread } from "../quotes/contracts";
import { quoteMessagePrefix } from "../quotes/quote";
import { classifyCustomerReply, simulatedReply, suggestReviewIntent } from "./classification";
import { replyLabels, reviewLabels, type CustomerScenario, type ResponseAction } from "./contracts";

export class CloseoutError extends Error {}

export const maxCustomerReplyLength = 20_000;

export async function recordCloseout(db: WorkflowDb, rfpId: number, stage: string, sourceName: string, result: string, nextAction: string,
  status: typeof activityEvents.$inferInsert.status = "complete") {
  await db.insert(activityEvents).values({
    rfpId, stage, sourceName, result, nextAction, status, target: "closeout", occurredAt: new Date().toISOString(),
  }).run();
}

async function sentQuotes(db: WorkflowDb, rfpId: number) {
  return db.select({
    quote: quoteVersions, messageId: emailMessages.id, thread: emailMessages.threadKey, subject: emailMessages.subject,
  }).from(quoteVersions).innerJoin(emailMessages, and(
    eq(emailMessages.messageKey, sql`${quoteMessagePrefix} || ${quoteVersions.id}`),
    eq(emailMessages.rfpId, quoteVersions.rfpId), eq(emailMessages.direction, "outbound"),
  )).where(eq(quoteVersions.rfpId, rfpId)).orderBy(desc(quoteVersions.version)).all();
}

export async function getAcceptedProposal(db: WorkflowDb, rfpId: number) {
  return db.select().from(acceptedProposals).where(eq(acceptedProposals.rfpId, rfpId)).get();
}

async function kickoffJob(db: WorkflowDb, proposalId: number) {
  return db.select().from(outboxJobs).where(eq(outboxJobs.acceptedProposalId, proposalId)).get();
}

type Incoming = {
  rfpId: number;
  inReplyTo: number;
  messageKey: string;
  thread: string;
  sender: string;
  body: string;
};

type Suggestion = Awaited<ReturnType<typeof suggestReviewIntent>>;

export async function receiveCustomerReply(db: AppDb, incoming: Incoming, simulateFailure = false, suggestion?: Suggestion) {
  return db.transaction(async (tx) => {
    const quotes = await sentQuotes(tx, incoming.rfpId);
    const target = quotes.find(({ messageId }) => messageId === incoming.inReplyTo);
    if (!target || incoming.thread !== target.thread || incoming.thread !== quoteThread(incoming.rfpId)
      || incoming.sender !== target.quote.recipient) {
      throw new CloseoutError("The reply must match the customer and thread of a delivered quote.");
    }
    const evidence = incoming.body.trim();
    if (!evidence || incoming.body.length > maxCustomerReplyLength) {
      throw new CloseoutError("Enter a customer reply up to 20,000 characters.");
    }

    const existing = await getAcceptedProposal(tx, incoming.rfpId);
    const duplicate = await tx.select().from(emailMessages).where(eq(emailMessages.messageKey, incoming.messageKey)).get();
    if (duplicate) {
      const reply = await tx.select().from(customerReplies).where(eq(customerReplies.messageId, duplicate.id)).get();
      if (!reply || duplicate.rfpId !== incoming.rfpId || duplicate.threadKey !== incoming.thread
        || duplicate.sender !== incoming.sender || duplicate.body !== incoming.body || reply.inReplyToId !== incoming.inReplyTo) {
        throw new CloseoutError("This message reference is already used by another reply.");
      }
      return { replyId: duplicate.id, jobId: undefined };
    }

    const reference = quoteReference(incoming.rfpId, target.quote.version);
    let result = classifyCustomerReply(evidence, incoming.rfpId, target.quote.version);
    if (quotes[0].quote.id !== target.quote.id) {
      result = { intent: "superseded", explanation: "This reply targets an earlier delivered quote. Review it against the latest sent version." };
    } else if (result.intent === "unclear" && suggestion && evidence.includes(suggestion.evidence)) {
      result = { intent: suggestion.intent, explanation: `AI suggested ${replyLabels[suggestion.intent].toLowerCase()}. Confirm the meaning in review.` };
    }
    if (result.intent === "accepted") {
      if (existing) {
        result = { intent: "duplicate", explanation: "An accepted proposal and its kickoff job are already recorded for this RFP." };
      } else {
        const retired = await tx.select({ id: customerReplies.messageId }).from(customerReplies).where(and(
          eq(customerReplies.quoteVersionId, target.quote.id),
          or(eq(customerReplies.resolution, "rejected"), eq(customerReplies.resolution, "revise")),
        )).get();
        if (retired) {
          result = { intent: "unclear", explanation: "The team recorded a rejection or requested a revision for this version. Review the reply before proceeding." };
        }
      }
    }

    const now = new Date().toISOString();
    const message = await tx.insert(emailMessages).values({
      rfpId: incoming.rfpId, messageKey: incoming.messageKey, threadKey: incoming.thread,
      direction: "inbound", sender: incoming.sender, recipient: responseFrom, subject: `Re: ${target.subject}`,
      body: incoming.body, recordedAt: now,
    }).returning({ id: emailMessages.id }).get();
    await tx.insert(customerReplies).values({
      messageId: message.id, quoteVersionId: target.quote.id, inReplyToId: incoming.inReplyTo,
      intent: result.intent, evidence, explanation: result.explanation,
    }).run();

    await recordCloseout(tx, incoming.rfpId, "Classify customer reply", reference, `${replyLabels[result.intent]}. ${result.explanation}`,
      result.intent === "accepted" ? "Record the accepted terms and queue the kickoff."
        : result.intent === "duplicate" ? "Check the existing accepted proposal and kickoff."
          : "Review the customer’s original reply.",
      result.intent === "accepted" || result.intent === "duplicate" ? "complete" : "review_required");
    if (result.intent !== "accepted") return { replyId: message.id, jobId: undefined };

    const proposal = await tx.insert(acceptedProposals).values({
      rfpId: incoming.rfpId, quoteVersionId: target.quote.id, replyId: message.id, acceptedAt: now, evidence,
      recipient: target.quote.recipient, subject: target.quote.subject, body: target.quote.body, lanes: target.quote.lanes,
    }).returning({ id: acceptedProposals.id }).get();
    const job = await tx.insert(outboxJobs).values({
      rfpId: incoming.rfpId, acceptedProposalId: proposal.id, kind: "kickoff", status: "pending",
      availableAt: now, createdAt: now, simulateFailure,
    }).returning({ id: outboxJobs.id }).get();
    await recordCloseout(tx, incoming.rfpId, "Record accepted proposal and queue kickoff", reference,
      `Proposal P-${proposal.id} and ${target.quote.lanes.length} lane dispositions were saved in the database.`, "Check the simulated kickoff invitation.");
    return { replyId: message.id, jobId: job.id };
  }, { behavior: "immediate" });
}

export async function simulateCustomerReply(
  db: AppDb, rfpId: number, quoteId: number, previousReplyId: number, scenario: CustomerScenario,
  simulateFailure = false, text = "",
) {
  const delivered = await sentQuotes(db, rfpId);
  if (delivered[0]?.quote.id !== quoteId) throw new CloseoutError("Refresh before choosing a delivered quote.");
  const target = scenario === "superseded" ? delivered[1] : delivered[0];
  if (!target) throw new CloseoutError("Deliver another quote version before simulating a reply to an older one.");
  const body = scenario === "custom" ? text : simulatedReply(scenario, rfpId, target.quote.version);
  if (!body.trim() || body.length > maxCustomerReplyLength) throw new CloseoutError("Enter a customer reply up to 20,000 characters.");
  const parsed = classifyCustomerReply(body, rfpId, target.quote.version);
  const suggestion = scenario === "custom" && parsed.intent === "unclear" ? await suggestReviewIntent(body) : undefined;
  return receiveCustomerReply(db, {
    rfpId, inReplyTo: target.messageId, thread: target.thread, sender: target.quote.recipient, body,
    messageKey: `customer-reply:${target.messageId}:${previousReplyId}:${pricingHash(body)}`,
  }, simulateFailure, suggestion);
}

export async function replayAcceptance(db: AppDb, rfpId: number) {
  const proposal = await getAcceptedProposal(db, rfpId);
  if (!proposal) throw new CloseoutError("There is no recorded acceptance to replay.");
  const row = await db.select({ email: emailMessages, reply: customerReplies }).from(emailMessages)
    .innerJoin(customerReplies, eq(customerReplies.messageId, emailMessages.id))
    .where(eq(emailMessages.id, proposal.replyId)).get();
  if (!row) throw new CloseoutError("The original acceptance email is unavailable.");
  await receiveCustomerReply(db, {
    rfpId, inReplyTo: row.reply.inReplyToId, thread: row.email.threadKey, sender: row.email.sender,
    body: row.email.body, messageKey: row.email.messageKey,
  });
  await recordCloseout(db, rfpId, "Replay existing acceptance", `P-${proposal.id}`,
    "The original customer message was already processed.", "Use the existing proposal and kickoff invitation.");
}

export async function resolveCustomerReply(db: AppDb, rfpId: number, replyId: number, resolution: ResponseAction, text: string) {
  const note = text.trim();
  if (!note || note.length > 2000) throw new CloseoutError("Enter an explanation or clarification up to 2,000 characters.");
  await db.transaction(async (tx) => {
    if (await getAcceptedProposal(tx, rfpId)) throw new CloseoutError("This RFP already has a recorded acceptance.");
    const row = await tx.select({ reply: customerReplies, email: emailMessages, version: quoteVersions.version }).from(customerReplies)
      .innerJoin(emailMessages, eq(customerReplies.messageId, emailMessages.id))
      .innerJoin(quoteVersions, eq(customerReplies.quoteVersionId, quoteVersions.id))
      .where(and(eq(customerReplies.messageId, replyId), eq(emailMessages.rfpId, rfpId))).get();
    if (!row || row.reply.intent === "accepted" || row.reply.intent === "duplicate") {
      throw new CloseoutError("This reply has no review decision to record.");
    }
    if (row.reply.resolution) throw new CloseoutError("This reply already has a review decision.");
    const now = new Date().toISOString();
    if (resolution === "clarified") {
      await writeSimulatedEmail(tx, {
        rfpId, threadKey: row.email.threadKey, messageKey: `customer-clarification:${replyId}`, direction: "outbound",
        sender: responseFrom, recipient: row.email.sender, subject: row.email.subject, body: note, recordedAt: now,
      });
    }
    await tx.update(customerReplies).set({
      resolution, resolutionNote: note, reviewedAt: now, reviewerId: demoReviewerId,
    }).where(eq(customerReplies.messageId, replyId)).run();
    await recordCloseout(tx, rfpId, reviewLabels[resolution], quoteReference(rfpId, row.version), note,
      resolution === "revise" ? "Update the quote, approve a new version, and deliver it to the customer."
        : resolution === "clarified" ? "Wait for the simulated customer’s response." : "Review whether a revised proposal is needed.");
  }, { behavior: "immediate" });
}

export async function getCloseoutWorkspace(db: AppDb, rfpId: number) {
  const delivered = await sentQuotes(db, rfpId);
  const proposal = await getAcceptedProposal(db, rfpId);
  const replies = await db.select({ reply: customerReplies, message: emailMessages, version: quoteVersions.version })
    .from(customerReplies).innerJoin(emailMessages, eq(customerReplies.messageId, emailMessages.id))
    .innerJoin(quoteVersions, eq(customerReplies.quoteVersionId, quoteVersions.id))
    .where(eq(emailMessages.rfpId, rfpId)).orderBy(desc(emailMessages.id)).all();
  const clarifications = await db.select().from(emailMessages).where(and(
    eq(emailMessages.rfpId, rfpId), like(emailMessages.messageKey, "customer-clarification:%"),
  )).orderBy(desc(emailMessages.id)).all();
  const invite = proposal ? await db.select().from(kickoffInvites).where(eq(kickoffInvites.proposalId, proposal.id)).get() : undefined;
  const job = proposal ? await kickoffJob(db, proposal.id) : undefined;
  return { delivered, replies, clarifications, proposal, invite, job };
}
