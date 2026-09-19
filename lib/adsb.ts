// Shared client for the community ADS-B aggregators. They run a feeder network
// separate from OpenSky and republish about once a second, so they — not the
// quota-paced OpenSky snapshot — are what makes positions move in real time.
// They are free community services, so every request identifies itself and
// results are cached.

import { syncFlightClock } from '@/lib/flight-clock';

export type ReadsbAircraft = {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  category?: string;
  lat?: number;
  lon?: number;
  seen?: number;
  seen_pos?: number;
  spi?: number;
};

export type NetworkAircraft = {
  id: string;
  callsign: string;
  country: string;
  lat: number;
  lon: number;
  altitude: number;
  geoAltitude: number | null;
  onGround: boolean;
  speed: number;
  heading: number;
  verticalRate: number;
  positionTime: number;
  lastContact: number;
  squawk: string | null;
  spi: boolean;
  positionSource: number;
  category: number;
  registration: string | null;
  model: string | null;
  source: string;
};

export type NetworkQuery =
  | { kind: 'point'; lat: number; lon: number; radiusNm: number }
  | { kind: 'callsign'; callsign: string };

// Both aggregators run the same readsb software behind different routers, so
// they answer the same questions at different paths — and a path they appear to
// share does not always return the same envelope. Each network therefore carries
// its own URL builder and its own radius ceiling rather than one path string
// being formatted for both: asking adsb.fi the way adsb.lol expects answers HTTP
// 400, which is how this fallback came to be silently dead.
const adsbNetworks = [
  {
    id: 'adsb.lol',
    maxRadiusNm: 3000,
    url(query: NetworkQuery) {
      return query.kind === 'callsign'
        ? `https://api.adsb.lol/v2/callsign/${encodeURIComponent(query.callsign)}`
        : `https://api.adsb.lol/v2/point/${query.lat}/${query.lon}/${query.radiusNm}`;
    },
  },
  {
    id: 'adsb.fi',
    maxRadiusNm: 250,
    url(query: NetworkQuery) {
      return query.kind === 'callsign'
        ? `https://opendata.adsb.fi/api/v2/callsign/${encodeURIComponent(query.callsign)}`
        : `https://opendata.adsb.fi/api/v2/lat/${query.lat}/lon/${query.lon}/dist/${query.radiusNm}`;
    },
  },
];

// These APIs reject requests without a User-Agent, and a free community service
// deserves to know who is calling it.
const requestHeaders = {
  accept: 'application/json',
  'user-agent': 'skytrace-globe/1.0 (+hobby 3D air traffic viewer)',
};

const feetToMetres = 0.3048;
const knotsToMetresPerSecond = 0.514444;
const feetPerMinuteToMetresPerSecond = 0.00508;

// ADS-B emitter categories map onto the numeric categories the globe already
// uses to choose an aircraft silhouette.
const emitterCategories: Record<string, number> = {
  A1: 2, A2: 3, A3: 4, A4: 5, A5: 6, A6: 7, A7: 8,
  B1: 12, B2: 10, B4: 11, B6: 14, B7: 9,
};

/**
 * The feeds disagree about the unit of their `now` field: adsb.lol reports
 * milliseconds, adsb.fi reports seconds. Reading one as the other dated every
 * position to 1970 and left those aircraft frozen wherever the prediction clamp
 * happened to put them, so the magnitude decides the unit, not the field name.
 */
function feedSeconds(now: unknown): number | null {
  if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0) return null;
  const seconds = now > 1e11 ? now / 1000 : now;
  // Anything outside a plausible epoch window is a unit this code has not seen.
  return seconds > 1e9 && seconds < 4e9 ? seconds : null;
}

