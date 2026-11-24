import { permittedDispositions } from "../routing/contracts";
import type { LaneRoute } from "./workflow";

export type LabLane = { id: number; origin: string; destination: string; maxTransitDays: string };
export const routeFilters = ["all", "compliant", "service_gap", "over_limit", "unreachable", "blocked"] as const;
export type RouteFilter = typeof routeFilters[number];

export function matchesRoute(route: LaneRoute, filter: RouteFilter) {
  if (filter === "all") return true;
  if (filter === "blocked") return permittedDispositions(route.assessment).every(choice => choice === "no_offer");
  return route.assessment.status === filter;
}
