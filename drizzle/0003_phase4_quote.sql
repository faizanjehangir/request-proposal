CREATE TABLE `quote_approvals` (
	`quoteVersionId` integer PRIMARY KEY NOT NULL,
	`reviewerId` text NOT NULL,
	`approvedAt` text NOT NULL,
	FOREIGN KEY (`quoteVersionId`) REFERENCES `quote_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewerId`) REFERENCES `reviewers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quote_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`version` integer NOT NULL,
	`pricingReplyId` integer NOT NULL,
	`termsHash` text NOT NULL,
	`lanes` text NOT NULL,
	`wording` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pricingReplyId`) REFERENCES `pricing_replies`(`messageId`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quote_versions_rfpId_version_unique` ON `quote_versions` (`rfpId`,`version`);--> statement-breakpoint
CREATE TABLE `__new_outbox_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`pricingRequestId` integer,
	`quoteVersionId` integer,
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
	CONSTRAINT "outbox_job_reference" CHECK(
    ("__new_outbox_jobs"."kind" = 'pricing_email' AND "__new_outbox_jobs"."pricingRequestId" IS NOT NULL AND "__new_outbox_jobs"."quoteVersionId" IS NULL)
    OR ("__new_outbox_jobs"."kind" = 'quote_email' AND "__new_outbox_jobs"."quoteVersionId" IS NOT NULL AND "__new_outbox_jobs"."pricingRequestId" IS NULL)
  )
);
--> statement-breakpoint
INSERT INTO `__new_outbox_jobs`("id", "rfpId", "pricingRequestId", "quoteVersionId", "kind", "simulateFailure", "status", "attempts", "availableAt", "leaseUntil", "leaseToken", "lastError", "createdAt", "completedAt") SELECT "id", "rfpId", "pricingRequestId", NULL, "kind", 0, "status", "attempts", "availableAt", "leaseUntil", "leaseToken", "lastError", "createdAt", "completedAt" FROM `outbox_jobs`;--> statement-breakpoint
DROP TABLE `outbox_jobs`;--> statement-breakpoint
ALTER TABLE `__new_outbox_jobs` RENAME TO `outbox_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_jobs_pricingRequestId_unique` ON `outbox_jobs` (`pricingRequestId`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_jobs_quoteVersionId_unique` ON `outbox_jobs` (`quoteVersionId`);--> statement-breakpoint
CREATE INDEX `outbox_jobs_pending` ON `outbox_jobs` (`status`,`availableAt`,`id`);