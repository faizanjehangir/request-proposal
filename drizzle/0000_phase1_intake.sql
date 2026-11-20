CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`sourceName` text NOT NULL,
	`target` text,
	`result` text NOT NULL,
	`nextAction` text NOT NULL,
	`occurredAt` text NOT NULL,
	`issues` text,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_events_by_rfp` ON `activity_events` (`rfpId`,`id`);--> statement-breakpoint
CREATE TABLE `flight_legs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshotId` integer NOT NULL,
	`sourceRow` integer NOT NULL,
	`origin` text NOT NULL,
	`destination` text NOT NULL,
	`transitDays` text NOT NULL,
	`services` text NOT NULL,
	FOREIGN KEY (`snapshotId`) REFERENCES `transit_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flight_legs_snapshotId_sourceRow_unique` ON `flight_legs` (`snapshotId`,`sourceRow`);--> statement-breakpoint
CREATE TABLE `lanes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`sourceRow` integer NOT NULL,
	`origin` text NOT NULL,
	`destination` text NOT NULL,
	`tons` text NOT NULL,
	`maxTransitDays` text NOT NULL,
	`shipperNote` text,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lanes_rfpId_origin_destination_unique` ON `lanes` (`rfpId`,`origin`,`destination`);--> statement-breakpoint
CREATE UNIQUE INDEX `lanes_rfpId_sourceRow_unique` ON `lanes` (`rfpId`,`sourceRow`);--> statement-breakpoint
CREATE TABLE `reviewers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rfps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`reviewerId` text NOT NULL,
	`importedAt` text NOT NULL,
	FOREIGN KEY (`reviewerId`) REFERENCES `reviewers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `source_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content` blob NOT NULL,
	`emailText` text,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "source_kind_and_text" CHECK(
    ("source_files"."kind" = 'workbook' AND "source_files"."emailText" IS NULL)
    OR ("source_files"."kind" = 'shipper_email' AND "source_files"."emailText" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_files_rfpId_kind_unique` ON `source_files` (`rfpId`,`kind`);--> statement-breakpoint
CREATE TABLE `transit_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rfpId` integer NOT NULL,
	`sourceFileId` integer NOT NULL,
	`sheetName` text NOT NULL,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sourceFileId`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transit_snapshots_rfpId_unique` ON `transit_snapshots` (`rfpId`);