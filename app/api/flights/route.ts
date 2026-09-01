import { NextResponse } from 'next/server';

type OpenSkyState = [
  string,
  string | null,
  string,
  number | null,
  number,
  number | null,
  number | null,
  number | null,
  boolean,
  number | null,
  number | null,
  number | null,
  number[] | null,
  number | null,
  string | null,
  boolean,
  number,
  number?,
];

type TokenCache = { token: string; expiresAt: number } | null;
type FlightCache = { body: FlightResponse; expiresAt: number } | null;

type FlightResponse = {
  source: 'opensky';
  mode: 'anonymous' | 'authenticated';
  sourceTimestamp: number;
  receivedAt: number;
  refreshAfter: number;
  nextRefreshAt: number;
  count: number;
  aircraft: Array<{
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
  }>;
};

let tokenCache: TokenCache = null;
let flightCache: FlightCache = null;
let inflightSnapshot: Promise<FlightResponse> | null = null;

async function getToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) throw new Error(`OpenSky authentication failed (${response.status})`);
  const data = (await response.json()) as { access_token: string; expires_in?: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(120, data.expires_in ?? 1800) * 1000,
  };
  return tokenCache.token;
}

async function fetchSnapshot(): Promise<FlightResponse> {
  const token = await getToken();
  const response = await fetch('https://opensky-network.org/api/states/all?extended=1', {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(22_000),
  });

  if (!response.ok) {
    const retryAfter = response.headers.get('x-rate-limit-retry-after-seconds');
    throw new Error(
      response.status === 429
        ? `OpenSky daily limit reached${retryAfter ? `; retry in ${retryAfter}s` : ''}`
        : `OpenSky returned ${response.status}`,
    );
  }

  const raw = (await response.json()) as { time: number; states: OpenSkyState[] | null };
  const aircraft = (raw.states ?? []).flatMap((state) => {
    const lon = state[5];
    const lat = state[6];
    if (lon === null || lat === null) return [];

    return [{
      id: state[0],
      callsign: state[1]?.trim() || state[0].toUpperCase(),
      country: state[2] || 'Unknown',
      lat,
      lon,
      altitude: state[7] ?? state[13] ?? 0,
      geoAltitude: state[13],
      onGround: state[8],
      speed: state[9] ?? 0,
      heading: state[10] ?? 0,
      verticalRate: state[11] ?? 0,
      positionTime: state[3] ?? state[4],
      lastContact: state[4],
      squawk: state[14],
      spi: state[15],
      positionSource: state[16],
      category: state[17] ?? 0,
    }];
  });

  const authenticated = Boolean(token);
  // A global snapshot costs four credits. Ninety seconds stays below the
  // free authenticated daily allowance while anonymous mode needs 15 minutes.
  const refreshAfter = authenticated ? 90 : 900;
  const expiresAt = Date.now() + refreshAfter * 1000;
  const body: FlightResponse = {
    source: 'opensky',
    mode: authenticated ? 'authenticated' : 'anonymous',
    sourceTimestamp: raw.time,
    receivedAt: Math.floor(Date.now() / 1000),
    refreshAfter,
    // Absolute time the next snapshot becomes available, so clients can wake up
    // exactly then instead of re-downloading this one on a blind interval.
    nextRefreshAt: Math.ceil(expiresAt / 1000),
    count: aircraft.length,
    aircraft,
  };

  flightCache = { body, expiresAt };
  return body;
}

export async function GET() {
  if (flightCache && flightCache.expiresAt > Date.now()) {
    return NextResponse.json(flightCache.body, {
      headers: {
        'cache-control': 'private, no-store',
        'x-skytrace-cache': 'hit',
      },
    });
  }

  try {
    // Collapse concurrent misses into one upstream snapshot. Anonymous access
    // allows only ~100 global requests a day, so several clients refreshing at
    // the same moment must not each spend one.
    inflightSnapshot ??= fetchSnapshot().finally(() => { inflightSnapshot = null; });
    const body = await inflightSnapshot;

    return NextResponse.json(body, {
      headers: {
        // Always reach this worker so its controlled quota-aware cache decides
        // freshness; a shared edge cache can otherwise freeze the same snapshot.
        'cache-control': 'private, no-store',
        'x-skytrace-cache': 'miss',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'The live aircraft feed is temporarily unavailable',
      },
      { status: 503 },
    );
  }
}
