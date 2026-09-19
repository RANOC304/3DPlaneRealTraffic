# Skytrace

Skytrace is a React + WebGL live air-traffic viewer built around a fully interactive 3D Earth. It retrieves current state vectors from the OpenSky Network through a server-side proxy, renders thousands of aircraft efficiently with instancing, and predicts movement between data snapshots.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

No API credentials are required for the basic experience. Anonymous OpenSky requests are cached for 15 minutes to stay inside the free global-request allowance. Aircraft still move continuously at 60 FPS between snapshots using their real speed, heading, climb rate, and last-contact time. Adding a free OpenSky API client raises the allowance to 4,000 credits a day; a global snapshot costs four of them, so the server reads the remaining balance from each response and paces itself to spend the day's credits evenly — about every 90 seconds. Copy `.env.example` to `.env.local`:

```env
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

## Camera controls

- Click **FLY**, then move the mouse to look around with unrestricted horizontal
  and vertical rotation.
- `Z/W` or `Up` moves exactly where the camera is looking; `S` or `Down` moves backward.
- `Q/A` or `Left` strafes left; `D` or `Right` strafes right without rotating the camera.
- `Space`, `R`, or `E` rises; `Ctrl`, `F`, or `C` descends.
- Hold `Shift` for faster movement.
- Press `Esc` to release the mouse.
- The camera-speed slider applies to both normal globe controls and free flight.
  Free flight keeps the selected speed everywhere in space and does not collide
  with or inherit movement from Earth or aircraft. Normal globe controls still
  become more precise as the camera approaches the ground.

## Data coverage

OpenSky is free and keyless at its anonymous tier, but it is a community receiver network—not a certified, complete registry of every aircraft worldwide. Some aircraft, regions, registrations, routes, and airport details may be missing. Skytrace shows the complete set of position-bearing states returned by the current OpenSky snapshot and clearly switches to preview data if the live source is unavailable.

The whole-Earth base uses NASA Blue Marble imagery, over which Esri World Imagery satellite tiles are draped as a level-of-detail pyramid. Mapzen Terrarium elevation tiles displace that imagery into lit 3D terrain, with a modest vertical exaggeration so relief remains legible from the flight camera. At low altitude, OpenFreeMap vector tiles add OpenStreetMap buildings, building parts, and mapped bridge decks as height-aware 3D solids, plus a lightweight forest canopy over mapped woodland. These local objects stream only around the camera and disappear above orbital viewing height so the worldwide flight view remains responsive. A complete low-zoom layer of the entire globe stays loaded at all times, and finer imagery and elevation are requested coarse-first for whatever the camera can actually see. A tile that has not arrived yet draws the matching part of the nearest tile that has, so moving and zooming sharpen the map in place rather than blanking it. The globe stays photographic at every scale instead of switching to a street-map style.

Aircraft state vectors come from two feeds with different jobs. OpenSky supplies the worldwide backdrop, but a global snapshot is billed against a daily credit allowance, so it can only refresh about every 90 seconds no matter how the key is paced. Real-time motion comes from the community aggregators adsb.lol and adsb.fi, which republish roughly once a second: the airspace the camera is looking at is refetched every five seconds, so the aircraft you are actually watching move from fresh fixes rather than from extrapolation. Where both feeds see the same airframe, the newer fix wins.

Because every predicted position is the last reported one advanced by `speed x (now - report time)`, a browser or server clock that disagrees with the feeds would distort the whole fleet — and a clock far enough out would pin every aircraft against the prediction limits and freeze the sky. Neither end trusts its own clock: both discipline an offset against the timestamps the feeds carry, so aircraft times and the clock they are measured against always share one time base. If the machine's own clock is off by more than half a minute, the data-link panel says so. Selecting or searching a flight also resolves its itinerary and airline from adsbdb, and a photograph of the specific airframe from [Planespotters.net](https://www.planespotters.net/photo/api), credited to the photographer and linked to the original. Departure and arrival times are derived from the observed track and current ground speed — no free source publishes airline schedules, so nothing here is presented as a scheduled time.
