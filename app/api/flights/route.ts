import { NextResponse } from 'next/server';

import { preciseNowSeconds, syncFlightClock } from '@/lib/flight-clock';

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
  stale?: boolean;
  warning?: string;
  sourceTimestamp: number;
  receivedAt: number;
  // Stamped fresh on every response, never served from cache: the browser
  // subtracts aircraft report times from its own clock, so it has to be told
  // what time it actually is in the base those reports are stamped in.
  serverTime: number;
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
let nextRefreshAttemptAt = 0;

const retryDelayMs = 60_000;
// How long a browser that arrived at the end of a refresh cycle waits for the
// new snapshot before being answered with the previous one instead.
const refreshGraceMs = 6_000;
// While serving previous positions, check back often: the snapshot behind them
// may already have landed, and a cache read costs nothing upstream.
const staleRecheckSeconds = 15;

// OpenSky prices a request by the area it covers, and bills a global snapshot at
// four credits against a daily allowance the response header reports. Pacing
// against that header spends the whole allowance across a day and slows down by
// itself as it runs down, instead of guessing an interval and being cut off.
const globalSnapshotCredits = 4;
const quotaHorizonSeconds = 86_400;
const minimumRefreshSeconds = 45;
const maximumRefreshSeconds = 900;
// Without credentials OpenSky serves a much smaller anonymous allowance, which
// only stretches across a day at a fraction of the rate.
const anonymousRefreshSeconds = 900;
const unknownQuotaRefreshSeconds = 90;

function isVercelRuntime() {
  return process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
}

/** Spends the credits still on the account evenly across the next day. */
function pacedRefreshSeconds(remainingCredits: number | null, authenticated: boolean) {
  if (!authenticated) return anonymousRefreshSeconds;
  if (remainingCredits === null) return unknownQuotaRefreshSeconds;

  const affordableCalls = Math.max(1, Math.floor(remainingCredits / globalSnapshotCredits));
  const paced = quotaHorizonSeconds / affordableCalls;
  return Math.round(Math.min(maximumRefreshSeconds, Math.max(minimumRefreshSeconds, paced)));
}

async function getToken(): Promise<string | null> {
  const clientId = process.env.OPENSKY_CLIENT_ID?.trim();
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET?.trim();

  // Anonymous access still works, just on a smaller allowance. A deployment that
  // was never given credentials should show aircraft, not an error page.
  if (!clientId || !clientSecret) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  try {
    const response = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new Error(`OpenSky rejected the API credentials (${response.status})`);
    }
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('OpenSky returned no OAuth access token');

    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(120, data.expires_in ?? 1800) * 1000,
    };
    return tokenCache.token;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('OpenSky ')) throw error;
    throw new Error('OpenSky authentication is unavailable');
  }
}

async function fetchSnapshot(): Promise<FlightResponse> {
  // Vercel's shared cloud egress is unreliable with OpenSky authentication.
  // Local development uses the account allowance; Vercel deliberately uses the
  // anonymous IP allowance and never attempts to transmit the API credentials.
  const token = isVercelRuntime() ? null : await getToken();
  const authenticated = Boolean(token);

  const sentAtMs = Date.now();
  const response = await fetch(
    'https://opensky-network.org/api/states/all?extended=1',
    {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(22_000),
    },
  );

  if (!response.ok) {
    const retryAfter = response.headers.get('x-rate-limit-retry-after-seconds');
    throw new Error(
      response.status === 429
        ? `OpenSky daily limit reached${retryAfter ? `; retry in ${retryAfter}s` : ''}`
        : `OpenSky returned ${response.status}`,
    );
  }

  const remainingHeader = Number(response.headers.get('x-rate-limit-remaining'));
  const remainingCredits = Number.isFinite(remainingHeader) && remainingHeader >= 0
    ? remainingHeader
    : null;

  const raw = (await response.json()) as { time: number; states: OpenSkyState[] | null };
  // OpenSky stamps both the snapshot and every position in its own clock, so it
  // is the authority on the time base this server compares positions against —
  // more so than the machine the server happens to be running on.
  syncFlightClock(raw.time, sentAtMs);

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

  const refreshAfter = pacedRefreshSeconds(remainingCredits, authenticated);
  const expiresAt = Date.now() + refreshAfter * 1000;
  const body: FlightResponse = {
    source: 'opensky',
    mode: authenticated ? 'authenticated' : 'anonymous',
    sourceTimestamp: raw.time,
    receivedAt: Math.floor(preciseNowSeconds()),
    serverTime: preciseNowSeconds(),
    refreshAfter,
    // Absolute time the next snapshot becomes available, so clients can wake up
    // exactly then instead of re-downloading this one on a blind interval.
    nextRefreshAt: Math.ceil(expiresAt / 1000),
    count: aircraft.length,
    aircraft,
  };

  flightCache = { body, expiresAt };
  nextRefreshAttemptAt = 0;
  return body;
}

