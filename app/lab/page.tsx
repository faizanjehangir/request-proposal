import Link from "next/link";
import { notFound } from "next/navigation";
import { listRfps } from "@/src/db/queries";
import { labEnabled } from "@/src/lab/config";

export const dynamic = "force-dynamic";

export default async function LabIndex() {
  if (!labEnabled()) notFound();
  const imports = await listRfps();
  return (
    <>
      <div className="page-heading">
        <Link className="back-link" href="/">← RFP intake</Link>
        <h1>AI Lab</h1>
        <p>Choose an imported RFP to practice reviewing extracted requirements and comparing flight routes.</p>
      </div>
      <section className="panel" aria-labelledby="lab-rfps">
        <div className="section-heading"><h2 id="lab-rfps">Available RFPs</h2></div>
        {imports.length ? <ul className="import-list">
          {imports.map(rfp => <li key={rfp.id}>
            <Link href={`/lab/${rfp.id}`}>{rfp.title} · RFP {rfp.id} · {rfp.laneCount} lanes <span aria-hidden="true">→</span></Link>
          </li>)}
        </ul> : <p><Link href="/">Import or load a sample RFP</Link> to start.</p>}
      </section>
    </>
  );
}
