import { z } from "zod";

export const customerScenarios = ["full", "partial", "counteroffer", "rejection", "unclear", "superseded", "custom"] as const;
export const customerScenario = z.enum(customerScenarios);
export type CustomerScenario = z.infer<typeof customerScenario>;

export const replyLabels = {
  accepted: "Full acceptance",
  partial: "Partial acceptance",
  counteroffer: "Counteroffer",
  rejection: "Rejection",
  unclear: "Ambiguous reply",
  superseded: "Reply to superseded quote",
  duplicate: "Acceptance already recorded",
} as const;
export type ReplyIntent = keyof typeof replyLabels;

export const responseAction = z.enum(["rejected", "clarified", "revise"]);
export type ResponseAction = z.infer<typeof responseAction>;

export const reviewLabels: Record<ResponseAction, string> = {
  rejected: "Rejection recorded",
  clarified: "Clarification sent",
  revise: "Revision requested",
};
