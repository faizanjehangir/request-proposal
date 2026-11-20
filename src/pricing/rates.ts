import { inventoryServices, type Service } from "../routing/contracts";
import { type PricingScope, type RateIssue, type ReplyScenario } from "./contracts";

export function laneName(scope: PricingScope) {
  return `${scope.origin} → ${scope.destination}`;
}

export function serviceDescription(labels: Service[]) {
  return labels.join(", ") || "Standard handling only";
}

const dollars = new Intl.NumberFormat("en-US");
export function formatUsd(cents: number) {
  const exact = BigInt(cents);
  return `${dollars.format(exact / 100n)}.${String(exact % 100n).padStart(2, "0")}`;
}

export function mockPricingReply(scope: PricingScope[], scenario: Exclude<ReplyScenario, "corrected">) {
  const example = scope.find((lane) => lane.origin === "GRU" && lane.destination === "SIN") ?? scope[0];
  function sentence(lane: PricingScope, conflict = false) {
    const rate = lane.origin === "GRU" && lane.destination === "SIN" ? 224000
      : lane.origin === "MEX" && lane.destination === "CDG" ? 184000
      : (1200 + lane.laneId % 41 * 25) * 100;
    const pricedServices = lane.offered.length ? `including ${serviceDescription(lane.offered)}` : "for standard handling only";
    return `For ${lane.origin} to ${lane.destination}, I recommend USD ${formatUsd(rate + (conflict ? 12500 : 0))} per ton, ${pricedServices}.`;
  }
  const lines = scope.filter((lane) => scenario !== "incomplete" || lane !== example).map((lane) => sentence(lane));
  if (scenario === "incomplete") lines.push(`I’m still checking ${example.origin} to ${example.destination}.`);
  if (scenario === "conflicting") lines.push(sentence(example, true));
  return ["Hi RFP team,", "", "Here are my recommendations for the quoted routes and tonnage.", "", ...lines, "", "Thanks,", "Pricing"].join("\n");
}

const lanePattern = /\b([a-z]{3})\s*(?:\bto\b|->|→|[-–—/])\s*([a-z]{3})\b/gi;
const ratePattern = /\b([A-Z]{3})[ \t]+([+-]?[\d.,]+)(?=[ \t/]|$)/gi;
const unitPattern = /^(?:\s+per\s+ton\b|\s*\/\s*ton\b)/i;
const standardPattern = /^(?:for\s+)?(?:standard (?:cargo|handling)(?: only)?|general cargo(?: only)?|no special services)$/i;

function usdCents(value: string) {
  const matched = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!matched || value.length > 22) return null;
  const cents = BigInt(matched[1].replaceAll(",", "")) * 100n + BigInt((matched[2] ?? "").padEnd(2, "0"));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

type MatchedRate = {
  laneId: number;
  amountCents: number;
  currency: "USD";
  unit: "ton";
  services: Service[];
  evidence: string;
};

function serviceScope(text: string) {
  const description = text.replace(/^(?:\s|[,;:])+|[.!?\s]+$/g, "");
  if (standardPattern.test(description)) return [];
  if (!/^including\s/i.test(description)) return null;

  const labels = description.replace(/^including\s+/i, "").split(/\s*,\s*|\s+and\s+/i);
  const normalized = labels.map((label) => inventoryServices([label])[0]);
  return normalized.every(Boolean) ? [...new Set(normalized)].sort() : null;
}

