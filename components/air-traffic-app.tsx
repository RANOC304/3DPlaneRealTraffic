'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls, PointerLockControls, Stars, useTexture } from '@react-three/drei';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleHelp,
  Crosshair,
  Filter,
  Gauge,
  Globe2,
  LocateFixed,
  Maximize2,
  MapPin,
  MousePointer2,
  Navigation,
  Plane,
  Plus,
  Radio,
  RefreshCw,
  Route,
  Search,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Euler,
  Float32BufferAttribute,
  InstancedMesh,
  type MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';

import {
  type AircraftVariant,
  type SpinningPart,
  createFleetAircraftGeometry,
  createHeroAircraft,
  fleetWingSpan,
  heroWingSpan,
  surfaceMaterial,
} from '@/lib/aircraft-geometry';
import { iataToIcaoAirline } from '@/lib/airline-codes';
import {
  airportUtcOffset,
  formatLocalTime,
  formatUtcOffset,
  localDayShift,
} from '@/lib/airport-time';
import {
  type MapTile,
  baseMapTiles,
  buildMapTileGeometry,
  configureMapTiles,
  isMapTileReady,
  resolveMapTile,
  selectMapTiles,
  subscribeToMapTiles,
} from '@/lib/map-tiles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

type Aircraft = {
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
  // Present only for aircraft resolved through the extended ADS-B networks,
  // which publish more about the airframe than the OpenSky snapshot does.
  registration?: string | null;
  model?: string | null;
  source?: string;
};

type FeedResponse = {
  source: 'opensky';
  mode: 'anonymous' | 'authenticated';
  sourceTimestamp: number;
  receivedAt: number;
  refreshAfter: number;
  nextRefreshAt: number;
  count: number;
  aircraft: AircraftWire[];
};

type AircraftWire = [
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
];

function decodeAircraft([
  id,
  callsign,
  country,
  lat,
  lon,
  altitude,
  onGround,
  speed,
  heading,
  verticalRate,
  positionTime,
  lastContact,
  squawk,
  positionSource,
  category,
]: AircraftWire): Aircraft {
  return {
    id,
    callsign,
    country,
    lat,
    lon,
    altitude,
    geoAltitude: null,
    onGround,
    speed,
    heading,
    verticalRate,
    positionTime,
    lastContact,
    squawk,
    spi: false,
    positionSource,
    category,
  };
}

type FeedState = 'connecting' | 'live' | 'preview';
type FlightStateFilter = 'airborne' | 'ground' | 'all';

type RouteAirport = {
  countryIso: string;
  country: string;
  iata: string;
  icao: string;
  latitude: number;
  longitude: number;
  municipality: string;
  name: string;
};

type FlightRoute = {
  callsign: string;
  // The flight number as a passenger would recognise it, when the schedule
  // database knows one: the transponder only ever broadcasts the ICAO form.
  callsignIata: string | null;
  airline: string | null;
  origin: RouteAirport | null;
  destination: RouteAirport | null;
  midpoint: RouteAirport | null;
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

type CountryFeature = {
  properties: {
    ADMIN?: string;
    NAME?: string;
    LABEL_X?: number;
    LABEL_Y?: number;
    LABELRANK?: number;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
};

type CountryGeoJson = { features: CountryFeature[] };

// A saved aircraft keeps both identities: the airframe (ICAO24) and the flight
// number it was saved under, so a list keeps matching when either one returns.
type FavoriteEntry = { icao24: string; callsign: string };
type FavoriteList = { id: string; name: string; entries: FavoriteEntry[] };

const favoritesStorageKey = 'skytrace.favorite-lists.v1';

function matchesFavorite(flight: Aircraft, entry: FavoriteEntry) {
  return flight.id === entry.icao24
    || (entry.callsign.length > 0 && flight.callsign.toUpperCase() === entry.callsign.toUpperCase());
}

function isFavoriteList(value: unknown): value is FavoriteList {
  if (!value || typeof value !== 'object') return false;
  const list = value as FavoriteList;
  return typeof list.id === 'string'
    && typeof list.name === 'string'
    && Array.isArray(list.entries)
    && list.entries.every((entry) => entry
      && typeof entry.icao24 === 'string'
      && typeof entry.callsign === 'string');
}

function useFavoriteLists() {
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(favoritesStorageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      // Storage is shared with older builds and hand-edited data, so keep only
      // entries that still have the shape the app relies on.
      if (Array.isArray(parsed)) setLists(parsed.filter(isFavoriteList));
    } catch {
      // Unreadable or blocked storage just starts from an empty shelf.
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    // Never write before the restore pass, or the initial empty state would
    // erase the saved lists on every page load.
    if (!restored) return;
    try {
      window.localStorage.setItem(favoritesStorageKey, JSON.stringify(lists));
    } catch {
      // Full or blocked storage must not break the session.
    }
  }, [lists, restored]);

  return { lists, setLists };
}

// Airlines publish flight numbers with their two-character IATA code ("EY394"),
// but transponders broadcast the three-letter ICAO form ("ETD394"). Search both
// so a printed flight number finds the aircraft.
function searchTerms(query: string) {
  const terms = [query];
  const flightNumber = /^([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)$/.exec(query);
  const icao = flightNumber && iataToIcaoAirline[flightNumber[1]];
  if (icao) terms.push(icao + flightNumber[2]);
  return terms;
}

function matchesSearch(flight: Aircraft, terms: string[], exact: boolean) {
  const callsign = flight.callsign.toUpperCase();
  const id = flight.id.toUpperCase();
  return terms.some((term) => (exact
    ? callsign === term || id === term
    : callsign.includes(term) || id.includes(term)));
}

// Base UI reports a bare number for single-thumb sliders and an array only for
// range sliders, so the single-value sliders must normalise back to a tuple.
function toSliderTuple(value: number | readonly number[]): number[] {
  return Array.isArray(value) ? [...(value as readonly number[])] : [value as number];
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const preciseNowSeconds = () => Date.now() / 1000;
const formatNumber = (value: number) => Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const previewFlights: Aircraft[] = [
  ['4ca7b3', 'RYR8VX', 'Ireland', 51.47, -0.45, 10668, 231, 112, 4, 3],
  ['a2b8f4', 'UAL923', 'United States', 48.1, -18.2, 11582, 249, 71, 0, 5],
  ['3c65a8', 'DLH441', 'Germany', 52.1, 9.9, 10120, 219, 94, -2, 3],
  ['896318', 'UAE2', 'United Arab Emirates', 41.6, 27.2, 11887, 252, 298, 1, 5],
  ['780a12', 'CPA255', 'Hong Kong', 37.9, 72.4, 10972, 243, 285, 0, 5],
  ['ab3f12', 'AAL100', 'United States', 41.1, -57.2, 11278, 246, 82, -1, 5],
  ['7c6b2a', 'QFA9', 'Australia', -12.5, 112.6, 12192, 257, 301, 0, 5],
  ['e48b21', 'TAM8084', 'Brazil', -18.4, -35.7, 10363, 235, 42, 2, 3],
  ['008a2d', 'SAA204', 'South Africa', -28.2, 27.6, 11430, 248, 214, -1, 5],
  ['86d8a1', 'ANA215', 'Japan', 39.5, 143.1, 9753, 225, 71, 2, 3],
  ['02018c', 'RAM201', 'Morocco', 36.2, -9.8, 8847, 207, 194, -2, 3],
  ['c81f21', 'ANZ1', 'New Zealand', -31.4, 169.8, 11980, 251, 224, 0, 5],
  ['400ae2', 'BAW17', 'United Kingdom', 56.1, -31.2, 11010, 239, 264, 1, 5],
  ['7502a1', 'MAS4', 'Malaysia', 17.3, 86.4, 10820, 242, 310, -1, 5],
  ['06a1e3', 'QTR739', 'Qatar', 28.7, 54.1, 11630, 250, 288, 0, 5],
  ['3446d1', 'IBE6251', 'Spain', 33.4, -22.8, 10240, 234, 251, 2, 3],
] .map(([id, callsign, country, lat, lon, altitude, speed, heading, verticalRate, category]) => ({
  id: id as string,
  callsign: callsign as string,
  country: country as string,
  lat: lat as number,
  lon: lon as number,
  altitude: altitude as number,
  geoAltitude: altitude as number,
  onGround: false,
  speed: speed as number,
  heading: heading as number,
  verticalRate: verticalRate as number,
  positionTime: nowSeconds(),
  lastContact: nowSeconds(),
  squawk: null,
  spi: false,
  positionSource: 0,
  category: category as number,
}));

const categoryLabels: Record<number, string> = {
  0: 'No category',
  1: 'No ADS-B category',
  2: 'Light aircraft',
  3: 'Small aircraft',
  4: 'Large aircraft',
  5: 'High-vortex aircraft',
  6: 'Heavy aircraft',
  7: 'High performance',
  8: 'Rotorcraft',
  9: 'Glider / sailplane',
  10: 'Lighter-than-air',
  11: 'Parachutist',
  12: 'Ultralight',
  14: 'Unmanned aircraft',
  15: 'Space vehicle',
  16: 'Emergency vehicle',
  17: 'Service vehicle',
  18: 'Ground obstruction',
};

const sourceLabels = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];
const earthRadius = 2.4;
// Keep the fallback globe just beneath the satellite mesh, and reserve a tiny
// air gap above that mesh for the closest possible camera position.
const earthBaseRadius = earthRadius - 0.0002;
const mapSurfaceRadius = earthRadius + 0.00001;
// About fifty metres over the ground at globe scale — low enough that the
// deepest satellite level is worth reaching, still clear of the tile shell.
const minimumCameraAltitude = 0.00002;
const minimumCameraRadius = earthRadius + minimumCameraAltitude;
const earthKilometers = 6371;
const upVector = new Vector3(0, 1, 0);
const degrees = Math.PI / 180;
const maxReportAgeSeconds = 1800;
// Aircraft are drawn far larger than true scale so they read as aircraft rather
// than as single pixels from orbit. This is that exaggeration factor.
const aircraftSizeFactor = 0.1;
// Even exaggerated, an airframe covers about a pixel of the globe seen from
// orbit, so hit-testing the model itself is a test of aim rather than of
// intent. Selection instead claims a fixed disc of screen around each aircraft,
// the same size at any zoom, and picks the nearest aircraft inside it.
const selectionPixelRadius = 13;
// Free flight covers everything from creeping along a coastline to crossing an
// ocean, so the throttle is exponential: the slider carries a 0-1 position and
// every step of it is the same proportional change in speed. A linear scale
// over this range would bury every usable slow speed in its first few pixels.
const minimumFlySpeed = 0.01;
const maximumFlySpeed = 6;

/** Scene units per second for a 0-1 throttle position. */
function flySpeedFor(throttle: number) {
  return minimumFlySpeed * (maximumFlySpeed / minimumFlySpeed) ** throttle;
}

/** Smallest reusable instance buffer that can hold the current fleet bucket. */
function instanceCapacity(count: number) {
  if (count <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(count));
}

/**
 * True when the globe itself stands between the camera and `target`, so an
 * aircraft over the far hemisphere is not offered to a click aimed at the near
 * one. `offset` must already be `target - origin`.
 */
function occludedByGlobe(origin: Vector3, offset: Vector3) {
  const a = offset.lengthSq();
  if (a < 1e-12) return false;
  const b = 2 * origin.dot(offset);
  const c = origin.lengthSq() - earthRadius * earthRadius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) return false;
  const entry = (-b - Math.sqrt(discriminant)) / (2 * a);
  return entry > 0 && entry < 1;
}

/** Distance over the ground between two coordinates, in kilometres. */
function greatCircleKm(fromLat: number, fromLon: number, toLat: number, toLon: number) {
  const lat1 = fromLat * degrees;
  const lat2 = toLat * degrees;
  const deltaLat = (toLat - fromLat) * degrees;
  const deltaLon = (toLon - fromLon) * degrees;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthKilometers * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** `3h 31m`, or `39m` under the hour. */
function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(total / 60);
  return hours > 0 ? `${hours}h ${String(total % 60).padStart(2, '0')}m` : `${total}m`;
}

function latLonPosition(lat: number, lon: number, radius: number, target = new Vector3()) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return target.set(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function predictCoordinates(flight: Aircraft, timestamp: number, extraSeconds = 0, motionScale = 1) {
  if (flight.onGround || flight.speed <= 0) return { lat: flight.lat, lon: flight.lon };

  const seconds = predictionSeconds(flight, timestamp, extraSeconds, motionScale);
  // Great-circle dead reckoning. Stepping latitude and longitude separately (the
  // previous approach) drifts badly past a few hundred kilometres and breaks
  // down entirely near the poles, which the time-lapse clock now reaches often.
  const angular = (flight.speed * seconds) / 1000 / earthKilometers;
  const bearing = flight.heading * degrees;
  const lat1 = flight.lat * degrees;
  const lon1 = flight.lon * degrees;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angular);
  const cosAngular = Math.cos(angular);
  const lat2 = Math.asin(sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * sinAngular * cosLat1,
    cosAngular - sinLat1 * Math.sin(lat2),
  );
  return { lat: lat2 / degrees, lon: ((lon2 / degrees + 540) % 360) - 180 };
}

function predictionSeconds(flight: Aircraft, timestamp: number, extraSeconds = 0, motionScale = 1) {
  const reportAge = timestamp - (flight.positionTime ?? flight.lastContact);
  // Bound how stale a *report* may be before we stop trusting it, then apply the
  // time-lapse factor. Clamping after scaling pinned every aircraft to a fixed
  // offset — the whole fleet froze once the cached snapshot aged past the cap.
  return (Math.max(-900, Math.min(maxReportAgeSeconds, reportAge)) + extraSeconds) * motionScale;
}

function globePosition(
  flight: Aircraft,
  timestamp: number,
  predictive: boolean,
  extraSeconds = 0,
  target = new Vector3(),
  motionScale = 1,
) {
  const coords = predictive
    ? predictCoordinates(flight, timestamp, extraSeconds, motionScale)
    : { lat: flight.lat, lon: flight.lon };
  const projectedAltitude = predictive
    ? Math.max(0, flight.altitude + flight.verticalRate * predictionSeconds(flight, timestamp, extraSeconds, motionScale))
    : flight.altitude;
  const altitudeOffset = flight.onGround ? 0.006 : Math.min(0.075, Math.max(0.014, projectedAltitude / 260000));
  const radius = earthRadius + altitudeOffset;
  return latLonPosition(coords.lat, coords.lon, radius, target);
}

function useAircraftFeed(refreshKey: number) {
  const [aircraft, setAircraft] = useState<Aircraft[]>(previewFlights);
  const [state, setState] = useState<FeedState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Pick<FeedResponse, 'mode' | 'sourceTimestamp' | 'refreshAfter'> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const response = await fetch('/api/flights', { cache: 'no-store' });
        const data = (await response.json()) as FeedResponse | { error: string };
        if (!response.ok || !('aircraft' in data)) {
          throw new Error('error' in data ? data.error : 'Live feed unavailable');
        }
        if (cancelled) return;
        setAircraft(data.aircraft.map(decodeAircraft));
        setMeta({ mode: data.mode, sourceTimestamp: data.sourceTimestamp, refreshAfter: data.refreshAfter });
        setState('live');
        setError(null);
        // Wake up when the server says the next snapshot is actually due, so a
        // new fix reaches the globe within seconds of existing. Polling on a
        // blind interval instead either re-downloads the same snapshot or lets
        // a fresh one sit unused for most of a refresh period.
        const dueIn = data.nextRefreshAt * 1000 - Date.now() + 2_000;
        timer = setTimeout(load, Math.min(data.refreshAfter * 1000, Math.max(5_000, dueIn)));
      } catch (loadError) {
        if (cancelled) return;
        setState('preview');
        setError(loadError instanceof Error ? loadError.message : 'Live feed unavailable');
        timer = setTimeout(load, 60_000);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshKey]);

  return { aircraft, state, error, meta };
}

