# Skytrace

Skytrace is a React and WebGL air-traffic viewer with an interactive 3D Earth, live aircraft positions, and a free-flight camera. Search for a flight, select an aircraft to follow it, or fly down to the terrain and explore.

![Skytrace live 3D air traffic](public/og.png)

## Run locally

Install Node.js 22.13 or later and npm. Run these commands from the repository root, then open [localhost:3000](http://localhost:3000).

```sh
npm ci
npm run dev
```

Build a production bundle with `npm run build`. Run the built worker locally with `npm start`. Local development and builds require no hosting account.

### Configuration

The development server can start without credentials. For optional settings, copy [`.env.example`](.env.example) to `.env.local`. Keep the OpenSky client secret server-side. Set `NEXT_PUBLIC_SITE_URL` to the deployed origin for social-preview links. The example file also lists overrides for imagery, elevation, and vector tile sources.

OpenSky requires written permission for commercial use and for operational use of its API in a live service or automated system. Review the provider terms and attribution requirements before deploying with live data. [OpenSky terms](https://opensky-network.org/about/terms-of-use) · [Third-party notices](THIRD_PARTY_NOTICES.md)

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

Skytrace plots position-bearing states returned by OpenSky. Receiver coverage varies by region, so aircraft and route details can be missing. When OpenSky is unavailable, the globe can show labeled preview aircraft.

The globe combines NASA Blue Marble imagery, Esri satellite tiles, and Mapzen Terrarium elevation data. At low altitude, OpenFreeMap tiles add buildings, bridges, and forest canopy drawn from OpenStreetMap. Finer tiles load around the camera as you move.

OpenSky supplies global snapshots. Anonymous requests are cached for 15 minutes, and authenticated refreshes are paced against the API's reported credit allowance. The map fetches more frequent local fixes from adsb.lol and ADSB.fi as you move the camera. When both feeds see the same aircraft, the newer fix wins. Aircraft move between fixes using their reported speed, heading, and climb rate.

The browser and server use feed timestamps to keep position predictions aligned. The data-link panel flags clock differences greater than 30 seconds. When available, flight details include route and airline information from adsbdb and an aircraft photo credited to its photographer. Departure and arrival estimates use the observed track and current ground speed. [Planespotters.net Photo API](https://www.planespotters.net/photo/api)

## Contributing

Bug reports and pull requests are welcome. See the [contributing guide](CONTRIBUTING.md) for what to include.

## License

Skytrace's original source code is available under the [MIT License](LICENSE). Bundled third-party material and external data services have their own terms. See the [third-party notices](THIRD_PARTY_NOTICES.md).