export function normaliseAircraft(
  raw: ReadsbAircraft,
  nowSeconds: number,
  source: string,
): NetworkAircraft | null {
  if (!raw.hex || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;

  const onGround = raw.alt_baro === 'ground';
  const baroFeet = typeof raw.alt_baro === 'number' ? raw.alt_baro : 0;
  const geomFeet = typeof raw.alt_geom === 'number' ? raw.alt_geom : null;
  // Aircraft that publish no barometric rate usually still publish a geometric
  // one, and a climb the globe cannot see reads as level flight into terrain.
  const rateFeetPerMinute = raw.baro_rate ?? raw.geom_rate ?? 0;

  return {
    id: raw.hex.toLowerCase(),
    callsign: (raw.flight ?? '').trim() || raw.hex.toUpperCase(),
    country: 'Unknown',
    lat: raw.lat as number,
    lon: raw.lon as number,
    // The feed reports feet and knots; the globe works in metres and m/s.
    altitude: onGround ? 0 : baroFeet * feetToMetres,
    geoAltitude: geomFeet === null ? null : geomFeet * feetToMetres,
    onGround,
    speed: (raw.gs ?? 0) * knotsToMetresPerSecond,
    heading: raw.track ?? 0,
    verticalRate: rateFeetPerMinute * feetPerMinuteToMetresPerSecond,
    positionTime: Math.floor(nowSeconds - (raw.seen_pos ?? 0)),
    lastContact: Math.floor(nowSeconds - (raw.seen ?? 0)),
    squawk: raw.squawk ?? null,
    spi: raw.spi === 1,
    positionSource: 0,
    category: emitterCategories[raw.category ?? ''] ?? 0,
    registration: raw.r ?? null,
    model: raw.t ?? null,
    source,
  };
}

type NetworkResult = { aircraft: NetworkAircraft[]; source: string; feedTime: number | null };

async function queryNetwork(
  network: (typeof adsbNetworks)[number],
  query: NetworkQuery,
  timeoutMs: number,
): Promise<NetworkResult | null> {
  // A network whose ceiling sits far below the area asked for would spend a whole
  // request to answer a sliver of the question, most of it already covered by a
  // network that can serve the lot. Ask it only where it can carry its weight.
  if (query.kind === 'point' && query.radiusNm > network.maxRadiusNm * 2) return null;

  const request: NetworkQuery = query.kind === 'point'
    ? { ...query, radiusNm: Math.min(query.radiusNm, network.maxRadiusNm) }
    : query;

  const sentAtMs = Date.now();
  const response = await fetch(network.url(request), {
    cache: 'no-store',
    headers: requestHeaders,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;

  // The same software answers under `ac` at some paths and `aircraft` at others,
  // so accept either rather than depending on which route was taken.
  const data = (await response.json()) as {
    ac?: ReadsbAircraft[];
    aircraft?: ReadsbAircraft[];
    now?: number;
  };

  const feedTime = feedSeconds(data.now);
  // These feeds state when they last heard each aircraft, which makes them the
  // authority on the time base every prediction is measured against.
  if (feedTime !== null) syncFlightClock(feedTime, sentAtMs);

  const stamp = feedTime ?? Date.now() / 1000;
  const aircraft = (data.ac ?? data.aircraft ?? [])
    .map((entry) => normaliseAircraft(entry, stamp, network.id))
    .filter((entry): entry is NetworkAircraft => entry !== null);

  return { aircraft, source: network.id, feedTime };
}

/**
 * Asks every network at once and merges the answers, keeping the freshest fix
 * for each airframe. Trying them in turn and stopping at the first success let
 * one slow network delay every refresh, and meant a second network's unique
 * coverage was never used at all.
 */
export async function queryNetworks(query: NetworkQuery, timeoutMs = 12_000) {
  const settled = await Promise.allSettled(
    adsbNetworks.map((network) => queryNetwork(network, query, timeoutMs)),
  );

  const merged = new Map<string, NetworkAircraft>();
  const sources: string[] = [];
  let feedTime: number | null = null;

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled' || outcome.value === null) continue;
    const result = outcome.value;
    sources.push(result.source);
    if (result.feedTime !== null && (feedTime === null || result.feedTime > feedTime)) {
      feedTime = result.feedTime;
    }
    for (const flight of result.aircraft) {
      const existing = merged.get(flight.id);
      // Both networks hear the same airframe wherever their feeders overlap;
      // keep whichever heard it more recently.
      if (!existing || flight.positionTime > existing.positionTime) merged.set(flight.id, flight);
    }
  }

  return { aircraft: [...merged.values()], sources, feedTime };
}
