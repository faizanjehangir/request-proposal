import { inventoryServices, services, type AssessedPath, type RouteAssessment, type Service } from "./contracts";

type Leg = {
  id: number;
  sourceRow: number;
  origin: string;
  destination: string;
  transitDays: string;
  services: string[];
};

type Edge = Omit<Leg, "services"> & { services: Service[]; days: bigint; mask: number };
type State = { airport: string; days: bigint; legs: Edge[]; mask: number };

function serviceMask(values: Service[]) {
  return values.reduce((mask, service) => mask | (1 << services.indexOf(service)), 0);
}

function compare(a: State, b: State) {
  if (a.days !== b.days) return a.days < b.days ? -1 : 1;
  if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;
  for (let i = 0; i < a.legs.length; i++) {
    if (a.legs[i].id !== b.legs[i].id) return a.legs[i].id - b.legs[i].id;
  }
  return 0;
}

class Frontier {
  private states: State[] = [];

  push(state: State) {
    const items = this.states;
    let index = items.length;
    items.push(state);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compare(items[parent], state) <= 0) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = state;
  }

  pop(): State | undefined {
    const items = this.states;
    const first = items[0];
    const last = items.pop();
    if (!last || !items.length) return first;
    let index = 0;
    while (index * 2 + 1 < items.length) {
      let child = index * 2 + 1;
      if (child + 1 < items.length && compare(items[child + 1], items[child]) < 0) child++;
      if (compare(last, items[child]) <= 0) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return first;
  }
}

export function createRouteEngine(legs: Leg[], transitLimits: string[]) {
  // Scale the imported decimal strings once to compare transit limits exactly.
  const scale = [...transitLimits, ...legs.map((leg) => leg.transitDays)]
    .reduce((max, value) => Math.max(max, value.split(".")[1]?.length ?? 0), 0);
  function units(value: string) {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(scale, "0"));
  }
  function format(value: bigint) {
    const digits = value.toString().padStart(scale + 1, "0");
    if (!scale) return digits;
    const fraction = digits.slice(-scale).replace(/0+$/, "");
    return digits.slice(0, -scale) + (fraction ? `.${fraction}` : "");
  }

  const outgoing = new Map<string, Edge[]>();
  for (const leg of legs) {
    const available = inventoryServices(leg.services);
    const edge = { ...leg, services: available, mask: serviceMask(available), days: units(leg.transitDays) };
    const edges = outgoing.get(leg.origin) ?? [];
    edges.push(edge);
    outgoing.set(leg.origin, edges);
  }

  function search(origin: string, destination: string, requiredMask: number, cap?: bigint) {
    const alternative = cap !== undefined;
    const frontier = new Frontier();
    const best = new Map<string, State>();
    const key = (state: State) => `${state.airport}:${state.mask}`;
    const start = { airport: origin, days: 0n, legs: [], mask: requiredMask };
    best.set(key(start), start);
    frontier.push(start);

    let selected: State | undefined;
    const coverage = (state: State) => services.filter((_, i) => state.mask & (1 << i)).length;

    for (let state = frontier.pop(); state; state = frontier.pop()) {
      if (best.get(key(state)) !== state) continue;
      if (state.airport === destination) {
        if (!alternative) return state;
        if (!selected || coverage(state) > coverage(selected)) selected = state;
        continue;
      }
      for (const edge of outgoing.get(state.airport) ?? []) {
        const days = state.days + edge.days;
        if (cap !== undefined ? days > cap : (edge.mask & requiredMask) !== requiredMask) continue;
        const next = { airport: edge.destination, days, legs: [...state.legs, edge], mask: state.mask & edge.mask };
        const previous = best.get(key(next));
        if (previous && compare(previous, next) <= 0) continue;
        best.set(key(next), next);
        frontier.push(next);
      }
    }
    return selected;
  }

  function describe(origin: string, state: State | undefined, requested: Service[]): AssessedPath | null {
    if (!state) return null;
    const legs = state.legs.map(({ id, sourceRow, origin, destination, transitDays, services }) => ({
      id, sourceRow, origin, destination, transitDays, services,
      missing: requested.filter((service) => !services.includes(service)),
    }));
    const missing = requested.filter((service) => legs.some((leg) => leg.missing.includes(service)));
    return {
      airports: [origin, ...legs.map((leg) => leg.destination)],
      totalDays: format(state.days),
      fulfilled: requested.filter((service) => !missing.includes(service)),
      missing,
      legs,
    };
  }

  return {
    assess(origin: string, destination: string, maxTransitDays: string, requested: Service[]): RouteAssessment {
      const mask = serviceMask(requested);
      const cap = units(maxTransitDays);
      const full = search(origin, destination, mask);
      if (full && full.days <= cap) {
        const path = describe(origin, full, requested);
        return { status: "compliant", path, fullServicePath: path };
      }

      const alternative = search(origin, destination, mask, cap);
      const fullServicePath = describe(origin, full, requested);
      if (alternative) {
        return { status: "service_gap", path: describe(origin, alternative, requested), fullServicePath };
      }
      const fastest = mask ? search(origin, destination, 0) : full;
      return {
        status: fastest ? "over_limit" : "unreachable",
        path: describe(origin, fastest, requested),
        fullServicePath,
      };
    },
  };
}
