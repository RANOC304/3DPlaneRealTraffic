// Shared client for the community ADS-B aggregators. They run a feeder network
// separate from OpenSky, so merging them fills in large gaps — but they are free
// community services, so every request identifies itself and results are cached.

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

type ReadsbResponse = { ac?: ReadsbAircraft[]; now?: number };

export const adsbNetworks = [
  { id: 'adsb.lol', base: 'https://api.adsb.lol/v2' },
  { id: 'adsb.fi', base: 'https://opendata.adsb.fi/api/v2' },
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

export function normaliseAircraft(
  raw: ReadsbAircraft,
  nowSeconds: number,
  source: string,
): NetworkAircraft | null {
  if (!raw.hex || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;

  const onGround = raw.alt_baro === 'ground';
  const baroFeet = typeof raw.alt_baro === 'number' ? raw.alt_baro : 0;
  const geomFeet = typeof raw.alt_geom === 'number' ? raw.alt_geom : null;

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
    verticalRate: (raw.baro_rate ?? 0) * feetPerMinuteToMetresPerSecond,
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

/** Queries one path against each network in turn, returning the first success. */
export async function queryNetworks(path: string, timeoutMs = 12_000) {
  for (const network of adsbNetworks) {
    try {
      const response = await fetch(`${network.base}${path}`, {
        cache: 'no-store',
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A burst can be throttled; fall through to the next network instead of
      // retrying the same one immediately.
      if (!response.ok) continue;

      const data = (await response.json()) as ReadsbResponse;
      const nowSeconds = (data.now ?? Date.now()) / 1000;
      const aircraft = (data.ac ?? [])
        .map((entry) => normaliseAircraft(entry, nowSeconds, network.id))
        .filter((entry): entry is NetworkAircraft => entry !== null);

      return { aircraft, source: network.id };
    } catch {
      // Try the next network rather than failing the whole query.
    }
  }
  return { aircraft: [] as NetworkAircraft[], source: null };
}
