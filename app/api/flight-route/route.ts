import { NextRequest, NextResponse } from 'next/server';

type Airport = {
  countryIso: string;
  country: string;
  iata: string;
  icao: string;
  latitude: number;
  longitude: number;
  municipality: string;
  name: string;
};

type RouteResponse = {
  callsign: string;
  airline: string | null;
  origin: Airport | null;
  destination: Airport | null;
  midpoint: Airport | null;
  track: Array<{
    time: number;
    lat: number;
    lon: number;
    altitude: number | null;
    heading: number | null;
    onGround: boolean;
  }>;
  trackStartTime: number | null;
  trackEndTime: number | null;
  itineraryKind: 'plausible' | 'unavailable';
};

type OpenSkyTrack = {
  startTime?: number;
  endTime?: number;
  path?: Array<[number, number | null, number | null, number | null, number | null, boolean]>;
};

type AdsbAirport = {
  country_iso_name: string;
  country_name: string;
  iata_code: string;
  icao_code: string;
  latitude: number;
  longitude: number;
  municipality: string;
  name: string;
};

type AdsbDbRoute = {
  response?: {
    flightroute?: {
      airline?: { name?: string } | null;
      origin?: AdsbAirport;
      destination?: AdsbAirport;
      midpoint?: AdsbAirport;
    };
  };
};

const routeCache = new Map<string, { body: RouteResponse; expiresAt: number }>();

function airport(value?: AdsbAirport): Airport | null {
  if (!value || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) return null;
  return {
    countryIso: value.country_iso_name,
    country: value.country_name,
    iata: value.iata_code,
    icao: value.icao_code,
    latitude: value.latitude,
    longitude: value.longitude,
    municipality: value.municipality,
    name: value.name,
  };
}

export async function GET(request: NextRequest) {
  const icao24 = request.nextUrl.searchParams.get('icao24')?.trim().toLowerCase() ?? '';
  const callsign = request.nextUrl.searchParams.get('callsign')?.trim().toUpperCase() ?? '';

  // The ICAO24 is optional: a callsign alone still resolves a scheduled route,
  // which is how the search explains a flight that no receiver is currently
  // tracking. Only the observed track needs a specific airframe.
  if (!/^[A-Z0-9]{2,10}$/.test(callsign) || (icao24.length > 0 && !/^[0-9a-f]{6}$/.test(icao24))) {
    return NextResponse.json({ error: 'A valid callsign is required' }, { status: 400 });
  }

  const cacheKey = `${icao24 || '-'}:${callsign}`;
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body, {
      headers: { 'cache-control': 'private, no-store', 'x-skytrace-route-cache': 'hit' },
    });
  }

  const [trackResult, itineraryResult] = await Promise.allSettled([
    icao24.length === 0
      ? Promise.resolve(null)
      : fetch(`https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(18_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`OpenSky track returned ${response.status}`);
        return (await response.json()) as OpenSkyTrack;
      }),
    fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Route lookup returned ${response.status}`);
      return (await response.json()) as AdsbDbRoute;
    }),
  ]);

  const rawTrack = trackResult.status === 'fulfilled' ? trackResult.value : null;
  const rawItinerary = itineraryResult.status === 'fulfilled'
    ? itineraryResult.value.response?.flightroute
    : undefined;
  const track = (rawTrack?.path ?? []).flatMap((point) => {
    const [time, lat, lon, altitude, heading, onGround] = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [{
      time,
      lat: lat as number,
      lon: lon as number,
      altitude,
      heading,
      onGround,
    }];
  });

  const origin = airport(rawItinerary?.origin);
  const destination = airport(rawItinerary?.destination);
  const body: RouteResponse = {
    callsign,
    airline: rawItinerary?.airline?.name ?? null,
    origin,
    destination,
    midpoint: airport(rawItinerary?.midpoint),
    track,
    trackStartTime: rawTrack?.startTime ?? null,
    trackEndTime: rawTrack?.endTime ?? null,
    itineraryKind: origin && destination ? 'plausible' : 'unavailable',
  };

  routeCache.set(cacheKey, { body, expiresAt: Date.now() + 5 * 60_000 });
  return NextResponse.json(body, {
    headers: { 'cache-control': 'private, no-store', 'x-skytrace-route-cache': 'miss' },
  });
}
