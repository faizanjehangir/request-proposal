import type { QuoteLane } from "../quotes/contracts";

function comparisonKey(lane: QuoteLane) {
  return `${lane.origin}:${lane.destination}`;
}

function comparableTerms(lane: QuoteLane, inventory: ReadonlyMap<number, number>) {
  const shared = { origin: lane.origin, destination: lane.destination, tons: lane.tons, disposition: lane.disposition };
  return lane.disposition === "no_offer" ? { ...shared, reason: lane.reason } : {
    ...shared,
    airports: lane.airports,
    flightRows: lane.legIds.map(id => inventory.get(id) ?? `unmapped:${id}`),
    transitDays: lane.transitDays,
    requested: [...lane.requested].sort(),
    offered: [...lane.offered].sort(),
    unavailable: [...lane.unavailable].sort(),
    amountCents: lane.amountCents,
    currency: lane.currency,
    unit: lane.unit,
  };
}

export function compareQuoteTerms(
  first: QuoteLane[], second: QuoteLane[],
  v1Inventory: ReadonlyMap<number, number>, v2Inventory: ReadonlyMap<number, number>,
) {
  const byKey = new Map(second.map(lane => [comparisonKey(lane), lane]));
  const differences: { origin: string; destination: string; v1?: QuoteLane; v2?: QuoteLane }[] = [];
  for (const v1 of first) {
    const key = comparisonKey(v1);
    const v2 = byKey.get(key);
    byKey.delete(key);
    if (!v2 || JSON.stringify(comparableTerms(v1, v1Inventory)) !== JSON.stringify(comparableTerms(v2, v2Inventory))) {
      differences.push({ origin: v1.origin, destination: v1.destination, v1, v2 });
    }
  }
  for (const v2 of byKey.values()) differences.push({ origin: v2.origin, destination: v2.destination, v2 });
  return differences;
}
