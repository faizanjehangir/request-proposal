CREATE TABLE `email_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`messageKey` text NOT NULL,
	`threadKey` text NOT NULL,
	`direction` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`recordedAt` text NOT NULL,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_messageKey_unique` ON `email_messages` (`messageKey`);--> statement-breakpoint
CREATE INDEX `email_messages_by_thread` ON `email_messages` (`rfpId`,`threadKey`,`id`);--> statement-breakpoint
CREATE TABLE `outbox_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`pricingRequestId` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`availableAt` text NOT NULL,
	`leaseUntil` text,
	`leaseToken` text,
	`lastError` text,
	`createdAt` text NOT NULL,
	`completedAt` text,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pricingRequestId`) REFERENCES `pricing_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_jobs_pricingRequestId_unique` ON `outbox_jobs` (`pricingRequestId`);--> statement-breakpoint
CREATE INDEX `outbox_jobs_pending` ON `outbox_jobs` (`status`,`availableAt`,`id`);--> statement-breakpoint
CREATE TABLE `pricing_rates` (
	`replyId` integer NOT NULL,
	`laneId` integer NOT NULL,
	`amountCents` integer NOT NULL,
	`currency` text NOT NULL,
	`unit` text NOT NULL,
	`services` text NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`replyId`) REFERENCES `pricing_replies`(`messageId`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`laneId`) REFERENCES `lanes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pricing_amount_positive" CHECK("pricing_rates"."amountCents" > 0),
	CONSTRAINT "pricing_usd_per_ton" CHECK("pricing_rates"."currency" = 'USD' AND "pricing_rates"."unit" = 'ton')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pricing_rates_replyId_laneId_unique` ON `pricing_rates` (`replyId`,`laneId`);--> statement-breakpoint
CREATE TABLE `pricing_replies` (
	`messageId` integer PRIMARY KEY NOT NULL,
	`requestId` integer NOT NULL,
	`issues` text NOT NULL,
	FOREIGN KEY (`messageId`) REFERENCES `email_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requestId`) REFERENCES `pricing_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pricing_replies_by_request` ON `pricing_replies` (`requestId`,`messageId`);--> statement-breakpoint
CREATE TABLE `pricing_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`scope` text NOT NULL,
	`scopeHash` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pricing_requests_by_rfp` ON `pricing_requests` (`rfpId`,`id`);