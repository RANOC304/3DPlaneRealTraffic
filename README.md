# Skytrace

Skytrace is a React + WebGL live air-traffic viewer built around a fully interactive 3D Earth. It retrieves current state vectors from the OpenSky Network through a server-side proxy, renders thousands of aircraft efficiently with instancing, and predicts movement between data snapshots.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

No API credentials are required for the basic experience. Anonymous OpenSky requests are cached for 15 minutes to stay inside the free global-request allowance. Aircraft still move continuously at 60 FPS between snapshots using their real speed, heading, climb rate, and last-contact time. For a sustainable 90-second source refresh, create a free OpenSky API client and copy `.env.example` to `.env.local`:

```env
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

## Camera controls

- Click **FLY**, then move the mouse to look around.
- `ZQSD`, `WASD`, or arrow keys move forward/back and turn left/right around the Y axis.
- `Space`, `R`, or `E` rises; `Ctrl`, `F`, or `C` descends.
- Hold `Shift` for faster movement.
- Press `Esc` to release the mouse.
- The camera-speed slider applies to both normal globe controls and free flight.
  It starts at `0.001 u/s` (ten times below the previous minimum), and movement
  automatically becomes more precise as the camera approaches the ground.

## Data coverage

OpenSky is free and keyless at its anonymous tier, but it is a community receiver network—not a certified, complete registry of every aircraft worldwide. Some aircraft, regions, registrations, routes, and airport details may be missing. Skytrace shows the complete set of position-bearing states returned by the current OpenSky snapshot and clearly switches to preview data if the live source is unavailable.

The whole-Earth base uses NASA Blue Marble imagery, over which Esri World Imagery satellite tiles are draped as a level-of-detail pyramid. Mapzen Terrarium elevation tiles displace that imagery into lit 3D terrain, with a modest vertical exaggeration so relief remains legible from the flight camera. A complete low-zoom layer of the entire globe stays loaded at all times, and finer imagery and elevation are requested coarse-first for whatever the camera can actually see. A tile that has not arrived yet draws the matching part of the nearest tile that has, so moving and zooming sharpen the map in place rather than blanking it. The globe stays photographic at every scale instead of switching to a street-map style.

Aircraft state vectors are provided by the OpenSky Network, with adsb.lol and adsb.fi filling coverage gaps. Selecting or searching a flight also resolves its itinerary and airline from adsbdb, and a photograph of the specific airframe from [Planespotters.net](https://www.planespotters.net/photo/api), credited to the photographer and linked to the original. Departure and arrival times are derived from the observed track and current ground speed — no free source publishes airline schedules, so nothing here is presented as a scheduled time.
