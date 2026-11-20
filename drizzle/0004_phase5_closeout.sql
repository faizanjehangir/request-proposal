CREATE TABLE `accepted_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`quoteVersionId` integer NOT NULL,
	`replyId` integer NOT NULL,
	`acceptedAt` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`evidence` text NOT NULL,
	`lanes` text NOT NULL,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quoteVersionId`) REFERENCES `quote_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replyId`) REFERENCES `customer_replies`(`messageId`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accepted_proposals_rfpId_unique` ON `accepted_proposals` (`rfpId`);--> statement-breakpoint
CREATE UNIQUE INDEX `accepted_proposals_quoteVersionId_unique` ON `accepted_proposals` (`quoteVersionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `accepted_proposals_replyId_unique` ON `accepted_proposals` (`replyId`);--> statement-breakpoint
CREATE TABLE `customer_replies` (
	`messageId` integer PRIMARY KEY NOT NULL,
	`quoteVersionId` integer NOT NULL,
	`inReplyToId` integer NOT NULL,
	`intent` text NOT NULL,
	`evidence` text NOT NULL,
	`explanation` text NOT NULL,
	`resolution` text,
	`resolutionNote` text,
	`reviewedAt` text,
	`reviewerId` text,
	FOREIGN KEY (`messageId`) REFERENCES `email_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quoteVersionId`) REFERENCES `quote_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inReplyToId`) REFERENCES `email_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewerId`) REFERENCES `reviewers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `customer_replies_by_quote` ON `customer_replies` (`quoteVersionId`,`messageId`);--> statement-breakpoint
CREATE TABLE `kickoff_invites` (
	`proposalId` integer PRIMARY KEY NOT NULL,
	`providerId` text NOT NULL,
	`title` text NOT NULL,
	`startAt` text NOT NULL,
	`endAt` text NOT NULL,
	`timezone` text NOT NULL,
	`attendees` text NOT NULL,
	`bookedAt` text NOT NULL,
	FOREIGN KEY (`proposalId`) REFERENCES `accepted_proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kickoff_invites_providerId_unique` ON `kickoff_invites` (`providerId`);--> statement-breakpoint
CREATE TABLE `__new_outbox_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`pricingRequestId` integer,
	`quoteVersionId` integer,
	`acceptedProposalId` integer,
	`kind` text NOT NULL,
	`simulateFailure` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`availableAt` text NOT NULL,
	`leaseUntil` text,
	`leaseToken` text,
	`lastError` text,
	`createdAt` text NOT NULL,
	`completedAt` text,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pricingRequestId`) REFERENCES `pricing_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`quoteVersionId`) REFERENCES `quote_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acceptedProposalId`) REFERENCES `accepted_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_job_reference" CHECK(
    ("__new_outbox_jobs"."kind" = 'pricing_email' AND "__new_outbox_jobs"."pricingRequestId" IS NOT NULL AND "__new_outbox_jobs"."quoteVersionId" IS NULL AND "__new_outbox_jobs"."acceptedProposalId" IS NULL)
    OR ("__new_outbox_jobs"."kind" = 'quote_email' AND "__new_outbox_jobs"."quoteVersionId" IS NOT NULL AND "__new_outbox_jobs"."pricingRequestId" IS NULL AND "__new_outbox_jobs"."acceptedProposalId" IS NULL)
    OR ("__new_outbox_jobs"."kind" = 'kickoff' AND "__new_outbox_jobs"."acceptedProposalId" IS NOT NULL AND "__new_outbox_jobs"."pricingRequestId" IS NULL AND "__new_outbox_jobs"."quoteVersionId" IS NULL)
  )
);
--> statement-breakpoint
INSERT INTO `__new_outbox_jobs`("id", "rfpId", "pricingRequestId", "quoteVersionId", "acceptedProposalId", "kind", "simulateFailure", "status", "attempts", "availableAt", "leaseUntil", "leaseToken", "lastError", "createdAt", "completedAt") SELECT "id", "rfpId", "pricingRequestId", "quoteVersionId", NULL, "kind", "simulateFailure", "status", "attempts", "availableAt", "leaseUntil", "leaseToken", "lastError", "createdAt", "completedAt" FROM `outbox_jobs`;--> statement-breakpoint
DROP TABLE `outbox_jobs`;--> statement-breakpoint
ALTER TABLE `__new_outbox_jobs` RENAME TO `outbox_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_jobs_pricingRequestId_unique` ON `outbox_jobs` (`pricingRequestId`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_jobs_quoteVersionId_unique` ON `outbox_jobs` (`quoteVersionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_jobs_acceptedProposalId_unique` ON `outbox_jobs` (`acceptedProposalId`);--> statement-breakpoint
CREATE INDEX `outbox_jobs_pending` ON `outbox_jobs` (`status`,`availableAt`,`id`);