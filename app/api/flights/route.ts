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
  // This endpoint is consumed only by the visualizer. A tuple avoids repeating
  // fifteen property names thousands of times in every global snapshot.
  aircraft: Array<[
    id: string,
    callsign: string,
    country: string,
    lat: number,
    lon: number,
    altitude: number,
    onGround: boolean,
    speed: number,
    heading: number,
    verticalRate: number,
    positionTime: number,
    lastContact: number,
    squawk: string | null,
    positionSource: number,
    category: number,
  ]>;
};

let tokenCache: TokenCache = null;
let flightCache: FlightCache = null;
let inflightSnapshot: Promise<FlightResponse> | null = null;

async function getToken(): Promise<string | null> {
  const clientId = process.env.OPENSKY_CLIENT_ID?.trim();
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  try {
    const response = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) return null;
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(120, data.expires_in ?? 1800) * 1000,
    };
    return tokenCache.token;
  } catch {
    return null;
  }
}

async function fetchSnapshot(): Promise<FlightResponse> {
  const token = await getToken();
  let authenticated = Boolean(token);
  const requestStates = (accessToken: string | null) => fetch(
    'https://opensky-network.org/api/states/all?extended=1',
    {
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(22_000),
    },
  );

  let response: Response;
  try {
    response = await requestStates(token);
  } catch (error) {
    if (!token) throw error;
    tokenCache = null;
    authenticated = false;
    response = await requestStates(null);
  }

  // A rejected authenticated request can be caused by an expired token, an
  // exhausted account allowance, or provider-side auth trouble. Retry once
  // without credentials so the globe remains live at the anonymous allowance.
  if (!response.ok && token) {
    tokenCache = null;
    authenticated = false;
    response = await requestStates(null);
  }

  if (!response.ok) {
    const retryAfter = response.headers.get('x-rate-limit-retry-after-seconds');
    throw new Error(
      response.status === 429
        ? `OpenSky daily limit reached${retryAfter ? `; retry in ${retryAfter}s` : ''}`
        : `OpenSky returned ${response.status}`,
    );
  }

  const raw = (await response.json()) as { time: number; states: OpenSkyState[] | null };
  const aircraft = (raw.states ?? []).flatMap((state): FlightResponse['aircraft'] => {
    const lon = state[5];
    const lat = state[6];
    if (lon === null || lat === null) return [];

    return [[
      state[0],
      state[1]?.trim() || state[0].toUpperCase(),
      state[2] || 'Unknown',
      lat,
      lon,
      state[7] ?? state[13] ?? 0,
      state[8],
      state[9] ?? 0,
      state[10] ?? 0,
      state[11] ?? 0,
      state[3] ?? state[4],
      state[4],
      state[14],
      state[16],
      state[17] ?? 0,
    ]];
  });

  // A global snapshot costs four credits. Ninety seconds stays below the free
  // authenticated allowance; anonymous access is paced to its smaller bucket.
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