export function reconcileRates(scope: PricingScope[], body: string, excerpts?: string[]) {
  const requested = new Map(scope.map((lane) => [`${lane.origin}:${lane.destination}`, lane]));
  const rates = new Map<number, MatchedRate>();
  const blocked = new Set<number>();
  const issues: RateIssue[] = [];

  const lines = excerpts?.every((line) => body.includes(line)) ? excerpts : body.split(/\r?\n/);
  for (const line of lines) {
    const evidence = line.trim();
    if (!evidence) continue;
    const candidateText = evidence.replace(/\s*\r?\n\s*/g, " ");
    const amounts = [...candidateText.matchAll(ratePattern)].filter((candidate) =>
      /^(?:USD|CAD|EUR|GBP|JPY|CHF|AUD|CNY|HKD|SGD|MXN|BRL)$/i.test(candidate[1])
      || unitPattern.test(candidateText.slice((candidate.index ?? 0) + candidate[0].length)));
    const looksLikeRate = amounts.length || /\$\s*\d|\d\s*(?:per\s+ton|\/\s*ton)\b/i.test(candidateText);
    if (!looksLikeRate) continue;
    const directions = [...new Set([...candidateText.matchAll(lanePattern)].map(([, origin, destination]) =>
      `${origin.toUpperCase()}:${destination.toUpperCase()}`))];
    const lane = directions.length === 1 ? requested.get(directions[0]) : undefined;
    if (!lane) {
      issues.push({ laneId: null, message: directions.length === 1
        ? `${directions[0].replace(":", " → ")} was outside this request.`
        : "Could not match this rate to one requested lane.", evidence });
      continue;
    }

    const flag = (message: string) => { issues.push({ laneId: lane.laneId, message, evidence }); blocked.add(lane.laneId); };
    if (/\b(?:tentative|estimate only|do not use|subject to|disregard)\b/i.test(candidateText)) {
      flag("Confirm the provisional or qualified Pricing amount.");
      continue;
    }
    if (amounts.length !== 1 || amounts[0][1].toUpperCase() !== "USD") {
      flag("Use one explicit USD amount per recommendation.");
      continue;
    }
    const amount = amounts[0];
    const amountCents = usdCents(amount[2]);
    const afterAmount = candidateText.slice((amount.index ?? 0) + amount[0].length);
    const unit = unitPattern.exec(afterAmount);
    if (amountCents === null || !unit) {
      flag("Use a positive USD amount with at most two decimal places and an explicit per-ton unit.");
      continue;
    }
    const tonnageMentioned = [...candidateText.matchAll(/\b(\d[\d.,]*)\s+tons\b/gi)].map(([, raw]) => {
      const [whole, fraction = ""] = raw.replaceAll(",", "").split(".");
      const decimal = fraction.replace(/0+$/, "");
      return `${whole.replace(/^0+(?=\d)/, "")}${decimal ? `.${decimal}` : ""}`;
    });
    const connectionsMentioned = [...candidateText.matchAll(/\bvia\s+([a-z]{3})\b/gi)]
      .map(([, airport]) => airport.toUpperCase());
    if (tonnageMentioned.some((tons) => tons !== lane.tons)
      || (connectionsMentioned.length > 0 && connectionsMentioned.join("|") !== lane.airports.slice(1, -1).join("|"))
      || (/\bdirect\b/i.test(candidateText) && lane.airports.length > 2)) {
      flag("Route or tonnage does not match the request.");
      continue;
    }
    const offered = serviceScope(afterAmount.slice(unit[0].length));
    if (!offered || offered.join("|") !== [...lane.offered].sort().join("|")) {
      flag(`Service scope does not match the request. Expected ${serviceDescription(lane.offered)}.`);
      continue;
    }
    const previous = rates.get(lane.laneId);
    if (previous && previous.amountCents !== amountCents) {
      flag("Pricing gave conflicting amounts for this lane.");
      continue;
    }
    if (!previous) rates.set(lane.laneId, { laneId: lane.laneId, amountCents, currency: "USD", unit: "ton", services: offered, evidence });
  }

  for (const lane of scope) {
    if (blocked.has(lane.laneId)) rates.delete(lane.laneId);
    else if (!rates.has(lane.laneId)) issues.push({ laneId: lane.laneId, message: "Missing rate for this lane." });
  }
  return { rates: [...rates.values()], issues };
}
