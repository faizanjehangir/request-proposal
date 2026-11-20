import type { Service } from "../routing/contracts";
import type { PricingScope } from "../pricing/contracts";

type QuoteLaneBase = {
  laneId: number;
  origin: string;
  destination: string;
  tons: string;
};

export type QuoteLane = (QuoteLaneBase & { disposition: "no_offer"; reason: string })
  | (Omit<PricingScope, "revision"> & { disposition: "offer" | "alternative"; amountCents: number; currency: "USD"; unit: "ton" });

export type QuoteWording = { opening: string; closing: string };
export const defaultQuoteWording: QuoteWording = {
  opening: "Hello,\n\nThank you for your request. Please find our air freight proposal below.",
  closing: "Please reply to this email to confirm whether you accept the offered lanes in this version.\n\nRFP Response Team",
};

export const customerMailbox = "shipper@example.test";
export const quoteThread = (rfpId: number) => `customer-quote:${rfpId}`;
export const quoteReference = (rfpId: number, version: number) => `RFP-${rfpId} · v${version}`;

export function describeServices(services: Service[], empty = "None") {
  return services.join(", ") || empty;
}
