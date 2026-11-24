import { getDb } from "@/src/db/client";
import { getRfp } from "@/src/db/queries";
import { getLabCommercial } from "@/src/lab/commercial";
import type { LabTarget } from "@/src/lab/commercial-target";
import { compareQuoteTerms } from "@/src/lab/quote-parity";
import { LabError, type LabRfp } from "@/src/lab/runs";
import { formatUsd } from "@/src/pricing/rates";
import type { QuoteLane } from "@/src/quotes/contracts";
import { latestQuote } from "@/src/quotes/quote";

function quoteSummary(lane?: QuoteLane) {
  if (!lane) return "Lane missing";
  if (lane.disposition === "no_offer") return `No offer · ${lane.reason}`;
  return `${lane.airports.join(" → ")} · ${lane.transitDays} days · USD ${formatUsd(lane.amountCents)}/ton · ${lane.offered.join(", ") || "Standard handling"}${lane.unavailable.length ? ` · Unavailable: ${lane.unavailable.join(", ")}` : ""}`;
}

export async function QuoteComparison({ source, target }: { source: LabRfp; target: LabTarget }) {
  let context: Awaited<ReturnType<typeof getLabCommercial>>;
  try {
    context = await getLabCommercial(target);
  } catch (error) {
    if (error instanceof LabError) return null;
    throw error;
  }
  if (!context) return null;
  const v1 = await latestQuote(await getDb(), source.id);
  const v2 = await latestQuote(context.db, context.rfpId);
  const paired = v1 && v2 ? await getRfp(context.rfpId, context.db) : null;
  const differences = v1 && v2 && paired ? compareQuoteTerms(v1.lanes, v2.lanes,
    new Map(source.flights.map(leg => [leg.id, leg.sourceRow])),
    new Map(paired.flights.map(leg => [leg.id, leg.sourceRow]))) : null;

  return <section className="panel pricing-note" aria-labelledby="commercial-comparison">
    <div className="section-heading"><h2 id="commercial-comparison">Quote terms comparison</h2>
      <p>Latest saved versions · V1 {v1 ? `v${v1.version}` : "pending"} · V2 {v2 ? `v${v2.version}` : "pending"}</p>
    </div>
    {differences === null ? <p className="muted">Create a quote in both workflows to compare commercial terms.</p>
      : differences.length === 0 ? <p className="routing-status" data-tone="success">Commercial terms match for all {v1?.lanes.length} lanes.</p>
        : <>
          <p className="routing-status" data-tone="attention">{differences.length} lanes have different commercial terms.</p>
          <div className="table-scroll pricing-note" role="region" aria-label="Quote term differences" tabIndex={0}>
            <table><thead><tr><th>Lane</th><th>V1 terms</th><th>V2 terms</th></tr></thead>
              <tbody>{differences.map(lane => <tr key={`${lane.origin}:${lane.destination}`}>
                <th scope="row">{lane.origin} → {lane.destination}</th>
                <td>{quoteSummary(lane.v1)}</td><td>{quoteSummary(lane.v2)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
  </section>;
}
