import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/src/db/client";
import { getRoutingReview } from "@/src/routing/review";
import { getPricingWorkspace } from "@/src/pricing/replies";
import { pricingScope } from "@/src/pricing/requests";
import { getQuoteWorkspace } from "@/src/quotes/quote";
import { getCloseoutWorkspace } from "@/src/closeout/proposals";
import { CloseoutPanel } from "./closeout-panel";
import { QuotePanel } from "./quote-panel";
import { PricingPanel } from "./pricing-panel";
import { RoutingPanel } from "./routing-panel";
import { getRfp } from "@/src/db/queries";
import { ActivityPanel } from "../../components/activity-panel";
import { formatDate } from "../../components/dates";

export const dynamic = "force-dynamic";

export default async function RfpDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rfpId = Number(id);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(rfpId)) notFound();
  const db = await getDb();
  const rfp = await getRfp(rfpId, db);
  if (!rfp) notFound();
  const routing = await getRoutingReview(db, rfp);
  const pricing = await getPricingWorkspace(db, rfpId, pricingScope(rfp, routing));
  const quote = await getQuoteWorkspace(db, rfp, routing, pricing);
  const closeout = await getCloseoutWorkspace(db, rfpId);

  return (
    <>
      <div className="page-heading detail-heading">
        <Link className="back-link" href="/">RFP intake</Link>
        <h1>{rfp.title}</h1>
        <p>Imported by {rfp.reviewer} · <time dateTime={rfp.importedAt}>{formatDate(rfp.importedAt)}</time> ET</p>
      </div>
      <nav className="section-nav" aria-label="RFP details">
        <a href="#routing">Routing review</a>
        <a href="#pricing">Pricing</a>
        <a href="#quote">Customer quote</a>
        <a href="#closeout">Acceptance and kickoff</a>
        <a href="#sources">Source files</a>
        <a href="#lanes">Shipper lanes <span>{rfp.lanes.length}</span></a>
        <a href="#transit">Flight inventory <span>{rfp.flights.length}</span></a>
        <a href="#activity-title">Workflow activity</a>
      </nav>
      <div className="workspace-grid">
        <div className="stack">
          <RoutingPanel rfp={rfp} workspace={routing} />
          <PricingPanel rfpId={rfpId} workspace={pricing} />
          <QuotePanel rfpId={rfpId} workspace={quote} />
          <CloseoutPanel rfpId={rfpId} workspace={closeout} />
          <section id="sources" className="panel" aria-labelledby="sources-title">
            <div className="section-heading"><h2 id="sources-title">Source files</h2></div>
            <ul className="source-list">
              {rfp.sources.map((source) => (
                <li key={source.kind} id={source.kind === "shipper_email" ? "shipper-email-source" : undefined}>
                  <span>{source.kind === "workbook" ? "Workbook" : "Shipper email"}</span>
                  <strong>{source.name}</strong>
                  {source.emailText !== null && (
                    <details className="source-email">
                      <summary>Read original email</summary>
                      <p className="source-text">{source.emailText}</p>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section id="lanes" className="panel" aria-labelledby="lanes-title">
            <div className="section-heading">
              <h2 id="lanes-title">Shipper lanes</h2>
              <p>Open a shipper note to inspect the original wording.</p>
            </div>
            <div className="table-scroll" role="region" tabIndex={0} aria-label="Shipper lane table">
              <table>
                <thead><tr><th scope="col">Workbook row</th><th scope="col">Lane</th><th scope="col">Tons</th><th scope="col">Max days</th><th scope="col">Request text</th></tr></thead>
                <tbody>
                  {rfp.lanes.map((lane) => (
                    <tr key={lane.id} id={`shipper-row-${lane.sourceRow}`}>
                      <td>{lane.sourceRow}</td>
                      <th scope="row" className="lane-code">{lane.origin} → {lane.destination}</th>
                      <td>{lane.tons}</td>
                      <td>{lane.maxTransitDays}</td>
                      <td>{lane.shipperNote?.trim() ? (
                        <details>
                          <summary aria-label={`Read shipper note for ${lane.origin} to ${lane.destination}`}>Read note</summary>
                          <p className="source-text">{lane.shipperNote}</p>
                        </details>
                      ) : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section id="transit" className="panel" aria-labelledby="transit-title">
            <div className="section-heading">
              <h2 id="transit-title">Flight inventory</h2>
              <p>Source sheet · {rfp.snapshot.sheetName}</p>
            </div>
            <div className="table-scroll" role="region" tabIndex={0} aria-label="Flight inventory table">
              <table>
                <thead><tr><th scope="col">Workbook row</th><th scope="col">Flight leg</th><th scope="col">Transit days</th><th scope="col">Available services</th></tr></thead>
                <tbody>
                  {rfp.flights.map((leg) => (
                    <tr key={leg.id} id={`flight-row-${leg.sourceRow}`}>
                      <td>{leg.sourceRow}</td>
                      <th scope="row" className="lane-code">{leg.origin} → {leg.destination}</th>
                      <td>{leg.transitDays}</td>
                      <td>{leg.services.length ? leg.services.join(" · ") : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <ActivityPanel events={rfp.activity.toReversed()} />
      </div>
    </>
  );
}