function refreshSnapshot() {
  inflightSnapshot ??= fetchSnapshot().finally(() => { inflightSnapshot = null; });
  return inflightSnapshot;
}

/** Resolves with the promise, or rejects once the deadline passes. */
function withDeadline<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadline')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function snapshotResponse(body: FlightResponse, cacheState: 'hit' | 'miss') {
  return NextResponse.json(
    // `nextRefreshAt` is absolute, so a cached body stays correct as it ages —
    // only the clock stamp has to be re-taken on the way out.
    { ...body, serverTime: preciseNowSeconds() },
    {
      headers: {
        // Always reach this worker so its controlled quota-aware cache decides
        // freshness; a shared edge cache can otherwise freeze the same snapshot.
        'cache-control': 'private, no-store',
        'x-skytrace-cache': cacheState,
      },
    },
  );
}

function previousPositionsResponse(body: FlightResponse) {
  const ageSeconds = Math.max(0, Math.round(preciseNowSeconds() - body.sourceTimestamp));
  // Dead reckoning carries the fleet convincingly across a missed cycle or two,
  // so a snapshot that is merely a little late is not worth interrupting anyone
  // over. Only once it is old enough that the shown positions are mostly
  // extrapolation does the browser deserve a warning.
  const degraded = ageSeconds > Math.max(body.refreshAfter * 3, 240);

  return NextResponse.json(
    {
      ...body,
      serverTime: preciseNowSeconds(),
      stale: degraded,
      warning: degraded
        ? `OpenSky last refreshed ${Math.round(ageSeconds / 60)} min ago; positions are dead-reckoned from that fix`
        : undefined,
      refreshAfter: staleRecheckSeconds,
      nextRefreshAt: Math.ceil(preciseNowSeconds()) + staleRecheckSeconds,
    },
    {
      headers: {
        'cache-control': 'private, no-store',
        'x-skytrace-cache': 'stale',
        ...(degraded ? { warning: '110 - "Response is stale"' } : {}),
      },
    },
  );
}

function unavailableMessage(error: unknown) {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'OpenSky is taking longer than expected; retrying automatically';
  }
  if (error instanceof Error && /aborted|timeout|deadline/i.test(error.message)) {
    return 'OpenSky is taking longer than expected; retrying automatically';
  }
  return error instanceof Error ? error.message : 'The live aircraft feed is temporarily unavailable';
}

export async function GET() {
  if (flightCache && flightCache.expiresAt > Date.now()) {
    return snapshotResponse(flightCache.body, 'hit');
  }

  if (flightCache) {
    // A lapsed cache is the ordinary end of a refresh cycle, not a fault. Give
    // the next snapshot a bounded chance to arrive and answer with it, so a
    // normal cycle boundary stops reaching the browser as a delay warning — it
    // used to, on the first request after every single expiry.
    if (Date.now() >= nextRefreshAttemptAt) {
      nextRefreshAttemptAt = Date.now() + retryDelayMs;
      try {
        return snapshotResponse(await withDeadline(refreshSnapshot(), refreshGraceMs), 'miss');
      } catch {
        // The previous positions are still worth showing, and a refresh that is
        // merely slow keeps running and lands in the cache when it finishes.
      }
    }

    // Never throw away a valid global snapshot merely because the next OpenSky
    // refresh is slow. Aircraft prediction keeps moving these from their source
    // timestamps while the refresh recovers.
    return previousPositionsResponse(flightCache.body);
  }

  try {
    // Collapse concurrent misses into one upstream snapshot. Anonymous access
    // allows only ~100 global requests a day, so several clients refreshing at
    // the same moment must not each spend one.
    return snapshotResponse(await refreshSnapshot(), 'miss');
  } catch (error) {
    return NextResponse.json(
      { error: unavailableMessage(error) },
      { status: 503, headers: { 'retry-after': String(retryDelayMs / 1000) } },
    );
  }
}
