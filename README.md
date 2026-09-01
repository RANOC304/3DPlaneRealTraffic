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
- `ZQSD`, `WASD`, or arrow keys move forward/back/left/right.
- `Space`, `R`, or `E` rises; `Ctrl`, `F`, or `C` descends.
- Hold `Shift` for faster movement.
- Press `Esc` to release the mouse.

## Data coverage

OpenSky is free and keyless at its anonymous tier, but it is a community receiver network—not a certified, complete registry of every aircraft worldwide. Some aircraft, regions, registrations, routes, and airport details may be missing. Skytrace shows the complete set of position-bearing states returned by the current OpenSky snapshot and clearly switches to preview data if the live source is unavailable.

The whole-Earth base uses NASA Blue Marble imagery. As you zoom, the globe loads only the visible OpenStreetMap tiles at progressively finer zoom levels so roads, cities, and place names stay sharp. Aircraft state vectors are provided by the OpenSky Network.
