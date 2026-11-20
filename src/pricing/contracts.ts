import type { Service } from "../routing/contracts";

export type PricingScope = {
  laneId: number;
  revision: number;
  origin: string;
  destination: string;
  tons: string;
  airports: string[];
  legIds: number[];
  transitDays: string;
  requested: Service[];
  offered: Service[];
  unavailable: Service[];
};

export type RateIssue = {
  laneId: number | null;
  message: string;
  evidence?: string;
};

export const replyScenarios = ["complete", "incomplete", "conflicting", "corrected"] as const;
export type ReplyScenario = typeof replyScenarios[number];

export const pricingFrom = "pricing@example.test";
export const responseFrom = "rfp-response@example.test";
export const maxPricingReplyLength = 1_000_000;
