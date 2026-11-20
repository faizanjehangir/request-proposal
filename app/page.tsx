import Link from "next/link";
import { listRfps, recentImportActivity } from "@/src/db/queries";
import { ActivityPanel } from "./components/activity-panel";
import { formatDate } from "./components/dates";
import ImportForm from "./components/import-form";

export const dynamic = "force-dynamic";

export default async function Home() {
  const imports = await listRfps();
  const activity = await recentImportActivity();

  return (
    <>
      <div className="page-heading">
        <h1>RFP intake</h1>
        <p>Start a proposal from a shipper request or pick up an existing one.</p>
      </div>
      <div className="workspace-grid">
        <div className="stack">
          <ImportForm />
          <section className="panel" aria-labelledby="imports-title">
            <div className="section-heading heading-with-count"><h2 id="imports-title">Imported RFPs</h2><span className="count-chip">{imports.length}</span></div>
            {imports.length ? (
              <ul className="import-list">
                {imports.map((rfp) => (
                  <li key={rfp.id}>
                    <Link href={`/rfps/${rfp.id}`}>
                      <div><strong>{rfp.title}</strong><p>RFP {rfp.id} · {rfp.laneCount} lanes · <time dateTime={rfp.importedAt}>{formatDate(rfp.importedAt)}</time></p></div>
                      <span aria-hidden="true">→</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="activity-empty">No requests yet. Load the sample or import your own workbook.</p>}
          </section>
        </div>
        <ActivityPanel events={activity} overview />
      </div>
    </>
  );
}
