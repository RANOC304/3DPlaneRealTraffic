import { NextRequest, NextResponse } from 'next/server';

import { queryNetworks } from '@/lib/adsb';
import { preciseNowSeconds } from '@/lib/flight-clock';

// OpenSky only publishes what its own volunteer receivers hear. The community
// aggregators run a separate feeder network, so a flight missing from the main
// snapshot is often still visible here.
export async function GET(request: NextRequest) {
  const callsign = request.nextUrl.searchParams.get('callsign')?.trim().toUpperCase() ?? '';
  if (!/^[A-Z0-9]{3,10}$/.test(callsign)) {
    return NextResponse.json({ error: 'A valid callsign is required' }, { status: 400 });
  }

  const { aircraft } = await queryNetworks({ kind: 'callsign', callsign }, 9_000);
  // A callsign can briefly be shared during a handover; prefer the freshest fix.
  const best = aircraft.sort((a, b) => b.positionTime - a.positionTime)[0] ?? null;

  return NextResponse.json(
    { aircraft: best, source: best?.source ?? null, serverTime: preciseNowSeconds() },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