function useFlightRoute(flight: Aircraft | null) {
  const [route, setRoute] = useState<FlightRoute | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!flight) {
      setRoute(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setRoute(null);
    setLoading(true);
    void fetch(`/api/flight-route?icao24=${encodeURIComponent(flight.id)}&callsign=${encodeURIComponent(flight.callsign)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Route intelligence unavailable');
        return (await response.json()) as FlightRoute;
      })
      .then((data) => setRoute(data))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setRoute(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [flight?.callsign, flight?.id]);

  return { route, loading };
}

// The registry entry and photograph for one airframe. Keyed on the ICAO24, so
// following the same aircraft through several callsigns never re-fetches it.
function useAircraftProfile(icao24: string | null) {
  const [profile, setProfile] = useState<AircraftProfile | null>(null);

  useEffect(() => {
    if (!icao24) {
      setProfile(null);
      return;
    }

    const controller = new AbortController();
    setProfile(null);
    void fetch(`/api/aircraft-profile?icao24=${encodeURIComponent(icao24)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? ((await response.json()) as AircraftProfile) : null))
      .then((data) => setProfile(data))
      .catch(() => {});

    return () => controller.abort();
  }, [icao24]);

  return profile;
}

function MapTileMesh({ tile }: { tile: MapTile }) {
  // Whatever imagery exists for this ground right now: its own if it has
  // arrived, otherwise the nearest ancestor's, so the tile is never a hole.
  const source = resolveMapTile(tile);
  const sourceZoom = source?.zoom ?? tile.zoom;
  const geometry = useMemo(
    () => buildMapTileGeometry(tile, mapSurfaceRadius, sourceZoom),
    [sourceZoom, tile],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  if (!source) return null;
  return (
    // Levels are layered by draw order rather than by depth: the tiles all sit
    // on one sphere, so letting them write depth makes the finer level fight the
    // coarser one it is refining. The opaque globe underneath still occludes
    // everything on the far side.
    <mesh geometry={geometry} renderOrder={tile.zoom}>
      <meshBasicMaterial map={source.texture} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

function sameTiles(current: MapTile[], next: MapTile[]) {
  return current.length === next.length && current.every((tile, index) => tile.key === next[index].key);
}

function DetailedEarthMap() {
  const { camera, gl } = useThree();
  const [tiles, setTiles] = useState<MapTile[]>(baseMapTiles);
  const [, setRevision] = useState(0);
  const lastSelection = useRef<MapTile[]>(baseMapTiles);
  // Ground that has left the selection but still has imagery loaded. Holding it
  // for a moment means a fast zoom or pan is covered by the map it is leaving
  // until the map it is arriving at can take over.
  const fading = useRef(new Map<string, { tile: MapTile; expiresAt: number }>());
  const lastCheck = useRef(0);

  useEffect(() => {
    configureMapTiles(Math.min(16, gl.capabilities.getMaxAnisotropy()));
  }, [gl]);

  useEffect(() => subscribeToMapTiles(() => setRevision((value) => value + 1)), []);

  useFrame(() => {
    const now = performance.now();
    if (now - lastCheck.current < 150) return;
    lastCheck.current = now;

    const selection = selectMapTiles({
      camera: camera as PerspectiveCamera,
      radius: mapSurfaceRadius,
      viewportHeight: gl.domElement.height,
    });
    const live = new Set(selection.map((tile) => tile.key));

    for (const tile of lastSelection.current) {
      if (!live.has(tile.key) && isMapTileReady(tile)) {
        fading.current.set(tile.key, { tile, expiresAt: now + 1500 });
      }
    }
    lastSelection.current = selection;
    for (const [key, entry] of fading.current) {
      if (live.has(key) || entry.expiresAt <= now) fading.current.delete(key);
    }
    while (fading.current.size > 160) fading.current.delete(fading.current.keys().next().value!);

    const rendered = [...selection, ...[...fading.current.values()].map((entry) => entry.tile)];
    setTiles((current) => (sameTiles(current, rendered) ? current : rendered));
  });

  return <>{tiles.map((tile) => <MapTileMesh key={tile.key} tile={tile} />)}</>;
}

function Atmosphere() {
  const { camera } = useThree();
  const inner = useRef<MeshBasicMaterial>(null);
  const outer = useRef<MeshBasicMaterial>(null);

  useFrame(() => {
    // The orbital glow looks good from space, but a back-faced atmosphere shell
    // becomes a cyan pane over the entire map after the camera flies inside it.
    // Fade it away before low-altitude map detail becomes visible.
    const visibility = Math.max(0, Math.min(1, (camera.position.length() - 2.72) / 0.68));
    if (inner.current) inner.current.opacity = 0.095 * visibility;
    if (outer.current) outer.current.opacity = 0.028 * visibility;
  });

  return (
    <>
      <mesh>
        <sphereGeometry args={[earthRadius + 0.055, 64, 64]} />
        <meshBasicMaterial ref={inner} color="#55dcff" transparent opacity={0.095} side={BackSide} depthWrite={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[earthRadius + 0.13, 64, 64]} />
        <meshBasicMaterial ref={outer} color="#3dbfe8" transparent opacity={0.028} side={BackSide} depthWrite={false} />
      </mesh>
    </>
  );
}

function Earth() {
  const { gl } = useThree();
  const texture = useTexture('/earth-day.jpg');
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy());

  return (
    <group>
      <mesh>
        <sphereGeometry args={[earthBaseRadius, 96, 96]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      <DetailedEarthMap />
      <Atmosphere />
    </group>
  );
}

// When the OpenSky snapshot has no match, ask the extended ADS-B networks for
// the live aircraft and, failing that, for a scheduled route — so the search can
// tell "no such flight" apart from "real flight, outside this network's reach".
function useCallsignLookup(callsign: string | null) {
  const [route, setRoute] = useState<FlightRoute | null>(null);
  const [found, setFound] = useState<{ aircraft: Aircraft; source: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!callsign) {
      setRoute(null);
      setFound(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setRoute(null);
    setFound(null);
    setLoading(true);
    // Debounced so typing a flight number does not fire a request per keystroke.
    const timer = window.setTimeout(() => {
      const options = { cache: 'no-store' as const, signal: controller.signal };
      void Promise.allSettled([
        fetch(`/api/flight-lookup?callsign=${encodeURIComponent(callsign)}`, options)
          .then(async (response) => (response.ok
            ? ((await response.json()) as { aircraft: Aircraft | null; source: string | null })
            : null)),
        fetch(`/api/flight-route?callsign=${encodeURIComponent(callsign)}`, options)
          .then(async (response) => (response.ok ? ((await response.json()) as FlightRoute) : null)),
      ]).then(([liveResult, routeResult]) => {
        if (controller.signal.aborted) return;
        const live = liveResult.status === 'fulfilled' ? liveResult.value : null;
        if (live?.aircraft && live.source) setFound({ aircraft: live.aircraft, source: live.source });
        setRoute(routeResult.status === 'fulfilled' ? routeResult.value : null);
        setLoading(false);
      });
    }, 450);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [callsign]);

  return { route, found, loading };
}

// The patch of globe the camera can actually see, expressed the way the ADS-B
// networks want it: a centre point and a radius in nautical miles.
function cameraFootprint(position: [number, number, number]) {
  const [x, y, z] = position;
  const distance = Math.hypot(x, y, z);
  if (!Number.isFinite(distance) || distance <= earthRadius) return null;

  const lat = Math.asin(y / distance) / degrees;
  const lon = ((Math.atan2(z, -x) / degrees - 180) + 540) % 360 - 180;
  // Angular radius of the visible cap from this altitude.
  const horizon = Math.acos(earthRadius / distance);
  const nauticalMiles = (horizon * earthKilometers) / 1.852;
  return { lat, lon, radius: Math.min(3000, Math.max(60, Math.round(nauticalMiles))) };
}

function useNetworkAircraft(enabled: boolean, globalSweep: boolean, cameraPosition: [number, number, number]) {
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [sources, setSources] = useState<string[]>([]);

  // Round the footprint so ordinary camera drift does not restart the request.
  const footprint = useMemo(() => {
    if (globalSweep) return 'global';
    const view = cameraFootprint(cameraPosition);
    if (!view) return null;
    return `${Math.round(view.lat)}:${Math.round(view.lon)}:${Math.round(view.radius / 100) * 100}`;
  }, [cameraPosition, globalSweep]);

  useEffect(() => {
    if (!enabled || !footprint) {
      if (!enabled) { setAircraft([]); setSources([]); }
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = footprint === 'global'
      ? 'mode=global'
      : (() => {
        const [lat, lon, radius] = footprint.split(':');
        return `mode=region&lat=${lat}&lon=${lon}&radius=${radius}`;
      })();

    const load = async () => {
      try {
        const response = await fetch(`/api/flight-network?${query}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('network feed unavailable');
        const data = (await response.json()) as { aircraft: Aircraft[]; sources: string[] };
        if (cancelled) return;
        setAircraft(data.aircraft);
        setSources(data.sources ?? []);
      } catch {
        // Leave the previous result on screen; the next tick may succeed.
      }
      if (!cancelled) timer = setTimeout(load, globalSweep ? 60_000 : 25_000);
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, footprint, globalSweep]);

  return { aircraft, sources };
}

function useCountryGeo(enabled: boolean) {
  const [geo, setGeo] = useState<CountryGeoJson | null>(null);

  useEffect(() => {
    if (!enabled || geo) return;

    let cancelled = false;
    fetch('/data/countries.geojson', { cache: 'force-cache' })
      .then((response) => response.json() as Promise<CountryGeoJson>)
      .then((data) => { if (!cancelled) setGeo(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled, geo]);

  return geo;
}

function CountryBorders({ geo }: { geo: CountryGeoJson }) {
  const geometry = useMemo(() => {
    const radius = earthRadius + 0.0022;
    const positions: number[] = [];
    const pushRing = (ring: number[][]) => {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = latLonPosition(ring[i][1], ring[i][0], radius);
        const b = latLonPosition(ring[i + 1][1], ring[i + 1][0], radius);
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    };
    geo.features.forEach((feature) => {
      const { type, coordinates } = feature.geometry;
      if (type === 'Polygon') (coordinates as number[][][]).forEach(pushRing);
      else (coordinates as number[][][][]).forEach((polygon) => polygon.forEach(pushRing));
    });
    const bufferGeometry = new BufferGeometry();
    bufferGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return bufferGeometry;
  }, [geo]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color="#59c7ff" transparent opacity={0.38} depthWrite={false} />
    </lineSegments>
  );
}

const labelTextureCache = new Map<string, { texture: CanvasTexture; aspect: number }>();

function buildLabelTexture(text: string, color: string) {
  const scale = 4;
  const fontSize = 26 * scale;
  const measurer = document.createElement('canvas').getContext('2d')!;
  measurer.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  const textWidth = measurer.measureText(text).width;
  const paddingX = 14 * scale;
  const width = Math.ceil(textWidth + paddingX * 2);
  const height = Math.ceil(fontSize * 1.55);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = fontSize * 0.22;
  ctx.strokeStyle = 'rgba(1,8,13,0.88)';
  ctx.strokeText(text, width / 2, height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, aspect: width / height };
}

function getLabelTexture(text: string, color: string) {
  const key = `${color}|${text}`;
  let entry = labelTextureCache.get(key);
  if (!entry) {
    entry = buildLabelTexture(text, color);
    labelTextureCache.set(key, entry);
  }
  return entry;
}

function LabelSprite({
  position,
  text,
  color = '#bfe9ff',
  height = 0.05,
}: {
  position: Vector3;
  text: string;
  color?: string;
  height?: number;
}) {
  const { texture, aspect } = useMemo(() => getLabelTexture(text, color), [text, color]);
  return (
    <sprite position={position} scale={[height * aspect, height, 1]}>
      <spriteMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

// The close-up model is authored several times larger than the instanced fleet
// geometry. Normalising by the wingspan ratio keeps a searched aircraft exactly
// the size it was on the map before it became the selection.
const detailedModelUnitScale: Record<AircraftVariant, number> = {
  jet: fleetWingSpan.jet / heroWingSpan.jet,
  heavy: fleetWingSpan.heavy / heroWingSpan.heavy,
  light: fleetWingSpan.light / heroWingSpan.light,
  rotor: fleetWingSpan.rotor / heroWingSpan.rotor,
};

function aircraftVariant(category: number): AircraftVariant {
  if (category === 8) return 'rotor';
  if ([2, 9, 12, 14].includes(category)) return 'light';
  if ([5, 6].includes(category)) return 'heavy';
  return 'jet';
}

// The globe is lit by a cold blue key and a deep blue rim, which drags a yellow
// airframe toward olive, and a plainly lit aircraft disappears over bright
// desert or cloud. Feeding each surface's own baked colour back into the
// emissive term makes the airframe partly self-lit: bright panels hold their
// yellow and stand clear of any terrain, while glass, fan faces and tyres stay
// dark, so the shape still reads instead of flattening into a blob.
function useSelfLitFleetMaterial() {
  const material = useMemo(() => {
    const created = new MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.36,
      roughness: 0.4,
    });
    created.onBeforeCompile = (shader) => {
      shader.uniforms.uSelfLit = { value: 0.5 };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', 'uniform float uSelfLit;\n#include <common>')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor.rgb * uSelfLit;',
        );
    };
    return created;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

function AircraftInstances({
  aircraft,
  variant,
  selectedId,
  predictive,
  motionScale,
}: {
  aircraft: Aircraft[];
  variant: AircraftVariant;
  selectedId?: string;
  predictive: boolean;
  motionScale: number;
}) {
  const { camera } = useThree();
  const ref = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const orientation = useMemo(() => new Quaternion(), []);
  const radial = useMemo(() => new Vector3(), []);
  const headingRotation = useMemo(() => new Quaternion(), []);
  const targetPosition = useMemo(() => new Vector3(), []);
  const smoothedPositions = useRef(new Map<string, Vector3>());
  const smoothedOrientations = useRef(new Map<string, Quaternion>());
  const geometry = useMemo(() => createFleetAircraftGeometry(variant), [variant]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useSelfLitFleetMaterial();

  // The instance buffer is sized in powers of two and only ever grows, so the
  // live count moving with every feed refresh re-uses the same mesh instead of
  // reallocating one several times a minute. `count` is what tracks the total
  // actually in the sky.
  const [capacity, setCapacity] = useState(() => instanceCapacity(aircraft.length));
  useEffect(() => {
    setCapacity((current) => (aircraft.length > current ? instanceCapacity(aircraft.length) : current));
  }, [aircraft.length]);
  const drawn = Math.min(aircraft.length, capacity);

  const updateMatrices = useCallback((timestamp: number, delta: number) => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.count = drawn;
    const blend = 1 - Math.exp(-Math.min(delta, 0.1) * 7.5);
    for (let index = 0; index < drawn; index++) {
      const flight = aircraft[index];
      globePosition(flight, timestamp, predictive, 0, targetPosition, motionScale);
      let position = smoothedPositions.current.get(flight.id);
      if (!position) {
        position = targetPosition.clone();
        smoothedPositions.current.set(flight.id, position);
      } else {
        position.lerp(targetPosition, blend);
      }
      radial.copy(targetPosition).normalize();
      orientation.setFromUnitVectors(upVector, radial);
      headingRotation.setFromAxisAngle(radial, -flight.heading * (Math.PI / 180));
      orientation.premultiply(headingRotation);
      let smoothOrientation = smoothedOrientations.current.get(flight.id);
      if (!smoothOrientation) {
        smoothOrientation = orientation.clone();
        smoothedOrientations.current.set(flight.id, smoothOrientation);
      } else {
        smoothOrientation.slerp(orientation, blend);
      }
      dummy.position.copy(position);
      dummy.quaternion.copy(smoothOrientation);
      // Below the reference distance, scale stays at 1 so natural perspective
      // makes aircraft grow larger as the camera approaches. Beyond it, scale
      // grows with distance so aircraft remain a readable size from orbit.
      const distanceScale = Math.min(6, Math.max(1, position.distanceTo(camera.position) / 4.5));
      const scale = flight.id === selectedId
        ? 0
        : distanceScale * aircraftSizeFactor * (flight.onGround ? 0.78 : 1);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [aircraft, camera, drawn, dummy, headingRotation, motionScale, orientation, predictive, radial, selectedId, targetPosition]);

  useEffect(() => {
    const visibleIds = new Set(aircraft.map((flight) => flight.id));
    smoothedPositions.current.forEach((_, id) => {
      if (!visibleIds.has(id)) smoothedPositions.current.delete(id);
    });
    smoothedOrientations.current.forEach((_, id) => {
      if (!visibleIds.has(id)) smoothedOrientations.current.delete(id);
    });
  }, [aircraft]);

  useLayoutEffect(() => {
    if (ref.current) ref.current.instanceMatrix.setUsage(DynamicDrawUsage);
    updateMatrices(preciseNowSeconds(), 1);
  }, [updateMatrices]);

  useFrame((_, delta) => {
    updateMatrices(preciseNowSeconds(), delta);
  });

  return (
    <group>
      <instancedMesh
        ref={ref}
        args={[undefined, undefined, capacity]}
        frustumCulled={false}
      >
        <primitive object={geometry} attach="geometry" />
        <primitive object={material} attach="material" />
      </instancedMesh>
    </group>
  );
}

function AircraftFleet(props: Omit<Parameters<typeof AircraftInstances>[0], 'aircraft' | 'variant'> & { aircraft: Aircraft[] }) {
  const buckets = useMemo(() => {
    const result: Record<AircraftVariant, Aircraft[]> = { jet: [], heavy: [], light: [], rotor: [] };
    props.aircraft.forEach((flight) => result[aircraftVariant(flight.category)].push(flight));
    return result;
  }, [props.aircraft]);

  return (
    <>
      {(Object.keys(buckets) as AircraftVariant[]).map((variant) => (
        <AircraftInstances key={variant} {...props} variant={variant} aircraft={buckets[variant]} />
      ))}
    </>
  );
}

/**
 * Aircraft picking deliberately lives on the canvas itself instead of R3F's
 * interactive-object registry. Instanced meshes are rebuilt when a fleet bucket
 * outgrows its GPU buffer; a native canvas listener remains valid across those
 * rebuilds and can always match the click against the positions on screen.
 */
function AircraftPicker({
  aircraft,
  active,
  predictive,
  motionScale,
  onSelect,
}: {
  aircraft: Aircraft[];
  active: boolean;
  predictive: boolean;
  motionScale: number;
  onSelect: (flight: Aircraft) => void;
}) {
  const { camera, gl } = useThree();

  useEffect(() => {
    if (!active) return;
    const canvas = gl.domElement;
    const worldPosition = new Vector3();
    const cameraOffset = new Vector3();
    const projected = new Vector3();
    const viewDirection = new Vector3();
    let pointerStart: { x: number; y: number } | null = null;

    const onPointerDown = (event: MouseEvent) => {
      if (event.button === 0) pointerStart = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event: MouseEvent) => {
      const start = pointerStart;
      pointerStart = null;
      if (!start || event.button !== 0) return;
      // Orbiting the globe is a drag, not an aircraft selection.
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;

      const bounds = canvas.getBoundingClientRect();
      const pointerX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      const pointerY = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      const timestamp = preciseNowSeconds();
      const perspective = camera as PerspectiveCamera;
      const worldHeightAtUnitDepth = 2 * Math.tan((perspective.fov * degrees) / 2);
      camera.getWorldDirection(viewDirection).normalize();
      let match: Aircraft | null = null;
      let bestPixels = Number.POSITIVE_INFINITY;
      let bestRange = Number.POSITIVE_INFINITY;

      for (const flight of aircraft) {
        globePosition(flight, timestamp, predictive, 0, worldPosition, motionScale);
        cameraOffset.subVectors(worldPosition, camera.position);
        if (occludedByGlobe(camera.position, cameraOffset)) continue;
        const depth = cameraOffset.dot(viewDirection);
        if (depth <= 0) continue;

        projected.copy(worldPosition).project(camera);
        if (projected.z < -1 || projected.z > 1) continue;
        const pixelX = ((projected.x - pointerX) * bounds.width) / 2;
        const pixelY = ((projected.y - pointerY) * bounds.height) / 2;
        const pixelDistance = pixelX * pixelX + pixelY * pixelY;
        const range = cameraOffset.lengthSq();
        const distanceScale = Math.min(6, Math.max(1, Math.sqrt(range) / 4.5));
        const modelScale = distanceScale * aircraftSizeFactor * (flight.onGround ? 0.78 : 1);
        const apparentSpan = (fleetWingSpan[aircraftVariant(flight.category)] * modelScale * bounds.height)
          / (worldHeightAtUnitDepth * depth);
        // Far away, every plane gets a forgiving 13 px target. Up close the
        // clickable area expands with the model on screen, so its wings and
        // fuselage remain clickable instead of only its mathematical origin.
        const pickRadius = Math.max(selectionPixelRadius, apparentSpan * 0.68);
        if (pixelDistance > pickRadius * pickRadius) continue;
        if (pixelDistance > bestPixels || (pixelDistance === bestPixels && range >= bestRange)) continue;
        match = flight;
        bestPixels = pixelDistance;
        bestRange = range;
      }

      if (match) onSelect(match);
    };

    const clearPointer = () => { pointerStart = null; };
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('click', onPointerUp);
    canvas.addEventListener('mouseleave', clearPointer);
    return () => {
      canvas.removeEventListener('mousedown', onPointerDown);
      canvas.removeEventListener('click', onPointerUp);
      canvas.removeEventListener('mouseleave', clearPointer);
    };
  }, [active, aircraft, camera, gl, motionScale, onSelect, predictive]);

  return null;
}

// Tail and cheatline markings. Kept inside the yellow family so an airline is
// still distinguishable up close without breaking the high-visibility scheme.
const liveryPalette = ['#a85f00', '#8a4606', '#c47a00', '#96550f', '#d18f0a', '#7d4406', '#b8560a', '#a87000'];

function hashSeed(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  return hash;
}

function liveryColorFor(seed: string) {
  return liveryPalette[hashSeed(seed) % liveryPalette.length];
}

// One rotating assembly — a propeller disc or a helicopter rotor — spun about
// its own axis.
function SpinningAssembly({ part }: { part: SpinningPart }) {
  const ref = useRef<Object3D>(null);
  const preset = surfaceMaterial[part.surface];
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation[part.axis] += delta * part.speed;
  });

  return (
    <group ref={ref} position={part.position}>
      <mesh>
        <primitive object={part.geometry} attach="geometry" />
        <meshStandardMaterial
          color={preset.color}
          emissive={preset.color}
          emissiveIntensity={preset.glow}
          metalness={preset.metalness}
          roughness={preset.roughness}
        />
      </mesh>
    </group>
  );
}

// Close-up airframe: a lathe-turned fuselage with a drooped nose and an upswept
// tail cone, lofted airfoil wings carrying real sweep, taper, dihedral and a
// blended winglet, turbofan cowls slung on pylons ahead of the leading edge,
// and conformal glass and livery wrapped onto the skin. Geometry comes from the
// same builder as the instanced fleet, so the two can never disagree.
function DetailedAircraftModel({
  variant,
  accentColor,
  onGround,
}: {
  variant: AircraftVariant;
  accentColor: string;
  onGround: boolean;
}) {
  const model = useMemo(() => createHeroAircraft(variant, { onGround }), [variant, onGround]);
  useEffect(() => () => model.dispose(), [model]);

  return (
    <group>
      {model.surfaces.map(({ surface, geometry }) => {
        const preset = surfaceMaterial[surface];
        // Windows, windshield and cheatline sit a hair proud of the fuselage;
        // a depth bias stops them shimmering against it at grazing angles.
        const decal = surface === 'glass' || surface === 'accent';
        return (
          <mesh key={surface} castShadow>
            <primitive object={geometry} attach="geometry" />
            <meshStandardMaterial
              color={surface === 'accent' ? accentColor : preset.color}
              emissive={surface === 'accent' ? accentColor : preset.color}
              emissiveIntensity={preset.glow}
              metalness={preset.metalness}
              roughness={preset.roughness}
              polygonOffset={decal}
              polygonOffsetFactor={-3}
              polygonOffsetUnits={-3}
            />
          </mesh>
        );
      })}

      {model.spinners.map((part, index) => (
        <SpinningAssembly key={index} part={part} />
      ))}

      <mesh position={model.lights.left}>
        <sphereGeometry args={[model.lights.radius, 8, 8]} />
        <meshBasicMaterial color="#ff3157" toneMapped={false} />
      </mesh>
      <mesh position={model.lights.right}>
        <sphereGeometry args={[model.lights.radius, 8, 8]} />
        <meshBasicMaterial color="#46ffae" toneMapped={false} />
      </mesh>
      <mesh position={model.lights.tail}>
        <sphereGeometry args={[model.lights.radius * 0.85, 8, 8]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
    </group>
  );
}

function SelectedAircraft({
  flight,
  predictive,
  paths,
  motionScale,
}: {
  flight: Aircraft;
  predictive: boolean;
  paths: boolean;
  motionScale: number;
}) {
  const { camera } = useThree();
  const group = useRef<Object3D>(null);
  const position = useMemo(() => new Vector3(), []);
  const radial = useMemo(() => new Vector3(), []);
  const quaternion = useMemo(() => new Quaternion(), []);
  const headingRotation = useMemo(() => new Quaternion(), []);
  const initialized = useRef(false);
  const variant = aircraftVariant(flight.category);
  const trail = useMemo(() => {
    const time = nowSeconds();
    return [-360, -240, -120, 0, 120, 240, 360, 480]
      .map((offset) => globePosition(flight, time, true, offset, new Vector3(), motionScale));
  }, [flight, motionScale]);

  useFrame((_, delta) => {
    if (!group.current) return;
    globePosition(flight, preciseNowSeconds(), predictive, 0, position, motionScale);
    radial.copy(position).normalize();
    quaternion.setFromUnitVectors(upVector, radial);
    headingRotation.setFromAxisAngle(radial, -flight.heading * (Math.PI / 180));
    quaternion.premultiply(headingRotation);
    // Same distance ramp and ground factor as the instanced fleet, so selecting
    // an aircraft never changes how big it looks.
    const distanceScale = Math.min(6, Math.max(1, camera.position.distanceTo(position) / 4.5));
    const groundScale = flight.onGround ? 0.78 : 1;
    group.current.scale.setScalar(distanceScale * aircraftSizeFactor * groundScale * detailedModelUnitScale[variant]);
    if (!initialized.current) {
      group.current.position.copy(position);
      group.current.quaternion.copy(quaternion);
      initialized.current = true;
      return;
    }
    const blend = 1 - Math.exp(-Math.min(delta, 0.1) * 8);
    group.current.position.lerp(position, blend);
    group.current.quaternion.slerp(quaternion, blend);
  });

  return (
    <>
      {paths && <Line points={trail} color="#5fe8ff" lineWidth={1} transparent opacity={0.55} />}
      <group ref={group}>
        <DetailedAircraftModel
          variant={variant}
          accentColor={liveryColorFor(flight.callsign || flight.id)}
          onGround={flight.onGround}
        />
        <mesh position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.2, 0.215, 48]} />
          <meshBasicMaterial color="#5fe8ff" transparent opacity={0.75} side={2} depthWrite={false} />
        </mesh>
        <pointLight color="#8ff2ff" intensity={2.4} distance={0.03} />
      </group>
    </>
  );
}

function greatCircleArcPoints(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
  segments = 96,
  baseRadius = earthRadius + 0.006,
  bulge = 0.09,
) {
  const a = latLonPosition(latA, lonA, 1);
  const b = latLonPosition(latB, lonB, 1);
  const angle = a.angleTo(b);
  const points: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let dir: Vector3;
    if (angle < 1e-6) {
      dir = a.clone();
    } else {
      const sinAngle = Math.sin(angle);
      const scale0 = Math.sin((1 - t) * angle) / sinAngle;
      const scale1 = Math.sin(t * angle) / sinAngle;
      dir = new Vector3(
        a.x * scale0 + b.x * scale1,
        a.y * scale0 + b.y * scale1,
        a.z * scale0 + b.z * scale1,
      ).normalize();
    }
    const arcHeight = Math.sin(t * Math.PI) * bulge;
    points.push(dir.multiplyScalar(baseRadius + arcHeight));
  }
  return points;
}

function AirportMarker({ airport, color, label }: { airport: RouteAirport; color: string; label: string }) {
  const { camera } = useThree();
  const group = useRef<Object3D>(null);
  const position = useMemo(
    () => latLonPosition(airport.latitude, airport.longitude, earthRadius + 0.008),
    [airport.latitude, airport.longitude],
  );

  // Markers follow the same distance ramp as the aircraft. At a fixed world size
  // they stayed as large as they were before aircraft were scaled down, so
  // centring on a flight parked at its own airport put the camera inside one.
  useFrame(() => {
    if (!group.current) return;
    group.current.scale.setScalar(Math.min(6, Math.max(1, camera.position.distanceTo(position) / 4.5)));
  });

  return (
    <group ref={group} position={position}>
      <mesh>
        <sphereGeometry args={[0.0016, 12, 12]} />
        {/* Translucent so an aircraft parked on its own stand stays readable
            through the marker sitting on top of it. */}
        <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <LabelSprite position={new Vector3(0, 0.008, 0)} text={label || airport.icao} color={color} height={0.013} />
    </group>
  );
}

function FlightRoutePath({ route }: { route: FlightRoute }) {
  const plannedPoints = useMemo(() => {
    if (!route.origin || !route.destination) return null;
    return greatCircleArcPoints(route.origin.latitude, route.origin.longitude, route.destination.latitude, route.destination.longitude);
  }, [route.origin, route.destination]);

  const observedPoints = useMemo(() => {
    if (route.track.length < 2) return null;
    return route.track.map((point) => latLonPosition(
      point.lat,
      point.lon,
      earthRadius + Math.min(0.075, Math.max(0.008, (point.altitude ?? 0) / 260000)),
    ));
  }, [route.track]);

  return (
    <>
      {plannedPoints && (
        <Line points={plannedPoints} color="#c48bff" lineWidth={1.4} dashed dashSize={0.025} gapSize={0.014} transparent opacity={0.78} />
      )}
      {observedPoints && (
        <Line points={observedPoints} color="#59c7ff" lineWidth={1.2} transparent opacity={0.85} />
      )}
      {route.origin && <AirportMarker airport={route.origin} color="#8cffb0" label={route.origin.iata || route.origin.icao} />}
      {route.destination && <AirportMarker airport={route.destination} color="#ff9d7a" label={route.destination.iata || route.destination.icao} />}
    </>
  );
}

function FlyMovement({ active, speed }: { active: boolean; speed: number }) {
  const { camera } = useThree();
  const keys = useRef(new Set<string>());
  const forward = useMemo(() => new Vector3(), []);
  const right = useMemo(() => new Vector3(), []);
  const localUp = useMemo(() => new Vector3(), []);
  const thrust = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const down = (event: KeyboardEvent) => keys.current.add(event.code);
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      keys.current.clear();
    };
  }, []);

  // Free flight keeps the horizon level: the mouse only ever changes where the
  // camera points, never how it is rolled, so any tilt another mode left behind
  // is taken out on the way in rather than riding along for the whole flight.
  useEffect(() => {
    if (!active) return;
    const level = new Euler(0, 0, 0, 'YXZ').setFromQuaternion(camera.quaternion, 'YXZ');
    if (level.z === 0) return;
    level.z = 0;
    camera.quaternion.setFromEuler(level);
  }, [active, camera]);

  useFrame((_, rawDelta) => {
    if (!active) return;
    const delta = Math.min(rawDelta, 0.1);
    const held = keys.current;
    const cruiseSpeed = speed * (held.has('ShiftLeft') || held.has('ShiftRight') ? 3 : 1);

    camera.getWorldDirection(forward).normalize();
    right.crossVectors(forward, camera.up).normalize();
    localUp.crossVectors(right, forward).normalize();

    thrust.set(0, 0, 0);
    if (held.has('KeyZ') || held.has('KeyW') || held.has('ArrowUp')) thrust.addScaledVector(forward, 1);
    if (held.has('KeyS') || held.has('ArrowDown')) thrust.addScaledVector(forward, -1);
    if (held.has('KeyQ') || held.has('KeyA') || held.has('ArrowLeft')) thrust.addScaledVector(right, -1);
    if (held.has('KeyD') || held.has('ArrowRight')) thrust.addScaledVector(right, 1);
    if (held.has('Space') || held.has('KeyR') || held.has('KeyE')) thrust.addScaledVector(localUp, 1);
    if (held.has('ControlLeft') || held.has('ControlRight') || held.has('KeyF') || held.has('KeyC')) thrust.addScaledVector(localUp, -1);
    if (thrust.lengthSq() === 0) return;

    // Movement is exactly the throttle setting for as long as a key is held and
    // nothing at all on the frame it is released — no momentum carrying the
    // camera past what it was aimed at, no bank into a turn, no lens flex under
    // speed. Sideways is sideways.
    camera.position.addScaledVector(thrust.normalize(), cruiseSpeed * delta);
  });

  return null;
}

function CameraDirector({
  selected,
  predictive,
  follow,
  focusRequest,
  resetRequest,
  motionScale,
  onPosition,
}: {
  selected: Aircraft | null;
  predictive: boolean;
  follow: boolean;
  focusRequest: number;
  resetRequest: number;
  motionScale: number;
  onPosition: (value: [number, number, number]) => void;
}) {
  const { camera } = useThree();
  const lastFocus = useRef(focusRequest);
  const lastReset = useRef(resetRequest);
  const lastReport = useRef(0);
  const desired = useMemo(() => new Vector3(), []);
  const target = useMemo(() => new Vector3(), []);
  const radial = useMemo(() => new Vector3(), []);

  useFrame(() => {
    if (lastReset.current !== resetRequest) {
      lastReset.current = resetRequest;
      camera.position.set(0, 0.3, 6.7);
      camera.lookAt(0, 0, 0);
    }

    if (selected && lastFocus.current !== focusRequest) {
      lastFocus.current = focusRequest;
      globePosition(selected, preciseNowSeconds(), predictive, 0, target, motionScale);
      radial.copy(target).normalize();
      camera.position.copy(target).addScaledVector(radial, 0.022);
      camera.lookAt(target);
    }

    if (follow && selected) {
      globePosition(selected, preciseNowSeconds(), predictive, 0, target, motionScale);
      radial.copy(target).normalize();
      desired.copy(target).addScaledVector(radial, 0.027);
      camera.position.lerp(desired, 0.065);
      camera.lookAt(target);
    }

    const timestamp = performance.now();
    if (timestamp - lastReport.current > 500) {
      lastReport.current = timestamp;
      onPosition([
        Number(camera.position.x.toFixed(2)),
        Number(camera.position.y.toFixed(2)),
        Number(camera.position.z.toFixed(2)),
      ]);
    }
  });

  return null;
}

/**
 * OrbitControls dollies by a fixed fraction of the distance to whatever it is
 * orbiting, and with the globe's centre as that target almost all of that
 * distance is the planet's own radius: close to the ground a single wheel notch
 * is worth more than the altitude that is left, so the last kilometres of a
 * descent simply cannot be flown. Rescaling zoomSpeed by the height above the
 * surface makes every notch the same fraction of that height instead, which
 * turns orbit-to-rooftop into one continuous move and is what puts the deepest
 * satellite levels in reach. Orbiting a selected aircraft has no meaningful
 * altitude of its own, so there the fraction falls back to the orbit radius.
 */
const zoomStepFraction = 0.2;

function AltitudeScaledZoom() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target?: Vector3; zoomSpeed?: number }
    | null;

  useFrame(() => {
    if (!controls?.target || typeof controls.zoomSpeed !== 'number') return;
    const range = camera.position.distanceTo(controls.target);
    if (!(range > 1e-9)) return;
    const altitude = Math.max(camera.position.length() - earthRadius, minimumCameraAltitude);
    // Solve 0.95 ** zoomSpeed === the step we want, so one notch closes
    // `zoomStepFraction` of whichever is smaller, the altitude or the orbit.
    const step = 1 - zoomStepFraction * (Math.min(altitude, range) / range);
    controls.zoomSpeed = Math.log(step) / Math.log(0.95);
  });

  return null;
}

function EarthSurfaceCollision() {
  const { camera } = useThree();

  useFrame(() => {
    const distance = camera.position.length();
    if (distance >= minimumCameraRadius) return;

    if (distance < 1e-9) {
      camera.position.set(minimumCameraRadius, 0, 0);
      return;
    }

    camera.position.multiplyScalar(minimumCameraRadius / distance);
  });

  return null;
}

function GlobeScene({
  aircraft,
  selected,
  route,
  predictive,
  paths,
  flyMode,
  follow,
  speed,
  orbitTarget,
  focusRequest,
  resetRequest,
  showCountries,
  countryGeo,
  motionScale,
  onFlyMode,
  onPosition,
  onSelect,
}: {
  aircraft: Aircraft[];
  selected: Aircraft | null;
  route: FlightRoute | null;
  predictive: boolean;
  paths: boolean;
  flyMode: boolean;
  follow: boolean;
  speed: number;
  orbitTarget: [number, number, number];
  focusRequest: number;
  resetRequest: number;
  showCountries: boolean;
  countryGeo: CountryGeoJson | null;
  motionScale: number;
  onFlyMode: (active: boolean) => void;
  onPosition: (value: [number, number, number]) => void;
  onSelect: (flight: Aircraft) => void;
}) {
  return (
    <>
      <color attach="background" args={['#02070c']} />
      <fog attach="fog" args={['#02070c', 11, 30]} />
      <ambientLight intensity={0.68} />
      <directionalLight position={[5, 2, 4]} intensity={3.15} color={new Color('#d9f4ff')} />
      <pointLight position={[-4, -1, -3]} intensity={2.1} color="#0a4f7c" />
      <Suspense fallback={null}><Earth /></Suspense>
      {showCountries && countryGeo && <CountryBorders geo={countryGeo} />}
      <AircraftFleet aircraft={aircraft} selectedId={selected?.id} predictive={predictive} motionScale={motionScale} />
      <AircraftPicker aircraft={aircraft} active={!flyMode} predictive={predictive} motionScale={motionScale} onSelect={onSelect} />
      {selected && <SelectedAircraft key={selected.id} flight={selected} predictive={predictive} paths={paths} motionScale={motionScale} />}
      {selected && route && (
        <Suspense fallback={null}><FlightRoutePath key={`${selected.id}-route`} route={route} /></Suspense>
      )}
      <Stars radius={70} depth={38} count={2400} factor={2.1} saturation={0.25} fade speed={0.2} />
      <OrbitControls
        makeDefault={!flyMode}
        enabled={!flyMode && !follow}
        enableDamping
        dampingFactor={0.055}
        rotateSpeed={0.48}
        panSpeed={0.65}
        minDistance={minimumCameraAltitude}
        maxDistance={30}
        enablePan
        target={orbitTarget}
      />
      <PointerLockControls
        selector="#fly-mode-button"
        pointerSpeed={0.55}
        onLock={() => onFlyMode(true)}
        onUnlock={() => onFlyMode(false)}
      />
      <FlyMovement active={flyMode} speed={speed} />
      <CameraDirector selected={selected} predictive={predictive} follow={follow} focusRequest={focusRequest} resetRequest={resetRequest} motionScale={motionScale} onPosition={onPosition} />
      <AltitudeScaledZoom />
      <EarthSurfaceCollision />
    </>
  );
}

/**
 * Everything a flight-tracking site puts on screen when you tap an aircraft:
 * who is operating it, what it is, a photograph of the airframe, the airports at
 * each end with their local clocks, and how far along the leg it is.
 *
 * Scheduled times are not in any free data source, so nothing here is presented
 * as one. Departure is the moment receivers first heard this airframe on this
 * leg, and arrival is projected from the ground still to cover at the speed it
 * is doing now — both labelled for what they are.
 */
function FlightSummary({
  flight,
  route,
  profile,
  loading,
}: {
  flight: Aircraft | null;
  route: FlightRoute | null;
  profile: AircraftProfile | null;
  loading?: boolean;
}) {
  const origin = route?.origin ?? null;
  const destination = route?.destination ?? null;
  const now = nowSeconds();

  const leg = useMemo(() => {
    if (!origin || !destination) return null;
    const total = greatCircleKm(origin.latitude, origin.longitude, destination.latitude, destination.longitude);
    if (!flight) return { total, flown: null, remaining: null, progress: null, eta: null };

    const flown = greatCircleKm(origin.latitude, origin.longitude, flight.lat, flight.lon);
    const remaining = greatCircleKm(flight.lat, flight.lon, destination.latitude, destination.longitude);
    // Both halves are measured from where the aircraft actually is, so a
    // diversion or a hold reads as a route longer than the direct one rather
    // than as a progress bar running past its own end.
    const covered = flown + remaining;
    const groundSpeedKmh = flight.speed * 3.6;
    return {
      total,
      flown,
      remaining,
      progress: covered > 0 ? Math.max(0, Math.min(1, flown / covered)) : null,
      eta: groundSpeedKmh > 40 ? now + (remaining / groundSpeedKmh) * 3600 : null,
    };
  }, [destination, flight, now, origin]);

  const clocks = useMemo(() => {
    const at = new Date(now * 1000);
    return {
      origin: origin ? airportUtcOffset(origin, at) : null,
      destination: destination ? airportUtcOffset(destination, at) : null,
    };
  }, [destination, now, origin]);

  const departure = route?.trackStartTime ?? null;
  const arrival = leg?.eta ?? null;
  // Receivers do not always hear an aircraft from the runway, so the track can
  // begin mid-flight. When the ground already covered could not have been flown
  // in the time on the track, this is a pick-up point rather than a departure,
  // and saying so is better than printing a takeoff time that never happened.
  const flownHours = leg?.flown && flight && flight.speed > 11 ? leg.flown / (flight.speed * 3.6) : null;
  const departed = departure !== null
    && (flownHours === null || now - departure >= flownHours * 3600 * 0.6);
  // Read each end on its own clock, so a red-eye that lands the next morning
  // gets the +1 an arrivals board would give it.
  const dayShift = arrival !== null && clocks.destination && clocks.origin
    ? localDayShift(arrival, clocks.destination.minutes, departure ?? now, clocks.origin.minutes)
    : 0;
  const identity = [route?.callsignIata, profile?.registration].filter((value): value is string => Boolean(value));
  const airframe = profile?.icaoType ?? flight?.model ?? null;
  const description = [profile?.manufacturer, profile?.type].filter(Boolean).join(' ');
  const operator = route?.airline ?? profile?.owner ?? null;

  if (loading && !route && !profile) {
    return <p className="font-mono text-[9px] tracking-wider text-slate-500">RESOLVING FLIGHT…</p>;
  }

  return (
    <div className="space-y-3">
      {(operator || airframe || identity.length > 0) && (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {operator && <p className="truncate text-xs font-medium text-white">{operator}</p>}
            {description && <p className="mt-0.5 truncate text-[10px] text-slate-500">{description}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {identity.map((value) => (
              <span key={value} className="border border-cyan-300/25 bg-cyan-300/[0.07] px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-cyan-200">{value}</span>
            ))}
            {airframe && <span className="border border-white/10 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-slate-300">{airframe}</span>}
          </div>
        </div>
      )}

      {profile?.photo && (
        <a href={profile.photo.link} target="_blank" rel="noreferrer" className="group relative block overflow-hidden border border-white/[0.08]">
          {/* A third-party photo host on a worker runtime with no image
              optimiser in front of it; the framework loader has nothing to add. */}
          {/* eslint-disable-next-line next/no-img-element */}
          <img
            src={profile.photo.url}
            alt={`${profile.registration ?? 'Aircraft'} photographed by ${profile.photo.photographer}`}
            loading="lazy"
            className="h-[104px] w-full object-cover transition duration-500 group-hover:scale-[1.03]"
          />
          {/* Planespotters licences these on the condition the photographer is
              credited and the picture links back to the original. */}
          <span className="absolute bottom-0 right-0 bg-[#020a10]/80 px-1.5 py-0.5 font-mono text-[8px] tracking-wide text-slate-400">© {profile.photo.photographer} / Planespotters</span>
        </a>
      )}

      {origin && destination ? (
        <>
          <div className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[19px] font-semibold leading-none tracking-wide text-lime-200">{origin.iata || origin.icao}</p>
              <p className="mt-1 truncate text-[10px] text-slate-300">{origin.municipality || origin.name}</p>
              {clocks.origin && (
                <p className="mt-0.5 font-mono text-[8px] tracking-wider text-slate-600">
                  {formatUtcOffset(clocks.origin.minutes)}{clocks.origin.estimated ? ' EST' : ''}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center px-1"><Plane className="size-4 rotate-90 text-cyan-300" /></div>
            <div className="min-w-0 flex-1 text-right">
              <p className="font-mono text-[19px] font-semibold leading-none tracking-wide text-orange-200">{destination.iata || destination.icao}</p>
              <p className="mt-1 truncate text-[10px] text-slate-300">{destination.municipality || destination.name}</p>
              {clocks.destination && (
                <p className="mt-0.5 font-mono text-[8px] tracking-wider text-slate-600">
                  {formatUtcOffset(clocks.destination.minutes)}{clocks.destination.estimated ? ' EST' : ''}
                </p>
              )}
            </div>
          </div>

          {departure === null && arrival === null ? (
            // Nothing is flying this leg within earshot, so there are no times
            // to give; the length of the leg itself is still worth knowing.
            <div className="border border-white/[0.08] bg-[#02080d]/60 p-2">
              <p className="telemetry-label">Great-circle distance</p>
              <p className="mt-1 font-mono text-[13px] text-white">{formatNumber(leg?.total ?? 0)}<span className="ml-1 text-[9px] text-slate-500">km</span></p>
            </div>
          ) : (
          <div className="grid grid-cols-2 gap-2">
            <div className="border border-white/[0.08] bg-[#02080d]/60 p-2">
              <p className="telemetry-label">{departed ? 'Departed' : 'First seen'}</p>
              <p className="mt-1 font-mono text-[13px] text-white">
                {departure !== null && clocks.origin ? formatLocalTime(departure, clocks.origin.minutes) : '—'}
                <span className="ml-1 text-[9px] text-slate-500">{departure !== null ? 'local' : ''}</span>
              </p>
            </div>
            <div className="border border-white/[0.08] bg-[#02080d]/60 p-2">
              <p className="telemetry-label">Arriving</p>
              <p className="mt-1 font-mono text-[13px] text-white">
                {arrival !== null && clocks.destination ? formatLocalTime(arrival, clocks.destination.minutes) : '—'}
                {dayShift > 0 && <span className="ml-0.5 align-super text-[8px] text-amber-200">+{dayShift}</span>}
                <span className="ml-1 text-[9px] text-slate-500">{arrival !== null ? 'est.' : ''}</span>
              </p>
            </div>
          </div>
          )}

          {leg?.progress !== null && leg?.progress !== undefined && (
            <div>
              <div className="relative h-[3px] w-full bg-white/[0.08]">
                <div className="absolute inset-y-0 left-0 bg-cyan-300" style={{ width: `${leg.progress * 100}%` }} />
                <Plane className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-90 text-cyan-200" style={{ left: `${leg.progress * 100}%` }} />
              </div>
              <div className="mt-2 flex items-start justify-between gap-2 font-mono text-[9px] tracking-wider text-slate-500">
                <span>
                  {formatNumber(leg.flown ?? 0)} km
                  {departed && departure !== null && <span className="ml-1 text-slate-600">{formatDuration(now - departure)} ago</span>}
                </span>
                <span className="text-right">
                  {formatNumber(leg.remaining ?? 0)} km
                  {arrival !== null && <span className="ml-1 text-slate-600">in {formatDuration(arrival - now)}</span>}
                </span>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-[10px] leading-4 text-slate-500">No scheduled route matched this callsign, so there is no itinerary to show.</p>
      )}
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string | number; suffix?: string }) {
  return (
    <div className="min-w-0">
      <p className="telemetry-label">{label}</p>
      <p className="mt-1 truncate font-mono text-[13px] font-medium text-white">
        {value}<span className="ml-1 text-[10px] text-slate-500">{suffix}</span>
      </p>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="grid h-5 min-w-5 place-items-center border border-white/15 bg-white/[0.05] px-1 font-mono text-[8px] text-slate-300">{children}</kbd>;
}

export function AirTrafficApp() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { aircraft: feedAircraft, state: feedState, error, meta } = useAircraftFeed(refreshKey);
  const [externalAircraft, setExternalAircraft] = useState<Aircraft[]>([]);
  const [useNetworks, setUseNetworks] = useState(true);
  const [globalSweep, setGlobalSweep] = useState(false);
  const [cameraPosition, setCameraPosition] = useState<[number, number, number]>([0, 0.3, 6.7]);
  const { aircraft: networkAircraft, sources: networkSources } = useNetworkAircraft(useNetworks, globalSweep, cameraPosition);

  const aircraft = useMemo(() => {
    if (networkAircraft.length === 0 && externalAircraft.length === 0) return feedAircraft;
    // The same airframe can arrive from OpenSky and a community network at once;
    // keep whichever fix is newer so the globe shows the best available position.
    const merged = new Map<string, Aircraft>();
    for (const flight of [...feedAircraft, ...networkAircraft, ...externalAircraft]) {
      const existing = merged.get(flight.id);
      if (!existing || flight.positionTime > existing.positionTime) merged.set(flight.id, flight);
    }
    return [...merged.values()];
  }, [feedAircraft, networkAircraft, externalAircraft]);
  const [selected, setSelected] = useState<Aircraft | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [flightState, setFlightState] = useState<FlightStateFilter>('airborne');
  const [altitude, setAltitude] = useState([0, 45000]);
  const [speedRange, setSpeedRange] = useState([0, 700]);
  const [country, setCountry] = useState('all');
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [predictive, setPredictive] = useState(true);
  const [paths, setPaths] = useState(true);
  const [showCountries, setShowCountries] = useState(false);
  const [motionSpeed, setMotionSpeed] = useState([1]);
  const [flyMode, setFlyMode] = useState(false);
  const [follow, setFollow] = useState(false);
  const [flyThrottle, setFlyThrottle] = useState([0.53]);
  const [focusRequest, setFocusRequest] = useState(0);
  const [resetRequest, setResetRequest] = useState(0);
  const [orbitTarget, setOrbitTarget] = useState<[number, number, number]>([0, 0, 0]);
  const [utc, setUtc] = useState('00:00:00');
  const searchRef = useRef<HTMLInputElement>(null);
  const { lists: favoriteLists, setLists: setFavoriteLists } = useFavoriteLists();
  const [activeListIds, setActiveListIds] = useState<string[]>([]);
  const [newListName, setNewListName] = useState('');
  const countryGeo = useCountryGeo(showCountries);
  const { route, loading: routeLoading } = useFlightRoute(selected);
  const selectedProfile = useAircraftProfile(selected?.id ?? null);
  useEffect(() => {
    const update = () => setUtc(new Date().toISOString().slice(11, 19));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelected((current) => {
      if (!current) return null;
      return aircraft.find((flight) => flight.id === current.id) ?? current;
    });
  }, [aircraft]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === '/' && document.pointerLockElement === null) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const flySpeed = flySpeedFor(flyThrottle[0]);
  const countries = useMemo(() => [...new Set(aircraft.map((flight) => flight.country))].sort((a, b) => a.localeCompare(b)), [aircraft]);

  const filteredAircraft = useMemo(() => {
    // A favourites selection is an explicit "show exactly these", so it stands in
    // for the airspace filters rather than narrowing them further — otherwise a
    // saved aircraft could sit outside the altitude or state filter and vanish.
    if (activeListIds.length > 0) {
      const entries = favoriteLists.filter((list) => activeListIds.includes(list.id)).flatMap((list) => list.entries);
      return aircraft.filter((flight) => entries.some((entry) => matchesFavorite(flight, entry)));
    }

    const normalizedQuery = query.trim().toUpperCase();
    let matching = aircraft.filter((flight) => {
      const altitudeFeet = flight.altitude * 3.28084;
      const speedKnots = flight.speed * 1.94384;
      const stateMatch = flightState === 'all' || (flightState === 'ground' ? flight.onGround : !flight.onGround);
      return stateMatch && altitudeFeet >= altitude[0] && altitudeFeet <= altitude[1] && speedKnots >= speedRange[0] && speedKnots <= speedRange[1] && (country === 'all' || flight.country === country);
    });

    if (normalizedQuery) {
      const terms = searchTerms(normalizedQuery);
      const exact = matching.filter((flight) => matchesSearch(flight, terms, true));
      matching = exact.length > 0
        ? exact
        : matching.filter((flight) => matchesSearch(flight, terms, false) || flight.country.toUpperCase().includes(normalizedQuery));
    }
    return matching;
  }, [activeListIds, aircraft, altitude, country, favoriteLists, flightState, query, speedRange]);

  const normalizedQuery = query.trim().toUpperCase();

  const suggestions = useMemo(() => {
    if (!normalizedQuery) return [];
    const terms = searchTerms(normalizedQuery);
    return aircraft.filter((flight) => matchesSearch(flight, terms, false)).slice(0, 6);
  }, [aircraft, normalizedQuery]);

  // What the typed flight number resolves to on the transponder side, shown so a
  // fruitless search still explains what was actually looked for.
  const resolvedCallsign = useMemo(() => {
    const terms = searchTerms(normalizedQuery);
    if (terms.length > 1) return terms[1];
    return /^[A-Z]{3}\d{1,4}[A-Z]?$/.test(normalizedQuery) ? normalizedQuery : null;
  }, [normalizedQuery]);

  const untrackedCallsign = suggestions.length === 0 && searchFocused ? resolvedCallsign : null;
  const { route: untrackedRoute, found: untrackedFound, loading: untrackedLoading } = useCallsignLookup(untrackedCallsign);
  // A searched flight that no receiver can hear still has an airframe behind it
  // once an extended network names one, so it gets the same dossier.
  const untrackedProfile = useAircraftProfile(untrackedFound?.aircraft.id ?? null);

  // Aircraft the extended networks found that the OpenSky snapshot lacks. They
  // are merged into the scene so a searched flight can actually be seen, then
  // superseded once the main feed picks the same airframe up.
  useEffect(() => {
    if (!untrackedFound) return;
    setExternalAircraft((current) => [
      untrackedFound.aircraft,
      ...current.filter((entry) => entry.id !== untrackedFound.aircraft.id),
    ].slice(0, 12));
  }, [untrackedFound]);

  const selectFlight = useCallback((flight: Aircraft) => {
    setSelected(flight);
    setFollow(false);
    setSearchFocused(false);
  }, []);

  const createFavoriteList = () => {
    const name = newListName.trim();
    if (!name) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setFavoriteLists((lists) => [...lists, { id, name, entries: [] }]);
    setNewListName('');
  };

  const deleteFavoriteList = (id: string) => {
    setFavoriteLists((lists) => lists.filter((list) => list.id !== id));
    setActiveListIds((ids) => ids.filter((listId) => listId !== id));
  };

  const toggleFavoriteList = (id: string) => {
    setActiveListIds((ids) => (ids.includes(id) ? ids.filter((listId) => listId !== id) : [...ids, id]));
  };

  const toggleFavoriteMembership = (listId: string, flight: Aircraft) => {
    setFavoriteLists((lists) => lists.map((list) => {
      if (list.id !== listId) return list;
      const saved = list.entries.some((entry) => matchesFavorite(flight, entry));
      return {
        ...list,
        entries: saved
          ? list.entries.filter((entry) => !matchesFavorite(flight, entry))
          : [...list.entries, { icao24: flight.id, callsign: flight.callsign }],
      };
    }));
  };

  const favoritesActive = activeListIds.length > 0;
  const allListIds = favoriteLists.map((list) => list.id);
  const allFavoritesActive = allListIds.length > 0 && allListIds.every((id) => activeListIds.includes(id));

  const centerSelected = () => {
    if (!selected) return;
    setFollow(false);
    const target = globePosition(selected, preciseNowSeconds(), predictive, 0, new Vector3(), motionSpeed[0]);
    setOrbitTarget([target.x, target.y, target.z]);
    setFocusRequest((value) => value + 1);
  };

  const resetCamera = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    setFollow(false);
    setOrbitTarget([0, 0, 0]);
    setResetRequest((value) => value + 1);
  };

  const fullscreen = () => {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen();
    else void document.exitFullscreen();
  };

  // The OpenSky snapshot carries no airframe identity, so when the selected
  // aircraft came from there the registry lookup fills those two readouts in.
  const selectedRegistration = selected?.registration ?? selectedProfile?.registration ?? null;
  const selectedModel = selected?.model ?? selectedProfile?.icaoType ?? null;
  const lastContactAge = selected ? Math.max(0, nowSeconds() - selected.lastContact) : 0;
  const sourceAge = meta ? Math.max(0, nowSeconds() - meta.sourceTimestamp) : 0;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#02070c] text-slate-100 selection:bg-cyan-300/25">
      <div className="absolute inset-0">
        <Canvas camera={{ position: [0, 0.3, 6.7], fov: 43, near: 0.000002, far: 150 }} dpr={[1, 2]} gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }}>
          <GlobeScene
            aircraft={filteredAircraft}
            selected={selected}
            route={route}
            predictive={predictive}
            paths={paths}
            flyMode={flyMode}
            follow={follow}
            speed={flySpeed}
            orbitTarget={orbitTarget}
            focusRequest={focusRequest}
            resetRequest={resetRequest}
            showCountries={showCountries}
            countryGeo={countryGeo}
            motionScale={motionSpeed[0]}
            onFlyMode={setFlyMode}
            onPosition={setCameraPosition}
            onSelect={selectFlight}
          />
        </Canvas>
      </div>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,transparent_0%,transparent_34%,rgba(1,6,11,.34)_75%,rgba(1,5,9,.78)_100%)]" />
      <div className="scanlines pointer-events-none absolute inset-0 opacity-20" />

      <header className="pointer-events-auto absolute inset-x-0 top-0 z-20 flex h-[66px] items-center border-b border-white/[0.08] bg-[#030a10]/72 px-4 backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 place-items-center border border-cyan-300/35 bg-cyan-300/[0.08] text-cyan-200"><Globe2 className="size-[18px]" /></div>
          <div>
            <div className="flex items-center gap-2"><h1 className="font-semibold tracking-[0.16em] text-white">SKYTRACE</h1><span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.18em] ${feedState === 'live' ? 'border-lime-200/20 bg-lime-200/[0.08] text-lime-200' : 'border-amber-200/20 bg-amber-200/[0.08] text-amber-200'}`}>{feedState === 'live' ? 'LIVE' : feedState === 'connecting' ? 'LINKING' : 'PREVIEW'}</span></div>
            <p className="hidden font-mono text-[9px] tracking-[0.14em] text-slate-500 sm:block">GLOBAL AIRSPACE / 3D OPERATIONS</p>
          </div>
        </div>

        <form
          className="absolute left-1/2 hidden w-[min(38vw,470px)] -translate-x-1/2 md:block"
          onSubmit={(event) => { event.preventDefault(); if (suggestions[0]) selectFlight(suggestions[0]); }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <Input
            ref={searchRef}
            aria-label="Search by flight number, callsign or ICAO24"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => window.setTimeout(() => setSearchFocused(false), 140)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { setQuery(''); searchRef.current?.blur(); }
            }}
            placeholder="Search flight number e.g. EY394…"
            className="h-9 rounded-none border-white/10 bg-white/[0.045] pl-10 pr-24 font-mono text-xs tracking-wide text-white placeholder:text-slate-600 focus-visible:border-cyan-300/50 focus-visible:ring-cyan-300/10"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[9px] tracking-wider text-slate-600">PRESS /</span>
          {searchFocused && query && (
            <div className="absolute top-11 w-full border border-white/10 bg-[#061018]/95 p-1 shadow-2xl backdrop-blur-xl">
              {suggestions.length ? suggestions.map((flight) => (
                <button key={flight.id} type="button" onMouseDown={() => selectFlight(flight)} className="flex w-full items-center px-3 py-2.5 text-left hover:bg-cyan-300/[0.08]">
                  <Plane className="mr-3 size-3.5 rotate-45 text-cyan-300" /><span className="font-mono text-[11px] text-white">{flight.callsign}</span><span className="ml-2 font-mono text-[9px] text-slate-600">{flight.id.toUpperCase()}</span><span className="ml-auto truncate pl-3 text-[10px] text-slate-500">{flight.country}</span>
                </button>
              )) : (
                <div className="px-3 py-3">
                  <p className="font-mono text-[10px] tracking-wider text-amber-200">
                    {untrackedFound ? 'FOUND ON AN EXTENDED NETWORK' : 'NOT IN THE LIVE FEED'}
                  </p>
                  {resolvedCallsign && resolvedCallsign !== normalizedQuery && (
                    <p className="mt-1.5 font-mono text-[9px] tracking-wider text-slate-500">
                      {normalizedQuery} <ArrowRight className="inline size-2.5" /> <span className="text-cyan-200">{resolvedCallsign}</span> · searched as the broadcast callsign
                    </p>
                  )}
                  {untrackedLoading && <p className="mt-2 font-mono text-[9px] tracking-wider text-slate-500">SEARCHING WIDER NETWORKS…</p>}
                  {untrackedFound && (
                    <button
                      type="button"
                      onMouseDown={() => selectFlight(untrackedFound.aircraft)}
                      className="mt-2.5 flex w-full items-center border border-cyan-300/35 bg-cyan-300/[0.07] px-2.5 py-2 text-left transition hover:bg-cyan-300/15"
                    >
                      <Plane className="mr-2.5 size-3.5 rotate-45 text-cyan-300" />
                      <span className="font-mono text-[11px] text-white">{untrackedFound.aircraft.callsign}</span>
                      {untrackedFound.aircraft.model && <span className="ml-2 font-mono text-[9px] text-slate-400">{untrackedFound.aircraft.model}</span>}
                      <span className="ml-auto font-mono text-[8px] tracking-wider text-cyan-300/70">{untrackedFound.source.toUpperCase()}</span>
                    </button>
                  )}
                  {!untrackedLoading && (untrackedRoute?.itineraryKind === 'plausible' || untrackedProfile) && (
                    <div className="mt-2.5 border border-white/[0.08] bg-white/[0.02] p-2.5">
                      <FlightSummary
                        flight={untrackedFound?.aircraft ?? null}
                        route={untrackedRoute}
                        profile={untrackedProfile}
                      />
                    </div>
                  )}
                  {!untrackedLoading && !untrackedFound && (
                    <p className="mt-2.5 text-[9px] leading-4 text-slate-600">
                      No ground receiver on OpenSky, adsb.lol or adsb.fi can currently hear this aircraft. Over oceans and remote airspace only satellite ADS-B sees traffic, and no free network carries it.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </form>

        <div className="ml-auto flex items-center gap-2">
          <div className="mr-2 hidden items-center gap-2 border-r border-white/10 pr-4 lg:flex">
            <span className="relative flex size-2"><span className={`absolute inline-flex size-full animate-ping rounded-full opacity-50 ${feedState === 'live' ? 'bg-lime-300' : 'bg-amber-300'}`} /><span className={`relative inline-flex size-2 rounded-full ${feedState === 'live' ? 'bg-lime-300' : 'bg-amber-300'}`} /></span>
            <span className="font-mono text-[10px] tracking-wider text-slate-400">{formatNumber(filteredAircraft.length)} / {formatNumber(aircraft.length)} TRACKS</span>
          </div>
          <Button onClick={() => setHelpOpen((value) => !value)} variant="ghost" size="icon" className="rounded-none text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Controls help"><CircleHelp /></Button>
          <Button onClick={() => setRefreshKey((value) => value + 1)} variant="ghost" size="icon" className="rounded-none text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Refresh live data"><RefreshCw className={feedState === 'connecting' ? 'animate-spin' : ''} /></Button>
          <Button variant="ghost" size="icon" className="hidden rounded-none text-slate-400 hover:bg-white/[0.06] hover:text-white sm:inline-flex" aria-label="Settings"><Settings2 /></Button>
        </div>
      </header>

      {helpOpen && (
        <div className="pointer-events-auto absolute right-4 top-[78px] z-30 w-[300px] border border-cyan-300/20 bg-[#061018]/95 p-4 shadow-2xl backdrop-blur-xl sm:right-6">
          <div className="flex items-center"><Navigation className="mr-2 size-4 text-cyan-300" /><h2 className="text-[11px] font-semibold tracking-[0.15em]">FREE-FLIGHT CONTROLS</h2><button onClick={() => setHelpOpen(false)} className="ml-auto text-slate-500 hover:text-white"><X className="size-4" /></button></div>
          <p className="mt-3 text-xs leading-5 text-slate-400">Select <span className="text-cyan-200">FLY</span>, then use the mouse to look anywhere. Press Esc to release the mouse.</p>
          <div className="mt-4 grid grid-cols-[1fr_auto] gap-y-3 text-[11px] text-slate-400">
            <span>Forward / back</span><span className="flex gap-1"><Key>Z/W</Key><Key>S</Key><Key>↑↓</Key></span>
            <span>Left / right</span><span className="flex gap-1"><Key>Q/A</Key><Key>D</Key><Key>←→</Key></span>
            <span>Rise / descend</span><span className="flex gap-1"><Key>SPACE</Key><Key>CTRL</Key></span>
            <span>Move faster</span><span className="flex gap-1"><Key>SHIFT</Key></span>
          </div>
          <div className="mt-4 border-t border-white/[0.08] pt-3"><div className="mb-2 flex justify-between"><span className="telemetry-label">Flight speed</span><span className="font-mono text-[9px] text-cyan-200">{flySpeed.toFixed(2)} u/s</span></div><Slider min={0} max={1} step={0.01} value={flyThrottle} onValueChange={(value) => setFlyThrottle(toSliderTuple(value))} /><div className="mt-1.5 flex justify-between font-mono text-[8px] tracking-wider text-slate-600"><span>CRAWL</span><span>SHIFT FOR ×3</span><span>DASH</span></div></div>
        </div>
      )}

      {feedState === 'preview' && error && (
        <div className="pointer-events-none absolute left-1/2 top-[78px] z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2 border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 font-mono text-[9px] tracking-wider text-amber-100 backdrop-blur-xl"><AlertTriangle className="size-3.5 shrink-0" /><span className="truncate">PREVIEW DATA — {error}</span></div>
      )}

      <aside className={`pointer-events-auto absolute bottom-14 left-3 top-[78px] z-10 flex w-[292px] flex-col border border-white/[0.09] bg-[#061018]/84 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-300 sm:left-6 ${filtersOpen ? 'translate-x-0' : '-translate-x-[calc(100%+32px)]'}`}>
        <div className="flex h-12 shrink-0 items-center border-b border-white/[0.08] px-4"><Filter className="mr-2 size-3.5 text-cyan-300" /><h2 className="text-[11px] font-semibold tracking-[0.15em]">FILTER AIRSPACE</h2><button onClick={() => setFiltersOpen(false)} className="ml-auto text-slate-500 transition hover:text-white" aria-label="Close filters"><X className="size-4" /></button></div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <p className="telemetry-label">Favorites</p>
              {favoritesActive && (
                <button onClick={() => setActiveListIds([])} className="font-mono text-[9px] tracking-wider text-cyan-200 transition hover:text-white">SHOW ALL TRAFFIC</button>
              )}
            </div>

            {favoriteLists.length === 0 ? (
              <p className="text-[10px] leading-4 text-slate-600">Name a list below, then select any aircraft and save it to that list. Lists stay on this device.</p>
            ) : (
              <div className="space-y-1.5">
                <button
                  onClick={() => setActiveListIds(allFavoritesActive ? [] : allListIds)}
                  className={`flex h-8 w-full items-center border px-2.5 font-mono text-[9px] uppercase tracking-wider transition ${allFavoritesActive ? 'border-amber-200/45 bg-amber-200/10 text-amber-200' : 'border-white/10 bg-white/[0.025] text-slate-500 hover:border-white/20 hover:text-slate-300'}`}
                >
                  <Star className={`mr-2 size-3 ${allFavoritesActive ? 'fill-amber-200' : ''}`} />
                  All favorites
                  <span className="ml-auto text-slate-500">{favoriteLists.reduce((total, list) => total + list.entries.length, 0)}</span>
                </button>
                {favoriteLists.map((list) => {
                  const active = activeListIds.includes(list.id);
                  return (
                    <div key={list.id} className="flex items-center gap-1.5">
                      <button
                        onClick={() => toggleFavoriteList(list.id)}
                        className={`flex h-8 min-w-0 flex-1 items-center border px-2.5 text-[10px] transition ${active ? 'border-cyan-300/45 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-white/[0.025] text-slate-400 hover:border-white/20 hover:text-slate-200'}`}
                      >
                        <span className="truncate">{list.name}</span>
                        <span className="ml-auto pl-2 font-mono text-[9px] text-slate-500">{list.entries.length}</span>
                      </button>
                      <button
                        onClick={() => deleteFavoriteList(list.id)}
                        aria-label={`Delete list ${list.name}`}
                        className="grid size-8 shrink-0 place-items-center border border-white/10 bg-white/[0.025] text-slate-600 transition hover:border-rose-300/40 hover:text-rose-300"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* A real form, so Enter submits through native browser behaviour
                rather than a hand-rolled key comparison. */}
            <form className="mt-2 flex gap-1.5" onSubmit={(event) => { event.preventDefault(); createFavoriteList(); }}>
              <Input
                value={newListName}
                onChange={(event) => setNewListName(event.target.value)}
                placeholder="New list name…"
                aria-label="New favorites list name"
                className="h-8 min-w-0 flex-1 rounded-none border-white/10 bg-white/[0.045] px-2.5 text-[10px] text-white placeholder:text-slate-600 focus-visible:border-cyan-300/50 focus-visible:ring-cyan-300/10"
              />
              <button
                type="submit"
                aria-label="Create favorites list"
                className="grid size-8 shrink-0 place-items-center border border-cyan-300/35 bg-cyan-300/[0.08] text-cyan-200 transition hover:bg-cyan-300/20 disabled:opacity-40"
                disabled={!newListName.trim()}
              >
                <Plus className="size-3.5" />
              </button>
            </form>

            {favoritesActive && (
              <p className="mt-2.5 border border-amber-200/20 bg-amber-200/[0.06] px-2 py-1.5 text-[9px] leading-4 text-amber-100/80">
                Showing saved aircraft only — the filters below are paused.
              </p>
            )}
          </section>

          <section className={favoritesActive ? 'pointer-events-none opacity-40' : undefined}>
            <p className="telemetry-label mb-2.5">Flight state</p>
            <div className="grid grid-cols-3 gap-1.5">{(['airborne', 'ground', 'all'] as FlightStateFilter[]).map((item) => <button key={item} onClick={() => setFlightState(item)} className={`h-8 border font-mono text-[9px] uppercase tracking-wider transition ${flightState === item ? 'border-cyan-300/45 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-white/[0.025] text-slate-500 hover:border-white/20 hover:text-slate-300'}`}>{item}</button>)}</div>
          </section>
          <section>
            <div className="flex items-center justify-between"><p className="telemetry-label">Altitude</p><span className="font-mono text-[9px] text-cyan-200">{formatNumber(altitude[0])} — {formatNumber(altitude[1])} ft</span></div>
            <Slider className="mt-4" min={0} max={60000} step={1000} value={altitude} onValueChange={(value) => setAltitude(toSliderTuple(value))} />
          </section>
          <section>
            <div className="flex items-center justify-between"><p className="telemetry-label">Ground speed</p><span className="font-mono text-[9px] text-cyan-200">{speedRange[0]} — {speedRange[1]} kt</span></div>
            <Slider className="mt-4" min={0} max={1000} step={10} value={speedRange} onValueChange={(value) => setSpeedRange(toSliderTuple(value))} />
          </section>
          <section>
            <p className="telemetry-label mb-2.5">Origin country</p>
            <NativeSelect value={country} onChange={(event) => setCountry(event.target.value)} className="w-full" size="default">
              <NativeSelectOption value="all">All countries</NativeSelectOption>
              {countries.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}
            </NativeSelect>
          </section>
          <section className="border-t border-white/[0.08] pt-4">
            <p className="telemetry-label mb-3">Visualization</p>
            <label className="flex items-center justify-between py-1.5 text-xs text-slate-300"><span>Predictive movement</span><Switch checked={predictive} onCheckedChange={setPredictive} className="data-checked:bg-cyan-300" /></label>
            <label className="flex items-center justify-between py-1.5 text-xs text-slate-300"><span>Selected flight path</span><Switch checked={paths} onCheckedChange={setPaths} className="data-checked:bg-cyan-300" /></label>
            <label className="flex items-center justify-between py-1.5 text-xs text-slate-300"><span>Extra country outlines</span><Switch checked={showCountries} onCheckedChange={setShowCountries} className="data-checked:bg-cyan-300" /></label>
            <label className="flex items-center justify-between py-1.5 text-xs text-slate-300"><span>Extended ADS-B networks</span><Switch checked={useNetworks} onCheckedChange={setUseNetworks} className="data-checked:bg-cyan-300" /></label>
            {useNetworks && (
              <>
                <label className="flex items-center justify-between py-1.5 pl-3 text-xs text-slate-400"><span>Sweep the whole globe</span><Switch checked={globalSweep} onCheckedChange={setGlobalSweep} className="data-checked:bg-amber-200" /></label>
                <p className="mt-1 pl-3 text-[9px] leading-4 text-slate-600">
                  {globalSweep
                    ? 'Twelve wide queries cover the planet every 60s — a complete picture, but several megabytes per sweep.'
                    : 'Only the airspace you are looking at is fetched, refreshed every 25s as you pan and zoom.'}
                </p>
              </>
            )}
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <div className="flex items-center justify-between">
                <p className="telemetry-label">Motion speed</p>
                <span className="font-mono text-[9px] text-cyan-200">{motionSpeed[0]}× {motionSpeed[0] === 1 ? 'REAL TIME' : 'TIME-LAPSE'}</span>
              </div>
              <Slider className="mt-4" min={1} max={200} step={1} value={motionSpeed} onValueChange={(value) => setMotionSpeed(toSliderTuple(value))} />
              <p className="mt-2.5 text-[9px] leading-4 text-slate-600">1× is real time: aircraft advance at their true ground speed from their last reported position, which is about one pixel per minute at full-globe zoom — zoom in to see it. Higher values only speed up the clock for a time-lapse effect and make shown positions run ahead of the real ones.</p>
            </div>
          </section>
          <section className="border-t border-white/[0.08] pt-4">
            <p className="telemetry-label mb-2">Data link</p>
            <div className="space-y-1.5 font-mono text-[9px] tracking-wider text-slate-500"><div className="flex justify-between"><span>SOURCE</span><span className="text-slate-300">OPENSKY{networkSources.length > 0 ? ` +${networkSources.length}` : ''}</span></div>{networkSources.length > 0 && <div className="flex justify-between"><span>ALSO</span><span className="text-cyan-200">{networkSources.join(' · ').toUpperCase()}</span></div>}<div className="flex justify-between"><span>ACCESS</span><span className={meta?.mode === 'authenticated' ? 'text-lime-200' : 'text-amber-200'}>{meta?.mode?.toUpperCase() ?? 'CONNECTING'}</span></div><div className="flex justify-between"><span>DATA AGE</span><span className="text-slate-300">{meta ? `${sourceAge}s` : '—'}</span></div></div>
            <p className="mt-3 text-[9px] leading-4 text-slate-600">Community receiver coverage varies by region; not every aircraft broadcasts a public position.</p>
          </section>
        </div>
        <div className="border-t border-white/[0.08] p-3"><Button onClick={() => setFiltersOpen(false)} className="h-9 w-full rounded-none bg-cyan-300 font-mono text-[10px] font-semibold tracking-[0.12em] text-[#021016] hover:bg-cyan-200">SHOW AIRCRAFT <span className="ml-auto rounded-sm bg-black/10 px-1.5 py-0.5">{formatNumber(filteredAircraft.length)}</span></Button></div>
      </aside>

      {!filtersOpen && <Button onClick={() => setFiltersOpen(true)} variant="outline" size="icon" className="pointer-events-auto absolute left-3 top-[78px] z-10 rounded-none border-white/10 bg-[#061018]/80 text-cyan-200 backdrop-blur-xl hover:bg-white/10 sm:left-6" aria-label="Open filters"><Filter /></Button>}

      {selected && (
        <aside className="pointer-events-auto absolute bottom-12 left-2 right-2 z-20 flex max-h-[48vh] flex-col border border-white/[0.09] bg-[#061018]/94 shadow-2xl shadow-black/50 backdrop-blur-xl lg:bottom-14 lg:left-auto lg:right-6 lg:top-[78px] lg:max-h-none lg:w-[312px]">
          <div className="border-b border-white/[0.08] p-4">
            <div className="flex items-start gap-3"><div className="grid size-10 place-items-center border border-lime-200/30 bg-lime-200/[0.08] text-lime-200"><Plane className="size-5 rotate-45" /></div><div className="min-w-0"><p className="font-mono text-[9px] tracking-[0.16em] text-lime-200">{selected.onGround ? 'ON GROUND' : 'AIRBORNE'} • TRACKED</p><h2 className="mt-0.5 font-mono text-xl font-semibold tracking-wide text-white">{selected.callsign}</h2></div><button onClick={() => { setSelected(null); setFollow(false); }} className="ml-auto text-slate-500 transition hover:text-white" aria-label="Close aircraft details"><X className="size-4" /></button></div>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-4 border-b border-white/[0.08] p-4 lg:grid-cols-2 lg:gap-y-5">
            <Metric label="ICAO24" value={selected.id.toUpperCase()} />
            {selectedRegistration
              ? <Metric label="REGISTRATION" value={selectedRegistration} />
              : <Metric label="ORIGIN" value={selected.country} />}
            {selectedModel
              ? <Metric label="AIRCRAFT" value={selectedModel} />
              : <Metric label="CATEGORY" value={categoryLabels[selected.category] ?? `Category ${selected.category}`} />}
            <Metric label="BARO ALTITUDE" value={formatNumber(selected.altitude * 3.28084)} suffix="ft" /><Metric label="GROUND SPEED" value={Math.round(selected.speed * 1.94384)} suffix="kt" /><Metric label="HEADING" value={Math.round(selected.heading)} suffix="°" />
            <Metric label="VERTICAL RATE" value={`${selected.verticalRate >= 0 ? '+' : ''}${Math.round(selected.verticalRate * 196.85)}`} suffix="ft/min" /><Metric label="SQUAWK" value={selected.squawk ?? '—'} /><Metric label="POSITION" value={sourceLabels[selected.positionSource] ?? `SRC ${selected.positionSource}`} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <FlightSummary flight={selected} route={route} profile={selectedProfile} loading={routeLoading} />

            <div className="mt-5 flex items-center justify-between border-t border-white/[0.08] pt-4"><p className="telemetry-label">Position telemetry</p><span className="font-mono text-[9px] text-lime-200">{lastContactAge}s AGO</span></div>
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[9px] tracking-wider text-slate-500"><div className="border border-white/[0.08] bg-[#02080d]/60 p-2"><span>LAT</span><p className="mt-1 text-xs text-slate-200">{selected.lat.toFixed(5)}°</p></div><div className="border border-white/[0.08] bg-[#02080d]/60 p-2"><span>LON</span><p className="mt-1 text-xs text-slate-200">{selected.lon.toFixed(5)}°</p></div></div>
            <p className="mt-3 text-[10px] leading-4 text-slate-500">Live identity and movement data come from the aircraft transponder network.</p>

            <div className="mt-5 border-t border-white/[0.08] pt-4">
              <div className="flex items-center justify-between"><p className="telemetry-label">Save to list</p><Star className="size-3.5 text-amber-200" /></div>
              {favoriteLists.length === 0 ? (
                <p className="mt-2 text-[10px] leading-4 text-slate-500">Create a list in the Favorites panel to save this aircraft.</p>
              ) : (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {favoriteLists.map((list) => {
                    const saved = list.entries.some((entry) => matchesFavorite(selected, entry));
                    return (
                      <button
                        key={list.id}
                        onClick={() => toggleFavoriteMembership(list.id, selected)}
                        className={`flex items-center gap-1.5 border px-2 py-1 text-[10px] transition ${saved ? 'border-amber-200/45 bg-amber-200/10 text-amber-200' : 'border-white/10 bg-white/[0.025] text-slate-400 hover:border-white/25 hover:text-slate-200'}`}
                      >
                        {saved ? <Check className="size-3" /> : <Plus className="size-3" />}
                        <span className="max-w-[120px] truncate">{list.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-5 border-t border-white/[0.08] pt-4">
              <div className="flex items-center justify-between"><p className="telemetry-label">Route intelligence</p><Route className="size-3.5 text-violet-300" /></div>
              {route?.origin && route.destination && (
                <div className="mt-2.5 grid grid-cols-2 gap-2 text-[10px] text-slate-500">
                  <div className="flex items-start gap-1.5"><MapPin className="mt-0.5 size-3 shrink-0 text-lime-200/70" /><span>{route.origin.name}, {route.origin.country}</span></div>
                  <div className="flex items-start gap-1.5"><MapPin className="mt-0.5 size-3 shrink-0 text-orange-200/70" /><span>{route.destination.name}, {route.destination.country}</span></div>
                </div>
              )}
              <p className="mt-2.5 text-[9px] leading-4 text-slate-600">
                Dashed line is a plausible schedule-based route, not a confirmed flight plan. Solid line is the observed track. Departure and arrival are derived from that track and the current ground speed, not from a published schedule.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-white/[0.08] p-3"><Button onClick={centerSelected} variant="outline" className="rounded-none border-white/10 bg-white/[0.025] font-mono text-[9px] tracking-wider text-slate-300 hover:bg-white/10"><Crosshair /> CENTER CLOSE</Button><Button onClick={() => setFollow((value) => !value)} className={`rounded-none font-mono text-[9px] font-semibold tracking-wider ${follow ? 'bg-amber-200 text-[#151003] hover:bg-amber-100' : 'bg-lime-200 text-[#0a1304] hover:bg-lime-100'}`}><LocateFixed /> {follow ? 'STOP FOLLOW' : 'FOLLOW PLANE'}</Button></div>
        </aside>
      )}

      <div className="pointer-events-auto absolute bottom-[58px] left-1/2 z-10 flex -translate-x-1/2 items-center border border-white/[0.09] bg-[#061018]/84 p-1 shadow-xl backdrop-blur-xl">
        <button onClick={resetCamera} className="flex h-8 items-center gap-2 border-r border-white/[0.08] px-3 font-mono text-[9px] tracking-wider text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><Crosshair className="size-3.5" /><span className="hidden sm:inline">RESET</span></button>
        <button id="fly-mode-button" className={`flex h-8 items-center gap-2 border-r border-white/[0.08] px-3 font-mono text-[9px] tracking-wider transition ${flyMode ? 'bg-cyan-300 text-[#021016]' : 'text-cyan-200 hover:bg-cyan-300/10'}`}><Navigation className="size-3.5" /><span>{flyMode ? 'FLYING' : 'FLY'}</span></button>
        <button onClick={() => setHelpOpen(true)} className="flex h-8 items-center gap-2 border-r border-white/[0.08] px-3 font-mono text-[9px] tracking-wider text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><MousePointer2 className="size-3.5" /><span className="hidden sm:inline">CONTROLS</span></button>
        <button onClick={fullscreen} className="flex h-8 items-center gap-2 px-3 font-mono text-[9px] tracking-wider text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><Maximize2 className="size-3.5" /><span className="hidden sm:inline">FULLSCREEN</span></button>
      </div>

      {flyMode && (
        <div className="pointer-events-none absolute left-1/2 top-[84px] z-20 -translate-x-1/2 border border-cyan-300/25 bg-[#041018]/75 px-4 py-2 text-center backdrop-blur-xl"><p className="font-mono text-[9px] tracking-[0.18em] text-cyan-200">FREE FLIGHT ACTIVE</p><p className="mt-1 font-mono text-[8px] tracking-wider text-slate-500">ZQSD / WASD / ARROWS · SPACE/CTRL · MOUSE · ESC TO RELEASE</p></div>
      )}

      <div className="pointer-events-none absolute bottom-[56px] right-3 hidden border border-white/[0.08] bg-[#061018]/72 px-3 py-2 font-mono text-[8px] tracking-wider text-slate-600 backdrop-blur-xl xl:block"><span className="mr-3 text-slate-500">CAMERA XYZ</span>{cameraPosition.map((axis, index) => <span key={index} className="ml-2"><span className="text-cyan-300/60">{['X', 'Y', 'Z'][index]}</span> {axis.toFixed(2)}</span>)}</div>

      <a
        href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9"
        target="_blank"
        rel="noreferrer"
        className="pointer-events-auto absolute bottom-[46px] right-2 z-30 border border-white/[0.08] bg-[#061018]/82 px-2 py-1 font-mono text-[8px] tracking-wide text-slate-400 backdrop-blur-md transition hover:text-cyan-200 sm:right-3"
      >
        Imagery © Esri, Vantor, Earthstar Geographics, GIS User Community
      </a>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex h-10 items-center border-t border-white/[0.08] bg-[#030a10]/82 px-4 font-mono text-[9px] tracking-wider text-slate-600 backdrop-blur-xl sm:px-6">
        <span className="flex items-center gap-2"><Radio className={`size-3 ${feedState === 'live' ? 'text-cyan-300' : 'text-amber-300'}`} /> {feedState === 'live' ? 'OPENSKY LIVE NETWORK' : 'OPENSKY CONNECTION PENDING'}</span><span className="mx-4 hidden h-3 w-px bg-white/10 sm:block" /><span className="hidden sm:inline">UTC {utc}</span><span className="ml-4 hidden text-slate-700 xl:inline">EARTH / SATELLITE IMAGERY</span>
        <div className="ml-auto flex items-center gap-4"><span className="hidden items-center gap-1.5 md:flex"><Activity className="size-3 text-lime-300" /> {motionSpeed[0] === 1 ? 'TRUE-SPEED LIVE MOTION' : `${motionSpeed[0]}× TIME-LAPSE MOTION`}</span><span className="hidden items-center gap-1.5 xl:flex">{meta ? `${meta.refreshAfter}s SOURCE SYNC` : 'CONNECTING'}</span><span className="hidden items-center gap-1.5 lg:flex"><ArrowUpFromLine className="size-3" /> SPACE</span><span className="hidden items-center gap-1.5 lg:flex"><ArrowDownToLine className="size-3" /> CTRL</span><span className="flex items-center gap-1.5"><Gauge className="size-3" /> 60 FPS</span></div>
      </footer>
    </main>
  );
}
