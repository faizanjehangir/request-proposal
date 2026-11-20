import type { ReplyIntent, ResponseAction } from "../closeout/contracts";
import type { QuoteLane, QuoteWording } from "../quotes/contracts";
import type { PricingScope, RateIssue } from "../pricing/contracts";
import type { Disposition, ExtractedLane, RequirementIssue, RouteAssessment, Service } from "../routing/contracts";
import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export type ImportIssue = {
  source: string;
  row?: number;
  field?: string;
  message: string;
};

export const reviewers = sqliteTable("reviewers", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
});

export const rfps = sqliteTable("rfps", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  reviewerId: text().notNull().references(() => reviewers.id),
  importedAt: text().notNull(),
});

export const sourceFiles = sqliteTable("source_files", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().references(() => rfps.id),
  kind: text({ enum: ["workbook", "shipper_email"] }).notNull(),
  name: text().notNull(),
  content: blob({ mode: "buffer" }).notNull(),
  emailText: text(),
}, (table) => [
  unique().on(table.rfpId, table.kind),
  check("source_kind_and_text", sql`
    (${table.kind} = 'workbook' AND ${table.emailText} IS NULL)
    OR (${table.kind} = 'shipper_email' AND ${table.emailText} IS NOT NULL)
  `),
]);

export const lanes = sqliteTable("lanes", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().references(() => rfps.id),
  sourceRow: integer().notNull(),
  origin: text().notNull(),
  destination: text().notNull(),
  tons: text().notNull(),
  maxTransitDays: text().notNull(),
  shipperNote: text(),
}, (table) => [
  unique().on(table.rfpId, table.origin, table.destination),
  unique().on(table.rfpId, table.sourceRow),
]);

export const transitSnapshots = sqliteTable("transit_snapshots", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().unique().references(() => rfps.id),
  sourceFileId: integer().notNull().references(() => sourceFiles.id),
  sheetName: text().notNull(),
});

export const flightLegs = sqliteTable("flight_legs", {
  id: integer().primaryKey({ autoIncrement: true }),
  snapshotId: integer().notNull().references(() => transitSnapshots.id),
  sourceRow: integer().notNull(),
  origin: text().notNull(),
  destination: text().notNull(),
  transitDays: text().notNull(),
  services: text({ mode: "json" }).$type<string[]>().notNull(),
}, (table) => [unique().on(table.snapshotId, table.sourceRow)]);

export const activityEvents = sqliteTable("activity_events", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().references(() => rfps.id),
  stage: text().notNull(),
  status: text({ enum: ["complete", "failed", "review_required"] }).notNull(),
  sourceName: text().notNull(),
  target: text({ enum: ["sources", "lanes", "transit", "routing", "pricing", "quote", "closeout"] }),
  result: text().notNull(),
  nextAction: text().notNull(),
  occurredAt: text().notNull(),
  issues: text({ mode: "json" }).$type<ImportIssue[]>(),
}, (table) => [index("activity_events_by_rfp").on(table.rfpId, table.id)]);


export const routingAnalyses = sqliteTable("routing_analyses", {
  rfpId: integer().primaryKey().references(() => rfps.id),
  mode: text({ enum: ["fixture", "openai"] }).notNull(),
  issues: text({ mode: "json" }).$type<RequirementIssue[]>().notNull(),
  issuesReviewedAt: text(),
  analyzedAt: text().notNull(),
});

export const laneReviews = sqliteTable("lane_reviews", {
  laneId: integer().primaryKey().references(() => lanes.id),
  extracted: text({ mode: "json" }).$type<ExtractedLane>().notNull(),
  requirements: text({ mode: "json" }).$type<Service[]>(),
  assessment: text({ mode: "json" }).$type<RouteAssessment>(),
  disposition: text().$type<Disposition>(),
  dispositionReason: text(),
  reviewerId: text().references(() => reviewers.id),
  revision: integer().notNull().default(0),
  updatedAt: text().notNull(),
});

export const pricingRequests = sqliteTable("pricing_requests", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().references(() => rfps.id),
  scope: text({ mode: "json" }).$type<PricingScope[]>().notNull(),
  scopeHash: text().notNull(),
  createdAt: text().notNull(),
}, (table) => [index("pricing_requests_by_rfp").on(table.rfpId, table.id)]);

export const emailMessages = sqliteTable("email_messages", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().references(() => rfps.id),
  messageKey: text().notNull().unique(),
  threadKey: text().notNull(),
  direction: text({ enum: ["inbound", "outbound"] }).notNull(),
  sender: text().notNull(),
  recipient: text().notNull(),
  subject: text().notNull(),
  body: text().notNull(),
  recordedAt: text().notNull(),
}, (table) => [index("email_messages_by_thread").on(table.rfpId, table.threadKey, table.id)]);

export const pricingReplies = sqliteTable("pricing_replies", {
  messageId: integer().primaryKey().references(() => emailMessages.id),
  requestId: integer().notNull().references(() => pricingRequests.id),
  issues: text({ mode: "json" }).$type<RateIssue[]>().notNull(),
}, (table) => [index("pricing_replies_by_request").on(table.requestId, table.messageId)]);

