CREATE TABLE `lane_reviews` (
	`laneId` integer PRIMARY KEY NOT NULL,
	`extracted` text NOT NULL,
	`requirements` text,
	`assessment` text,
	`disposition` text,
	`dispositionReason` text,
	`reviewerId` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`laneId`) REFERENCES `lanes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewerId`) REFERENCES `reviewers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `routing_analyses` (
	`rfpId` integer PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`issues` text NOT NULL,
	`issuesReviewedAt` text,
	`analyzedAt` text NOT NULL,
	FOREIGN KEY (`rfpId`) REFERENCES `rfps`(`id`) ON UPDATE no action ON DELETE no action
);
