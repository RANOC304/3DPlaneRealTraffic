import { NextRequest, NextResponse } from 'next/server';

import { type NetworkAircraft, queryNetworks } from '@/lib/adsb';

// Twelve 3000nm caps cover the planet with overlap. Ordered so the busiest
// airspace lands first, which matters because a sweep is paced.
const globeTiles: Array<[number, number]> = [
  [50, 10], [40, -95], [30, 60], [35, 115], [10, 100], [5, -60],
  [-28, -60], [-25, 135], [10, 20], [-25, 25], [35, -160], [-30, -150],
];

const tileRadiusNm = 3000;
const regionTtlMs = 25_000;
const globalTtlMs = 60_000;

type CacheEntry = { aircraft: NetworkAircraft[]; expiresAt: number; sources: string[] };

const cache = new Map<string, CacheEntry>();
let globalSweep: Promise<CacheEntry> | null = null;

function cached(key: string) {
  const entry = cache.get(key);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}

function respond(entry: CacheEntry, hit: boolean) {
  return NextResponse.json(
    { aircraft: entry.aircraft, count: entry.aircraft.length, sources: entry.sources },
    { headers: { 'cache-control': 'private, no-store', 'x-skytrace-network-cache': hit ? 'hit' : 'miss' } },
  );
}

async function sweepGlobe(): Promise<CacheEntry> {
  const merged = new Map<string, NetworkAircraft>();
  const sources = new Set<string>();

  for (const [lat, lon] of globeTiles) {
    const { aircraft, source } = await queryNetworks(`/point/${lat}/${lon}/${tileRadiusNm}`);
    if (source) sources.add(source);
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

  const { aircraft, source } = await queryNetworks(`/point/${keyLat}/${keyLon}/${keyRadius}`);
  const entry: CacheEntry = {
    aircraft,
    expiresAt: Date.now() + regionTtlMs,
    sources: source ? [source] : [],
  };
  cache.set(key, entry);

  // The map is keyed by viewport, so evict the oldest entries rather than let it
  // grow for the life of the worker.
  if (cache.size > 40) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest && oldest[0] !== 'global') cache.delete(oldest[0]);
  }

  return respond(entry, false);
}