export const pricingRates = sqliteTable("pricing_rates", {
  replyId: integer().notNull().references(() => pricingReplies.messageId),
  laneId: integer().notNull().references(() => lanes.id),
  amountCents: integer().notNull(),
  currency: text({ enum: ["USD"] }).notNull(),
  unit: text({ enum: ["ton"] }).notNull(),
  services: text({ mode: "json" }).$type<Service[]>().notNull(),
  evidence: text().notNull(),
}, (table) => [
  unique().on(table.replyId, table.laneId),
  check("pricing_amount_positive", sql`${table.amountCents} > 0`),
  check("pricing_usd_per_ton", sql`${table.currency} = 'USD' AND ${table.unit} = 'ton'`),
]);

export const quoteVersions = sqliteTable("quote_versions", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().references(() => rfps.id),
  version: integer().notNull(),
  pricingReplyId: integer().notNull().references(() => pricingReplies.messageId),
  termsHash: text().notNull(),
  lanes: text({ mode: "json" }).$type<QuoteLane[]>().notNull(),
  wording: text({ mode: "json" }).$type<QuoteWording>().notNull(),
  recipient: text().notNull(),
  subject: text().notNull(),
  body: text().notNull(),
  createdAt: text().notNull(),
}, (table) => [unique().on(table.rfpId, table.version)]);

export const quoteApprovals = sqliteTable("quote_approvals", {
  quoteVersionId: integer().primaryKey().references(() => quoteVersions.id),
  reviewerId: text().notNull().references(() => reviewers.id),
  approvedAt: text().notNull(),
});

export const customerReplies = sqliteTable("customer_replies", {
  messageId: integer().primaryKey().references(() => emailMessages.id),
  quoteVersionId: integer().notNull().references(() => quoteVersions.id),
  inReplyToId: integer().notNull().references(() => emailMessages.id),
  intent: text().$type<ReplyIntent>().notNull(),
  evidence: text().notNull(),
  explanation: text().notNull(),
  resolution: text().$type<ResponseAction>(),
  resolutionNote: text(),
  reviewedAt: text(),
  reviewerId: text().references(() => reviewers.id),
}, (table) => [index("customer_replies_by_quote").on(table.quoteVersionId, table.messageId)]);

export const acceptedProposals = sqliteTable("accepted_proposals", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().unique().references(() => rfps.id),
  quoteVersionId: integer().notNull().unique().references(() => quoteVersions.id),
  replyId: integer().notNull().unique().references(() => customerReplies.messageId),
  acceptedAt: text().notNull(),
  recipient: text().notNull(),
  subject: text().notNull(),
  body: text().notNull(),
  evidence: text().notNull(),
  lanes: text({ mode: "json" }).$type<QuoteLane[]>().notNull(),
});

export const kickoffInvites = sqliteTable("kickoff_invites", {
  proposalId: integer().primaryKey().references(() => acceptedProposals.id),
  providerId: text().notNull().unique(),
  title: text().notNull(),
  startAt: text().notNull(),
  endAt: text().notNull(),
  timezone: text().notNull(),
  attendees: text({ mode: "json" }).$type<string[]>().notNull(),
  bookedAt: text().notNull(),
});

export const outboxJobs = sqliteTable("outbox_jobs", {
  id: integer().primaryKey({ autoIncrement: true }),
  rfpId: integer().notNull().references(() => rfps.id),
  pricingRequestId: integer().unique().references(() => pricingRequests.id),
  quoteVersionId: integer().unique().references(() => quoteVersions.id),
  acceptedProposalId: integer().unique().references(() => acceptedProposals.id),
  kind: text({ enum: ["pricing_email", "quote_email", "kickoff"] }).notNull(),
  simulateFailure: integer({ mode: "boolean" }).notNull().default(false),
  status: text({ enum: ["pending", "running", "complete", "failed", "canceled"] }).notNull(),
  attempts: integer().notNull().default(0),
  availableAt: text().notNull(),
  leaseUntil: text(),
  leaseToken: text(),
  lastError: text(),
  createdAt: text().notNull(),
  completedAt: text(),
}, (table) => [
  index("outbox_jobs_pending").on(table.status, table.availableAt, table.id),
  check("outbox_job_reference", sql`
    (${table.kind} = 'pricing_email' AND ${table.pricingRequestId} IS NOT NULL AND ${table.quoteVersionId} IS NULL AND ${table.acceptedProposalId} IS NULL)
    OR (${table.kind} = 'quote_email' AND ${table.quoteVersionId} IS NOT NULL AND ${table.pricingRequestId} IS NULL AND ${table.acceptedProposalId} IS NULL)
    OR (${table.kind} = 'kickoff' AND ${table.acceptedProposalId} IS NOT NULL AND ${table.pricingRequestId} IS NULL AND ${table.quoteVersionId} IS NULL)
  `),
]);
