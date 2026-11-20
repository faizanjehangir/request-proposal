import Link from "next/link";
import { listRfps, recentImportActivity } from "@/src/db/queries";
import { ActivityPanel } from "./components/activity-panel";
import { formatDate } from "./components/dates";
import ImportForm from "./components/import-form";

export const dynamic = "force-dynamic";

export default function Home() {
  const imports = listRfps();
  const activity = recentImportActivity();

  return (
    <>
      <div className="page-heading">
        <h1>RFP intake</h1>
        <p>Import shipper lanes and the carrier’s flight inventory.</p>
      </div>
      <div className="workspace-grid">
        <div className="stack">
          <ImportForm />
          <section className="panel" aria-labelledby="imports-title">
            <div className="section-heading"><h2 id="imports-title">Imported RFPs</h2></div>
            {imports.length ? (
              <ul className="import-list">
                {imports.map((rfp) => (
                  <li key={rfp.id}>
                    <Link href={`/rfps/${rfp.id}`}>{rfp.title}</Link>
                    <p>{rfp.laneCount} lanes · {rfp.flightCount} flight legs · <time dateTime={rfp.importedAt}>{formatDate(rfp.importedAt)}</time></p>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">Your imported requests will appear here.</p>}
          </section>
        </div>
        <ActivityPanel events={activity} overview />
      </div>
    </>
  );
}
