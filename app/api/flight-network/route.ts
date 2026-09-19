import { NextRequest, NextResponse } from 'next/server';

import { type NetworkAircraft, queryNetworks } from '@/lib/adsb';
import { preciseNowSeconds } from '@/lib/flight-clock';

// Twelve 3000nm caps cover the planet with overlap. Ordered so the busiest
// airspace lands first, which matters because a sweep is paced.
const globeTiles: Array<[number, number]> = [
  [50, 10], [40, -95], [30, 60], [35, 115], [10, 100], [5, -60],
  [-28, -60], [-25, 135], [10, 20], [-25, 25], [35, -160], [-30, -150],
];

const tileRadiusNm = 3000;
// These aggregators republish roughly once a second, which is the whole reason
// this endpoint exists: it is the only feed in the app capable of showing an
// aircraft where it actually is right now. Holding a region for much longer
// than the upstream takes to change would throw that away and leave the globe
// animating dead reckoning between fixes it already had.
const regionTtlMs = 4_000;
const globalTtlMs = 60_000;

type CacheEntry = { aircraft: NetworkAircraft[]; expiresAt: number; sources: string[] };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();
let globalSweep: Promise<CacheEntry> | null = null;

function cached(key: string) {
  const entry = cache.get(key);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}

function respond(entry: CacheEntry, hit: boolean) {
  return NextResponse.json(
    {
      aircraft: entry.aircraft,
      count: entry.aircraft.length,
      sources: entry.sources,
      // Stamped per response, never cached: this is what lets the browser correct
      // its own clock against the time base the positions are measured in.
      serverTime: preciseNowSeconds(),
    },
    { headers: { 'cache-control': 'private, no-store', 'x-skytrace-network-cache': hit ? 'hit' : 'miss' } },
  );
}

async function sweepGlobe(): Promise<CacheEntry> {
  const merged = new Map<string, NetworkAircraft>();
  const sources = new Set<string>();

  for (const [lat, lon] of globeTiles) {
    const { aircraft, sources: tileSources } = await queryNetworks({
      kind: 'point',
      lat,
      lon,
      radiusNm: tileRadiusNm,
    });
    for (const source of tileSources) sources.add(source);
    for (const flight of aircraft) {
      const existing = merged.get(flight.id);
      // Overlapping caps return the same airframe; keep the freshest fix.
      if (!existing || flight.positionTime > existing.positionTime) merged.set(flight.id, flight);
    }
    // Pace the sweep: firing all twelve at once gets the burst throttled.
    await new Promise((resolve) => { setTimeout(resolve, 700); });
  }

  const entry: CacheEntry = {
    aircraft: [...merged.values()],
    expiresAt: Date.now() + globalTtlMs,
    sources: [...sources],
  };
  cache.set('global', entry);
  return entry;
}

async function loadRegion(key: string, lat: number, lon: number, radiusNm: number): Promise<CacheEntry> {
  const { aircraft, sources } = await queryNetworks({ kind: 'point', lat, lon, radiusNm });
  const entry: CacheEntry = { aircraft, expiresAt: Date.now() + regionTtlMs, sources };
  cache.set(key, entry);

  // The map is keyed by viewport, so evict the oldest entries rather than let it
  // grow for the life of the worker.
  if (cache.size > 40) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest && oldest[0] !== 'global') cache.delete(oldest[0]);
  }
  return entry;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get('mode') === 'global' ? 'global' : 'region';

  if (mode === 'global') {
    const hit = cached('global');
    if (hit) return respond(hit, true);
    // Collapse concurrent sweeps so several clients cannot multiply the load on
    // a free community API.
    globalSweep ??= sweepGlobe().finally(() => { globalSweep = null; });
    return respond(await globalSweep, false);
  }

  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  const radius = Number(params.get('radius'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius)
    || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return NextResponse.json({ error: 'lat, lon and radius are required' }, { status: 400 });
  }

  // Round the key so small camera drifts reuse one cached answer.
  const keyLat = Math.round(lat);
  const keyLon = Math.round(lon);
  const keyRadius = Math.min(tileRadiusNm, Math.max(50, Math.round(radius / 100) * 100));
  const key = `region:${keyLat}:${keyLon}:${keyRadius}`;

  const hit = cached(key);
  if (hit) return respond(hit, true);

  // At a four-second window every browser watching one region would otherwise
  // arrive during the same upstream request. One request answers all of them.
  let pending = inflight.get(key);
  if (!pending) {
    pending = loadRegion(key, keyLat, keyLon, keyRadius).finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
  }

  return respond(await pending, false);
}
