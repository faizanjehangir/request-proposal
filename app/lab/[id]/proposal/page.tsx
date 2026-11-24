import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloseoutWorkspace } from "@/src/closeout/proposals";
import { getRfp } from "@/src/db/queries";
import { getLabCommercial } from "@/src/lab/commercial";
import { labEnabled } from "@/src/lab/config";
import { getPricingWorkspace } from "@/src/pricing/replies";
import { pricingScope } from "@/src/pricing/requests";
import { getQuoteWorkspace } from "@/src/quotes/quote";
import { getRoutingReview } from "@/src/routing/review";
import { CloseoutPanel } from "../../../rfps/[id]/closeout-panel";
import { PricingPanel } from "../../../rfps/[id]/pricing-panel";
import { QuotePanel } from "../../../rfps/[id]/quote-panel";
import { RoutingPanel } from "../../../rfps/[id]/routing-panel";
import styles from "../lab.module.css";

export const dynamic = "force-dynamic";

export default async function LabProposal({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  if (!labEnabled()) notFound();
  const { id } = await params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound();
  const { run } = await searchParams;
  if (typeof run !== "string" || !/^[0-9a-f-]{36}$/i.test(run)) notFound();
  const target = { sourceId: Number(id), runId: run };
  const commercial = await getLabCommercial(target);
  if (!commercial) notFound();

  const { db, rfpId, mode } = commercial;
  const rfp = await getRfp(rfpId, db);
  if (!rfp) notFound();
  const routing = await getRoutingReview(db, rfp);
  const pricing = await getPricingWorkspace(db, rfpId, pricingScope(rfp, routing));
  const quote = await getQuoteWorkspace(db, rfp, routing, pricing);
  const closeout = await getCloseoutWorkspace(db, rfpId);
  const stages = [
    { target: "routing", title: "Lane offers", detail: `${routing.offered} offered · ${routing.pending} open` },
    { target: "pricing", title: "Pricing", detail: pricing.quoteReady ? "Rates ready" : pricing.active ? `${pricing.rates.length} rates matched` : "Ready after an offer" },
    { target: "quote", title: "Customer quote", detail: quote.job?.status === "complete" ? "Delivered" : quote.current ? `Draft v${quote.current.version}` : "Waiting for rates" },
    { target: "closeout", title: "Acceptance & kickoff", detail: closeout.invite ? "Kickoff booked" : closeout.proposal ? "Proposal accepted" : "Awaiting acceptance" },
  ];

  return <>
    <div className="page-heading">
      <Link className="back-link" href={`/lab/${id}?run=${run}`}>← Lab route board</Link>
      <div className={styles.header}>
        <div><h1>Lab proposal</h1><p>{rfp.title} · Source RFP {id} · Simulated email and calendar</p></div>
        <Link className="button" href={`/lab/${id}/compare?run=${run}`}>Compare V1 and V2</Link>
      </div>
    </div>
    <nav className={styles.proposalStages} aria-label="Lab proposal progress">
      {stages.map(stage => <a key={stage.target} href={`#${stage.target}`}><strong>{stage.title}</strong><small>{stage.detail}</small></a>)}
    </nav>
    <div className={styles.board}>
      <RoutingPanel rfp={rfp} workspace={routing} labTarget={target} />
      <PricingPanel rfpId={rfpId} workspace={pricing} labTarget={target} />
      <QuotePanel rfpId={rfpId} workspace={quote} labTarget={target} labMode={mode} />
      <CloseoutPanel rfpId={rfpId} workspace={closeout} labTarget={target} />
    </div>
  </>;
}
