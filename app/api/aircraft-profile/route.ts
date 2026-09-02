import { NextRequest, NextResponse } from 'next/server';

// Everything about the airframe itself rather than where it is right now: what
// it is, who owns it, and a photograph of the actual tail number. Two free
// community services cover it — adsbdb for the registry entry and Planespotters
// for the picture — so both are asked at once and either may come back empty.

type AircraftProfile = {
  icao24: string;
  registration: string | null;
  type: string | null;
  icaoType: string | null;
  manufacturer: string | null;
  owner: string | null;
  ownerCountry: string | null;
  operatorFlag: string | null;
  photo: { url: string; link: string; photographer: string } | null;
};

type AdsbDbAircraft = {
  response?: {
    aircraft?: {
      type?: string;
      icao_type?: string;
      manufacturer?: string;
      registration?: string;
      registered_owner?: string;
      registered_owner_country_name?: string;
      registered_owner_operator_flag_code?: string;
      url_photo?: string | null;
    };
  };
};

type PlanespottersPhotos = {
  photos?: Array<{
    link?: string;
    photographer?: string;
    thumbnail_large?: { src?: string };
    thumbnail?: { src?: string };
  }>;
};

const profileCache = new Map<string, { body: AircraftProfile; expiresAt: number }>();

// Both services ask callers to identify themselves and Planespotters requires a
// contact URL in the header, so the deployment URL goes in rather than a
// generic library string.
function requestHeaders() {
  const contact = process.env.NEXT_PUBLIC_SITE_URL || 'https://github.com/topics/adsb';
  return {
    accept: 'application/json',
    'user-agent': `skytrace-globe/1.0 (+${contact})`,
  };
}

async function readJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: requestHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const icao24 = request.nextUrl.searchParams.get('icao24')?.trim().toLowerCase() ?? '';
  if (!/^[0-9a-f]{6}$/.test(icao24)) {
    return NextResponse.json({ error: 'A valid ICAO24 address is required' }, { status: 400 });
  }

  const cached = profileCache.get(icao24);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body, {
      headers: { 'cache-control': 'private, no-store', 'x-skytrace-profile-cache': 'hit' },
    });
  }

  const [registry, photos] = await Promise.all([
    readJson<AdsbDbAircraft>(`https://api.adsbdb.com/v0/aircraft/${icao24}`, 10_000),
    readJson<PlanespottersPhotos>(`https://api.planespotters.net/pub/photos/hex/${icao24}`, 9_000),
  ]);

  const aircraft = registry?.response?.aircraft;
  const picture = photos?.photos?.[0];
  const pictureSource = picture?.thumbnail_large?.src ?? picture?.thumbnail?.src ?? null;
  const body: AircraftProfile = {
    icao24,
    registration: aircraft?.registration ?? null,
    type: aircraft?.type ?? null,
    icaoType: aircraft?.icao_type ?? null,
    manufacturer: aircraft?.manufacturer ?? null,
    owner: aircraft?.registered_owner ?? null,
    ownerCountry: aircraft?.registered_owner_country_name ?? null,
    operatorFlag: aircraft?.registered_owner_operator_flag_code ?? null,
    // Planespotters licences its photos on the condition the photographer is
    // credited and the picture links back, so both travel with the URL.
    photo: pictureSource
      ? {
        url: pictureSource,
        link: picture?.link ?? 'https://www.planespotters.net/',
        photographer: picture?.photographer ?? 'Planespotters.net',
      }
      : aircraft?.url_photo
        ? { url: aircraft.url_photo, link: aircraft.url_photo, photographer: 'adsbdb' }
        : null,
  };

  // An airframe's registry entry does not change during a session; a day is
  // still short enough to pick up a repaint or a new photograph.
  profileCache.set(icao24, { body, expiresAt: Date.now() + 6 * 60 * 60_000 });
  return NextResponse.json(body, {
    headers: { 'cache-control': 'private, no-store', 'x-skytrace-profile-cache': 'miss' },
  });
}
