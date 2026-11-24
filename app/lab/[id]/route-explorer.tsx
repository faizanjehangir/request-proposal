import type { LaneRoute } from "@/src/lab/workflow";
import { matchesRoute, type LabLane, type RouteFilter } from "@/src/lab/route-view";
import { routeLabels, type AssessedPath } from "@/src/routing/contracts";
import styles from "./lab.module.css";

const labels: Record<RouteFilter, string> = { all: "All lanes", ...routeLabels, blocked: "No offer eligible" };
const filters = ["all", "compliant", "service_gap", "over_limit", "unreachable", "blocked"] as const;
const pageSize = 6;

function Itinerary({ path, label, tone }: { path: AssessedPath; label: string; tone: "good" | "warning" | "blocked" }) {
  return <div className={styles.itinerary}>
    <p className={styles.itineraryTitle}><span className={styles.badge} data-tone={tone}>{label}</span><strong>{path.totalDays} days</strong></p>
    <ol className={styles.legs} aria-label={`${label} flight legs`}>
      {path.legs.map(leg => <li key={leg.id} data-tone={leg.missing.length ? "warning" : "good"}>
        <details>
          <summary>
            <span className={styles.flight}>{leg.origin} → {leg.destination}</span>
            <span>{leg.transitDays}d · {leg.missing.length ? `Missing ${leg.missing.join(", ")}` : "Services met"}</span>
          </summary>
          <p>Transit row {leg.sourceRow} · {leg.services.join(", ") || "Standard handling"}</p>
        </details>
      </li>)}
    </ol>
  </div>;
}

function LaneRow({ lane, route }: { lane: LabLane; route: LaneRoute }) {
  const { assessment, fasterWithGap } = route;
  const { path, fullServicePath, status } = assessment;
  const alternate = fullServicePath && path && fullServicePath.legs.map(leg => leg.id).join() !== path.legs.map(leg => leg.id).join()
    ? fullServicePath : null;
  const blocked = matchesRoute(route, "blocked");
  const tone = status === "compliant" ? "good" : blocked ? "blocked" : "warning";
  return <article className={styles.routeRow} aria-label={`${lane.origin} to ${lane.destination} route options`}>
    <div className={styles.routeHeading}>
      <h3>{lane.origin} → {lane.destination}</h3>
      <p>{lane.maxTransitDays}-day limit · {route.requirements.join(", ") || "General cargo"}</p>
    </div>
    {path ? <div className={styles.itineraries}>
      <Itinerary path={path} label={status === "service_gap" ? blocked ? "Service gap · No offer" : "Service gap · Disclosure required" : routeLabels[status]} tone={tone} />
      {alternate && <Itinerary path={alternate} label="Full service · Over time limit" tone="blocked" />}
      {fasterWithGap && <Itinerary path={fasterWithGap} label="Faster route · Service gap" tone="warning" />}
    </div> : <p className={styles.noPath}><span className={styles.badge} data-tone="blocked">Unreachable</span> No directed path in the inventory</p>}
  </article>;
}

export function RouteExplorer({ routes, lanes, filter, focused, page, navigate }: {
  routes: LaneRoute[];
  lanes: LabLane[];
  filter: RouteFilter;
  focused?: number;
  page: number;
  navigate: (filter: RouteFilter, page: number) => void;
}) {
  const byId = new Map(lanes.map(lane => [lane.id, lane]));
  const visible = routes.filter(route => focused === undefined ? matchesRoute(route, filter) : focused === route.id);
  const offset = page * pageSize;
  return <section className="panel" aria-labelledby="lab-routes">
    <div className="section-heading">
      <h2 id="lab-routes">Compare flight routes</h2>
      <p>Inventory snapshot · Available services and gaps are shown on each leg. Open a leg for its workbook evidence.</p>
    </div>
    <div className={styles.filters} role="group" aria-label="Filter route outcomes">
      {filters.map(value => <button type="button" key={value} className="button"
        aria-pressed={focused === undefined && filter === value}
        onClick={() => navigate(value, 0)}>{labels[value]} <span>{routes.filter(route => matchesRoute(route, value)).length}</span></button>)}
    </div>
    <p className={styles.resultCount} aria-live="polite">
      {focused !== undefined ? "Showing 1 lane from the assistant" : visible.length ? `Showing ${offset + 1}–${Math.min(offset + pageSize, visible.length)} of ${visible.length} lanes` : "No lanes match this filter."}
    </p>
    <div className={styles.routeRows}>
      {visible.slice(offset, offset + pageSize).map(route => {
        const lane = byId.get(route.id);
        return lane && <LaneRow key={route.id} lane={lane} route={route} />;
      })}
    </div>
    {visible.length > pageSize && <div className={styles.filters}>
      <button type="button" className="button" disabled={page === 0} onClick={() => navigate(filter, page - 1)}>Previous lanes</button>
      <button type="button" className="button" disabled={offset + pageSize >= visible.length} onClick={() => navigate(filter, page + 1)}>Next lanes</button>
    </div>}
  </section>;
}
