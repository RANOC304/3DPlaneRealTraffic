// Parametric airliner geometry.
//
// Every shape in here is generated from real aerodynamic primitives rather than
// stacked boxes: the fuselage is a lathe of an authentic nose/cabin/tailcone
// profile, the flying surfaces are lofted NACA-style airfoil sections with
// sweep, taper, dihedral and blended winglets, and the engines are turbofan
// cowls with a rolled inlet lip and a recessed fan face.
//
// A single builder feeds both consumers so they can never drift apart:
//   * the instanced fleet, which merges everything into one vertex-coloured
//     BufferGeometry so thousands of aircraft stay a single draw call, and
//   * the close-up model, which returns one geometry per surface so each can
//     take its own material (glass, bare metal, livery accent, ...).
//
// Models are authored in a normalised space where the wingspan is exactly 1 and
// the nose points down -Z, matching the orientation the globe scene expects.

import {
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  SphereGeometry,
  Vector2,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type AircraftVariant = 'jet' | 'heavy' | 'light' | 'rotor';

// Which material a piece of geometry belongs to. Keeping these separate lets the
// close-up model shade glass, livery and bare metal differently while the fleet
// simply bakes each one to a vertex colour.
export type AircraftSurface =
  | 'shell' // painted fuselage / white upper surfaces
  | 'wing' // slightly greyer wing and stabiliser skin
  | 'accent' // airline livery: fin, cheatline
  | 'glass' // cockpit windshield and cabin windows
  | 'engine' // nacelle cowls, bare metal
  | 'dark'; // fan faces, tyres, gear legs

// Fallback colours used when the geometry is baked into the instanced fleet.
const surfaceColor: Record<AircraftSurface, string> = {
  shell: '#f2f8fb',
  wing: '#c9d8e0',
  accent: '#1d5fa8',
  glass: '#12222e',
  engine: '#dbe6ec',
  dark: '#20282d',
};

type SurfaceParts = Map<AircraftSurface, BufferGeometry[]>;

function add(parts: SurfaceParts, surface: AircraftSurface, ...geometries: BufferGeometry[]) {
  const bucket = parts.get(surface);
  if (bucket) bucket.push(...geometries);
  else parts.set(surface, [...geometries]);
}

// ---------------------------------------------------------------------------
// Geometry plumbing
// ---------------------------------------------------------------------------

// mergeGeometries refuses to combine geometries whose attribute sets differ, so
// every part is reduced to exactly position/normal/uv (plus colour later) and
// forced to carry an index.
function normalize(geometry: BufferGeometry) {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') {
      geometry.deleteAttribute(name);
    }
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  if (!geometry.getAttribute('uv')) {
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!geometry.index) {
    const count = geometry.getAttribute('position').count;
    const index: number[] = [];
    for (let i = 0; i < count; i++) index.push(i);
    geometry.setIndex(index);
  }
  return geometry;
}

type Placement = {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
};

function place(geometry: BufferGeometry, { position, rotation, scale }: Placement = {}) {
  if (scale) geometry.scale(...scale);
  if (rotation) {
    geometry.rotateX(rotation[0]);
    geometry.rotateY(rotation[1]);
    geometry.rotateZ(rotation[2]);
  }
  if (position) geometry.translate(...position);
  return normalize(geometry);
}

// Mirrors a part across the centreline. Scaling by -1 inverts winding, so the
// index buffer is reversed to keep the faces pointing outward.
function mirrorX(geometry: BufferGeometry) {
  const clone = geometry.clone();
  clone.scale(-1, 1, 1);
  const index = clone.getIndex();
  if (index) {
    const array = Array.from(index.array).reverse();
    clone.setIndex(array);
  }
  return clone;
}

function mergeAll(geometries: BufferGeometry[]) {
  const merged = mergeGeometries(geometries.map(normalize), false);
  if (!merged) throw new Error('Unable to merge aircraft geometry');
  geometries.forEach((part) => part.dispose());
  return merged;
}

// ---------------------------------------------------------------------------
// Airfoil sections and lofted flying surfaces
// ---------------------------------------------------------------------------

type Section = Array<[number, number]>;

// NACA 4-digit style section, sampled with cosine spacing so the leading edge
// stays round without wasting vertices along the flat aft half. Returned as a
// closed loop: leading edge -> upper surface -> trailing edge -> lower surface.
function airfoilSection(samples: number, thickness = 0.115, camber = 0.018): Section {
  const upper: Section = [];
  const lower: Section = [];
  const p = 0.4;
  for (let i = 0; i <= samples; i++) {
    const x = (1 - Math.cos((i / samples) * Math.PI)) / 2;
    const half = 5 * thickness * (
      0.2969 * Math.sqrt(x)
      - 0.126 * x
      - 0.3516 * x * x
      + 0.2843 * x * x * x
      - 0.1036 * x * x * x * x
    );
    const mean = x < p
      ? (camber / (p * p)) * (2 * p * x - x * x)
      : (camber / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
    upper.push([x, mean + half]);
    lower.push([x, mean - half]);
  }
  return [...upper, ...lower.slice(1, samples).reverse()];
}

export type WingStation = {
  /** Spanwise position of the leading edge. */
  x: number;
  /** Height of the leading edge — carries dihedral and winglet rise. */
  y: number;
  /** Streamwise position of the leading edge — carries sweep. */
  z: number;
  chord: number;
  /** Multiplier on the section thickness, tapering the skin toward the tip. */
  thickness?: number;
  /** Roll of the section about the chord line: 0 is horizontal, PI/2 vertical. */
  cant?: number;
};

// Lofts an airfoil along a list of stations. The section frame rolls with the
// `cant` angle, so a wing can curve continuously up into a blended winglet and
// the very same routine builds the vertical fin at cant = PI/2.
export function buildLoftedSurface(stations: WingStation[], section: Section, cap = true) {
  const ring = section.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  stations.forEach((station, i) => {
    const cant = station.cant ?? 0;
    const thickness = station.thickness ?? 1;
    const upX = -Math.sin(cant);
    const upY = Math.cos(cant);
    section.forEach(([c, u], j) => {
      const chordwise = c * station.chord;
      const normalwise = u * station.chord * thickness;
      positions.push(
        station.x + upX * normalwise,
        station.y + upY * normalwise,
        station.z + chordwise,
      );
      uvs.push(j / ring, i / Math.max(1, stations.length - 1));
    });
  });

  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < ring; j++) {
      const jNext = (j + 1) % ring;
      const a = i * ring + j;
      const b = i * ring + jNext;
      const c = (i + 1) * ring + j;
      const d = (i + 1) * ring + jNext;
      indices.push(a, b, c, b, d, c);
    }
  }

  if (cap) {
    const tip = (stations.length - 1) * ring;
    for (let j = 1; j < ring - 1; j++) {
      indices.push(tip, tip + j, tip + j + 1);
      indices.push(0, j + 1, j); // root cap, reversed winding
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------------
// Fuselage
// ---------------------------------------------------------------------------

export type FuselageProfile = {
  length: number;
  radius: number;
  /** Fraction of the length taken by the nose radome. */
  nose: number;
  /** Fraction of the length taken by the tail cone. */
  tail: number;
  /** Radius left at the very back of the tail cone, as a fraction of `radius`. */
  tailRadius: number;
  /** How far the tail cone lifts above the centreline, in radii. */
  upsweep: number;
};

// Radius and centreline height at a normalised station t (0 = nose, 1 = tail).
function fuselageAt(profile: FuselageProfile, t: number) {
  const { length, radius, nose, tail, tailRadius, upsweep } = profile;
  let r = radius;
  let lift = 0;
  if (t < nose) {
    const s = t / nose;
    r = radius * Math.pow(Math.sin(s * Math.PI * 0.5), 0.54);
    lift = -radius * 0.1 * (1 - s) * (1 - s); // the flight deck sits slightly low
  } else if (t > 1 - tail) {
    const s = (t - (1 - tail)) / tail;
    r = radius * (1 - (1 - tailRadius) * Math.pow(s, 1.55));
    lift = radius * upsweep * s * s;
  }
  return { r, y: lift, z: -length / 2 + t * length };
}

// A lathe of the profile above. `phiStart`/`phiLength` and the t range let the
// exact same surface be reused as a conformal decal — windshield, cheatline or
// a cabin window — by lifting it a hair off the skin.
export function buildFuselageSurface(
  profile: FuselageProfile,
  {
    from = 0,
    to = 1,
    phiStart = 0,
    phiLength = Math.PI * 2,
    lift = 0,
    segments = 24,
    radialSegments = 22,
  } = {},
) {
  const points: Vector2[] = [];
  const heights: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = from + ((to - from) * i) / segments;
    const { r, y, z } = fuselageAt(profile, t);
    points.push(new Vector2(Math.max(r + lift, 0.0001), z));
    heights.push(y);
  }

  const geometry = new LatheGeometry(points, radialSegments, phiStart, phiLength);
  // Lathe spins around +Y; the scene wants the body along Z with the nose at -Z.
  geometry.rotateX(Math.PI / 2);

  // Bend the tube so the nose droops and the tail cone sweeps up, which a plain
  // surface of revolution can never express on its own.
  const position = geometry.getAttribute('position');
  const zStart = points[0].y;
  const zEnd = points[points.length - 1].y;
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    const s = zEnd === zStart ? 0 : (z - zStart) / (zEnd - zStart);
    const slot = Math.min(heights.length - 1, Math.max(0, Math.round(s * segments)));
    position.setY(i, position.getY(i) + heights[slot]);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------------
// Turbofan nacelle
// ---------------------------------------------------------------------------

// Cowl silhouette as (radius fraction, length fraction) pairs. It starts deep
// inside the intake, rolls forward over the inlet lip, bulges to maximum
// diameter just aft of it and tapers away to the nozzle — the shape that reads
// instantly as a high-bypass turbofan rather than a plain tube.
const cowlProfile: Array<[number, number]> = [
  [0.60, 0.15],
  [0.65, 0.055],
  [0.73, 0.008],
  [0.84, 0.0],
  [0.94, 0.028],
  [1.0, 0.13],
  [0.99, 0.42],
  [0.95, 0.68],
  [0.87, 0.87],
  [0.78, 1.0],
];

export function buildNacelle(
  length: number,
  radius: number,
  { radialSegments = 18, coarse = false } = {},
) {
  const profile = coarse
    ? [cowlProfile[0], cowlProfile[3], cowlProfile[5], cowlProfile[7], cowlProfile[9]]
    : cowlProfile;
  const points = profile.map(([r, f]) => new Vector2(r * radius, -length / 2 + f * length));
  const cowl = new LatheGeometry(points, radialSegments);
  cowl.rotateX(Math.PI / 2);
  return cowl;
}

// The dark disc of fan blades sitting inside the intake, plus its spinner.
export function buildFanFace(length: number, radius: number, segments = 18, spinner = true) {
  const depth = -length / 2 + cowlProfile[0][1] * length;
  const face = new CircleGeometry(radius * cowlProfile[0][0], segments);
  face.rotateY(Math.PI); // look forward, down -Z
  face.translate(0, 0, depth);
  if (!spinner) return face;
  const cone = new ConeGeometry(radius * 0.16, radius * 0.42, segments);
  cone.rotateX(-Math.PI / 2);
  cone.translate(0, 0, depth - radius * 0.16);
  return mergeAll([face, cone]);
}

// ---------------------------------------------------------------------------
// Airframe definitions
// ---------------------------------------------------------------------------

type EngineSpec = {
  x: number;
  y: number;
  z: number;
  length: number;
  radius: number;
};

type AirframeSpec = {
  fuselage: FuselageProfile;
  wing: WingStation[];
  stabilizer: WingStation[];
  fin: WingStation[];
  engines: EngineSpec[];
  /** Elongated belly blister covering the wing box. */
  fairing?: { z: number; length: number; width: number; height: number; drop: number };
  windows?: { from: number; to: number; count: number; angle: number };
  windshield?: { from: number; to: number; spread: number };
  cheatline?: { from: number; to: number; angle: number; width: number };
  /** Painted fin, in livery colour, plus an optional painted engine cowl. */
  gear?: { nose: number; main: number; track: number; length: number; tyre: number };
  propeller?: { z: number; radius: number; blades: number };
  boom?: { from: number; to: number; radius: number; tailRadius: number };
  mainRotor?: { y: number; radius: number; blades: number };
  tailRotor?: { x: number; y: number; z: number; radius: number; blades: number };
  skids?: { z: number; length: number; width: number; drop: number };
};

const halfPi = Math.PI / 2;

const airframes: Record<AircraftVariant, AirframeSpec> = {
  // Narrowbody twinjet in the A320 / 737 mould: 27 degrees of leading-edge
  // sweep, five degrees of dihedral and a blended winglet.
  jet: {
    fuselage: { length: 1.06, radius: 0.056, nose: 0.15, tail: 0.3, tailRadius: 0.1, upsweep: 0.78 },
    wing: [
      { x: 0.050, y: -0.022, z: -0.070, chord: 0.205, thickness: 1.18 },
      { x: 0.155, y: -0.013, z: -0.016, chord: 0.150, thickness: 1.05 },
      { x: 0.330, y: 0.002, z: 0.073, chord: 0.098, thickness: 0.88 },
      { x: 0.468, y: 0.014, z: 0.144, chord: 0.062, thickness: 0.78, cant: 0.10 },
      { x: 0.494, y: 0.040, z: 0.166, chord: 0.050, thickness: 0.72, cant: 1.05 },
      { x: 0.500, y: 0.076, z: 0.180, chord: 0.032, thickness: 0.62, cant: 1.45 },
    ],
    stabilizer: [
      { x: 0.020, y: 0.012, z: 0.355, chord: 0.125 },
      { x: 0.100, y: 0.020, z: 0.407, chord: 0.086, thickness: 0.9 },
      { x: 0.180, y: 0.028, z: 0.459, chord: 0.046, thickness: 0.8 },
    ],
    fin: [
      { x: 0, y: 0.020, z: 0.300, chord: 0.215, cant: halfPi },
      { x: 0, y: 0.115, z: 0.372, chord: 0.150, thickness: 0.85, cant: halfPi },
      { x: 0, y: 0.208, z: 0.437, chord: 0.078, thickness: 0.72, cant: halfPi },
    ],
    engines: [{ x: 0.163, y: -0.072, z: -0.087, length: 0.205, radius: 0.0435 }],
    fairing: { z: 0.020, length: 0.44, width: 0.078, height: 0.050, drop: -0.038 },
    windows: { from: -0.30, to: 0.26, count: 17, angle: 0.36 },
    windshield: { from: 0.055, to: 0.14, spread: 0.95 },
    cheatline: { from: -0.44, to: 0.40, angle: 0.10, width: 0.11 },
    gear: { nose: -0.36, main: 0.055, track: 0.075, length: 0.052, tyre: 0.016 },
  },

  // Widebody twin in the 777 mould: more sweep, a raked wingtip instead of a
  // winglet and much larger fans.
  heavy: {
    fuselage: { length: 1.16, radius: 0.050, nose: 0.14, tail: 0.3, tailRadius: 0.09, upsweep: 0.85 },
    wing: [
      { x: 0.046, y: -0.020, z: -0.090, chord: 0.230, thickness: 1.20 },
      { x: 0.150, y: -0.010, z: -0.017, chord: 0.160, thickness: 1.02 },
      { x: 0.330, y: 0.008, z: 0.109, chord: 0.098, thickness: 0.86 },
      { x: 0.455, y: 0.022, z: 0.196, chord: 0.060, thickness: 0.76, cant: 0.06 },
      { x: 0.500, y: 0.036, z: 0.240, chord: 0.030, thickness: 0.66, cant: 0.22 },
    ],
    stabilizer: [
      { x: 0.020, y: 0.010, z: 0.380, chord: 0.150 },
      { x: 0.110, y: 0.020, z: 0.452, chord: 0.100, thickness: 0.9 },
      { x: 0.205, y: 0.031, z: 0.528, chord: 0.050, thickness: 0.8 },
    ],
    fin: [
      { x: 0, y: 0.018, z: 0.320, chord: 0.245, cant: halfPi },
      { x: 0, y: 0.125, z: 0.402, chord: 0.165, thickness: 0.85, cant: halfPi },
      { x: 0, y: 0.232, z: 0.478, chord: 0.082, thickness: 0.72, cant: halfPi },
    ],
    engines: [{ x: 0.170, y: -0.078, z: -0.088, length: 0.235, radius: 0.055 }],
    fairing: { z: 0.030, length: 0.50, width: 0.076, height: 0.048, drop: -0.034 },
    windows: { from: -0.34, to: 0.30, count: 22, angle: 0.34 },
    windshield: { from: 0.05, to: 0.132, spread: 0.9 },
    cheatline: { from: -0.50, to: 0.44, angle: 0.09, width: 0.10 },
    gear: { nose: -0.40, main: 0.070, track: 0.082, length: 0.056, tyre: 0.017 },
  },

  // High-wing single, straight-tapered, with a nose propeller.
  light: {
    fuselage: { length: 0.78, radius: 0.058, nose: 0.20, tail: 0.42, tailRadius: 0.08, upsweep: 0.5 },
    wing: [
      { x: 0.026, y: 0.050, z: -0.132, chord: 0.148, thickness: 1.2 },
      { x: 0.250, y: 0.057, z: -0.120, chord: 0.134, thickness: 1.05 },
      { x: 0.430, y: 0.063, z: -0.110, chord: 0.104, thickness: 0.92 },
      { x: 0.500, y: 0.067, z: -0.104, chord: 0.068, thickness: 0.8 },
    ],
    stabilizer: [
      { x: 0.016, y: 0.008, z: 0.286, chord: 0.108 },
      { x: 0.110, y: 0.012, z: 0.300, chord: 0.082, thickness: 0.9 },
      { x: 0.190, y: 0.016, z: 0.316, chord: 0.050, thickness: 0.8 },
    ],
    fin: [
      { x: 0, y: 0.018, z: 0.240, chord: 0.152, cant: halfPi },
      { x: 0, y: 0.090, z: 0.282, chord: 0.108, thickness: 0.9, cant: halfPi },
      { x: 0, y: 0.152, z: 0.318, chord: 0.056, thickness: 0.8, cant: halfPi },
    ],
    engines: [],
    windows: { from: -0.20, to: 0.02, count: 4, angle: 0.30 },
    windshield: { from: 0.13, to: 0.30, spread: 1.05 },
    gear: { nose: -0.28, main: 0.02, track: 0.085, length: 0.055, tyre: 0.015 },
    propeller: { z: -0.40, radius: 0.135, blades: 3 },
  },

  // Light helicopter: bulbous glazed cabin, slim tail boom, four-blade main
  // rotor and a tail rotor on the fin.
  rotor: {
    fuselage: { length: 0.60, radius: 0.098, nose: 0.4, tail: 0.16, tailRadius: 0.5, upsweep: 0.25 },
    wing: [],
    stabilizer: [
      { x: 0.014, y: 0.030, z: 0.560, chord: 0.090 },
      { x: 0.090, y: 0.032, z: 0.572, chord: 0.062, thickness: 0.9 },
      { x: 0.140, y: 0.034, z: 0.584, chord: 0.038, thickness: 0.8 },
    ],
    fin: [
      { x: 0, y: 0.020, z: 0.560, chord: 0.130, cant: halfPi },
      { x: 0, y: 0.070, z: 0.588, chord: 0.096, thickness: 0.9, cant: halfPi },
      { x: 0, y: 0.118, z: 0.612, chord: 0.052, thickness: 0.8, cant: halfPi },
    ],
    engines: [],
    windshield: { from: 0.06, to: 0.36, spread: 1.25 },
    boom: { from: 0.24, to: 0.62, radius: 0.032, tailRadius: 0.019 },
    mainRotor: { y: 0.155, radius: 0.5, blades: 4 },
    tailRotor: { x: 0.026, y: 0.086, z: 0.632, radius: 0.115, blades: 2 },
    skids: { z: 0.02, length: 0.36, width: 0.105, drop: -0.125 },
  },
};

// Wingspans the rest of the scene expects, so swapping the model in does not
// change how large aircraft appear on the globe.
export const fleetWingSpan: Record<AircraftVariant, number> = {
  jet: 0.094,
  heavy: 0.112,
  light: 0.075,
  rotor: 0.105,
};

export const heroWingSpan: Record<AircraftVariant, number> = {
  jet: 0.28,
  heavy: 0.34,
  light: 0.18,
  rotor: 0.38,
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

type Detail = {
  radial: number;
  profile: number;
  airfoil: number;
  /** Windows, windshield, cheatline, belly fairing and spinner cones. */
  fine: boolean;
  gear: boolean;
};

const fleetDetail: Detail = { radial: 8, profile: 9, airfoil: 4, fine: false, gear: false };
const heroDetail: Detail = { radial: 26, profile: 30, airfoil: 13, fine: true, gear: false };

export type SpinningPart = {
  geometry: BufferGeometry;
  surface: AircraftSurface;
  position: [number, number, number];
  axis: 'x' | 'y' | 'z';
  speed: number;
};

/** Position of a station along the fuselage, expressed as a lathe parameter. */
function stationAt(profile: FuselageProfile, z: number) {
  return (z + profile.length / 2) / profile.length;
}

// A patch of skin lifted a hair proud of the fuselage — windows, windshield and
// livery stripes all conform to the exact curve of the body this way.
function decal(
  profile: FuselageProfile,
  z0: number,
  z1: number,
  phiCentre: number,
  phiWidth: number,
  { lift = 0.0016, segments = 12, radialSegments = 8 } = {},
) {
  return buildFuselageSurface(profile, {
    from: stationAt(profile, z0),
    to: stationAt(profile, z1),
    phiStart: phiCentre - phiWidth / 2,
    phiLength: phiWidth,
    lift,
    segments,
    radialSegments,
  });
}

// Blades for propellers and rotors: a slim tapered airfoil laid along +X, then
// pitched about its own span so it bites the air.
function bladeSet(
  count: number,
  radius: number,
  chord: number,
  section: Section,
  { pitch = 0, axis = 'z' as 'x' | 'y' | 'z', thickness = 0.5, hub = 0.08 } = {},
) {
  const blade = buildLoftedSurface(
    [
      { x: radius * hub, y: 0, z: -chord * 0.5, chord: chord, thickness },
      { x: radius * 0.55, y: 0, z: -chord * 0.52, chord: chord * 1.05, thickness: thickness * 0.85 },
      { x: radius, y: 0, z: -chord * 0.4, chord: chord * 0.6, thickness: thickness * 0.6 },
    ],
    section,
  );
  if (pitch) blade.rotateX(pitch);
  // Blades are authored along +X. A disc spinning about X therefore has to be
  // stood on its side first, otherwise every blade would land on the axis.
  if (axis === 'x') blade.rotateZ(Math.PI / 2);
  const blades: BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const clone = blade.clone();
    const angle = (i / count) * Math.PI * 2;
    if (axis === 'y') clone.rotateY(angle);
    else if (axis === 'x') clone.rotateX(angle);
    else clone.rotateZ(angle);
    blades.push(clone);
  }
  blade.dispose();
  return mergeAll(blades);
}

function assemble(variant: AircraftVariant, detail: Detail) {
  const spec = airframes[variant];
  const body = spec.fuselage;
  const parts: SurfaceParts = new Map();
  const spinners: SpinningPart[] = [];
  const section = airfoilSection(detail.airfoil);
  const thinSection = airfoilSection(Math.max(3, detail.airfoil - 2), 0.09, 0.008);

  // --- fuselage -----------------------------------------------------------
  add(
    parts,
    'shell',
    buildFuselageSurface(body, { segments: detail.profile, radialSegments: detail.radial }),
  );

  if (spec.boom) {
    const boom = new CylinderGeometry(
      spec.boom.tailRadius,
      spec.boom.radius,
      spec.boom.to - spec.boom.from,
      Math.max(6, Math.round(detail.radial * 0.6)),
      1,
      true,
    );
    add(parts, 'shell', place(boom, {
      rotation: [halfPi, 0, 0],
      position: [0, body.radius * 0.16, (spec.boom.from + spec.boom.to) / 2],
    }));
  }

  if (spec.fairing && detail.fine) {
    const fairing = new SphereGeometry(1, 18, 12);
    add(parts, 'shell', place(fairing, {
      scale: [spec.fairing.width, spec.fairing.height, spec.fairing.length / 2],
      position: [0, spec.fairing.drop, spec.fairing.z],
    }));
  }

  // --- flying surfaces ----------------------------------------------------
  if (spec.wing.length) {
    const wing = buildLoftedSurface(spec.wing, section);
    add(parts, 'wing', wing, mirrorX(wing));
  }
  const stabilizer = buildLoftedSurface(spec.stabilizer, thinSection);
  add(parts, 'wing', stabilizer, mirrorX(stabilizer));
  add(parts, 'accent', buildLoftedSurface(spec.fin, section));

  // --- engines ------------------------------------------------------------
  spec.engines.forEach((engine) => {
    const nacelleSegments = Math.max(7, Math.round(detail.radial * 0.75));
    const cowl = place(
      buildNacelle(engine.length, engine.radius, {
        radialSegments: nacelleSegments,
        coarse: !detail.fine,
      }),
      { position: [engine.x, engine.y, engine.z] },
    );
    const fan = place(
      buildFanFace(engine.length, engine.radius, nacelleSegments, detail.fine),
      { position: [engine.x, engine.y, engine.z] },
    );
    // Pylon: a vertical aerofoil bridging the cowl and the wing underside.
    const pylonTop = engine.y + engine.radius * 1.7;
    const pylon = buildLoftedSurface(
      [
        { x: engine.x, y: engine.y + engine.radius * 0.5, z: engine.z - engine.length * 0.1, chord: engine.length * 0.5, thickness: 0.6, cant: halfPi },
        { x: engine.x, y: pylonTop, z: engine.z + engine.length * 0.06, chord: engine.length * 0.62, thickness: 0.5, cant: halfPi },
      ],
      thinSection,
    );
    add(parts, 'engine', cowl, mirrorX(cowl));
    add(parts, 'dark', fan, mirrorX(fan));
    add(parts, 'wing', pylon, mirrorX(pylon));
  });

  // --- glass and livery ---------------------------------------------------
  if (detail.fine && spec.windshield) {
    add(parts, 'glass', decal(
      body,
      -body.length / 2 + spec.windshield.from * body.length,
      -body.length / 2 + spec.windshield.to * body.length,
      Math.PI,
      spec.windshield.spread * 2,
      { segments: 6, radialSegments: 10, lift: 0.0012 },
    ));
  }

  if (detail.fine && spec.windows) {
    const { from, to, count, angle } = spec.windows;
    const pitch = count > 1 ? (to - from) / (count - 1) : 0;
    const width = Math.min(0.014, Math.abs(pitch) * 0.45);
    const panes: BufferGeometry[] = [];
    for (let i = 0; i < count; i++) {
      const centre = from + pitch * i;
      const pane = decal(body, centre - width / 2, centre + width / 2, halfPi + angle, 0.085, {
        segments: 1,
        radialSegments: 2,
      });
      panes.push(pane, mirrorX(pane));
    }
    add(parts, 'glass', mergeAll(panes));
  }

  if (detail.fine && spec.cheatline) {
    const stripe = decal(
      body,
      spec.cheatline.from,
      spec.cheatline.to,
      halfPi + spec.cheatline.angle,
      spec.cheatline.width,
      { segments: 16, radialSegments: 2, lift: 0.001 },
    );
    add(parts, 'accent', stripe, mirrorX(stripe));
  }

  // --- undercarriage ------------------------------------------------------
  if (detail.gear && spec.gear) {
    const { nose, main, track, length, tyre } = spec.gear;
    const legs: BufferGeometry[] = [];
    const wheels: BufferGeometry[] = [];
    const mount = [
      { x: 0, z: nose, scale: 0.8 },
      { x: track, z: main, scale: 1 },
      { x: -track, z: main, scale: 1 },
    ];
    mount.forEach(({ x, z, scale }) => {
      legs.push(place(new CylinderGeometry(0.0055 * scale, 0.0045 * scale, length, 7), {
        position: [x, -body.radius - length / 2 + 0.01, z],
      }));
      wheels.push(place(new CylinderGeometry(tyre * scale, tyre * scale, tyre * 1.1 * scale, 10), {
        rotation: [0, 0, halfPi],
        position: [x, -body.radius - length + 0.01, z],
      }));
    });
    add(parts, 'dark', mergeAll([...legs, ...wheels]));
  }

  if (spec.skids) {
    const { z, length, width, drop } = spec.skids;
    const rails: BufferGeometry[] = [];
    [-1, 1].forEach((side) => {
      rails.push(place(new CylinderGeometry(0.008, 0.008, length, 7), {
        rotation: [halfPi, 0, 0],
        position: [side * width, drop, z],
      }));
      [-0.24, 0.2].forEach((offset) => {
        rails.push(place(new CylinderGeometry(0.006, 0.006, Math.abs(drop) * 0.86, 6), {
          rotation: [0, 0, side * 0.24],
          position: [side * width * 0.82, drop / 2 - 0.01, z + offset * length],
        }));
      });
    });
    add(parts, 'dark', mergeAll(rails));
  }

  // --- rotating parts -----------------------------------------------------
  if (spec.propeller) {
    const { z, radius, blades } = spec.propeller;
    spinners.push({
      geometry: bladeSet(blades, radius, radius * 0.24, thinSection, { pitch: 1.15, axis: 'z', thickness: 0.42 }),
      surface: 'dark',
      position: [0, 0, z],
      axis: 'z',
      speed: 26,
    });
    if (detail.fine) {
      const spinner = new ConeGeometry(body.radius * 0.34, body.radius * 0.8, 12);
      add(parts, 'accent', place(spinner, { rotation: [-halfPi, 0, 0], position: [0, 0, z - body.radius * 0.42] }));
    }
  }

  if (spec.mainRotor) {
    const { y, radius, blades } = spec.mainRotor;
    const mast = new CylinderGeometry(0.014, 0.02, y * 0.42, 8);
    add(parts, 'dark', place(mast, { position: [0, y - y * 0.21, -0.02] }));
    spinners.push({
      geometry: bladeSet(blades, radius, radius * 0.13, thinSection, { axis: 'y', thickness: 0.34, hub: 0.05 }),
      surface: 'dark',
      position: [0, y, -0.02],
      axis: 'y',
      speed: 16,
    });
  }

  if (spec.tailRotor) {
    const { x, y, z, radius, blades } = spec.tailRotor;
    const blade = bladeSet(blades, radius, radius * 0.22, thinSection, { axis: 'x', thickness: 0.36, hub: 0.06 });
    spinners.push({ geometry: blade, surface: 'dark', position: [x, y, z], axis: 'x', speed: 24 });
  }

  return { spec, parts, spinners };
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

function paint(geometry: BufferGeometry, hex: string) {
  // Colour instances are already linear when three's colour management is on,
  // which is exactly what a vertex-colour attribute expects.
  const color = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

// One merged, vertex-coloured geometry for the whole fleet. Every aircraft on
// the globe shares it, so thousands of airframes still cost a single draw call
// while keeping a white shell, grey wings, a liveried fin and dark fan faces.
export function createFleetAircraftGeometry(variant: AircraftVariant) {
  const { parts, spinners } = assemble(variant, fleetDetail);

  // At fleet range a spinning disc is a couple of pixels, so rotors and
  // propellers are frozen into the static mesh instead of animated.
  spinners.forEach((spinner) => {
    const frozen = spinner.geometry.clone();
    frozen.translate(...spinner.position);
    add(parts, spinner.surface, frozen);
    spinner.geometry.dispose();
  });

  const painted: BufferGeometry[] = [];
  parts.forEach((bucket, surface) => painted.push(paint(mergeAll(bucket), surfaceColor[surface])));

  const geometry = mergeAll(painted);
  const scale = fleetWingSpan[variant];
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingSphere();
  return geometry;
}

export type HeroAircraft = {
  surfaces: Array<{ surface: AircraftSurface; geometry: BufferGeometry }>;
  spinners: SpinningPart[];
  lights: {
    left: [number, number, number];
    right: [number, number, number];
    tail: [number, number, number];
    /** Bulb radius, proportional to the airframe so small types stay small. */
    radius: number;
  };
  dispose: () => void;
};

// The close-up model, split by material so glass, livery, bare metal and tyres
// can each be shaded properly.
export function createHeroAircraft(
  variant: AircraftVariant,
  { onGround = false } = {},
): HeroAircraft {
  const { spec, parts, spinners } = assemble(variant, { ...heroDetail, gear: onGround });
  const scale = heroWingSpan[variant];

  const surfaces: HeroAircraft['surfaces'] = [];
  parts.forEach((bucket, surface) => {
    const geometry = mergeAll(bucket);
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingSphere();
    surfaces.push({ surface, geometry });
  });

  spinners.forEach((spinner) => {
    spinner.geometry.scale(scale, scale, scale);
    spinner.position = [
      spinner.position[0] * scale,
      spinner.position[1] * scale,
      spinner.position[2] * scale,
    ];
  });

  // Navigation lights ride the outermost lifting surface; the tail light sits on
  // the very back of the fuselage.
  const tipStations = spec.wing.length ? spec.wing : spec.stabilizer;
  const tip = tipStations[tipStations.length - 1];
  const nose = tip
    ? ([tip.x * scale, tip.y * scale, (tip.z + tip.chord * 0.25) * scale] as [number, number, number])
    : ([0, 0, 0] as [number, number, number]);

  return {
    surfaces,
    spinners,
    lights: {
      left: [-nose[0], nose[1], nose[2]],
      right: nose,
      tail: [
        0,
        (spec.fuselage.radius * spec.fuselage.upsweep) * scale,
        (spec.fuselage.length / 2) * scale,
      ],
      radius: scale * 0.011,
    },
    dispose: () => {
      surfaces.forEach(({ geometry }) => geometry.dispose());
      spinners.forEach((spinner) => spinner.geometry.dispose());
    },
  };
}

// Material presets shared by the close-up model, kept here so the shading stays
// in step with the vertex colours baked into the fleet.
export const surfaceMaterial: Record<
  AircraftSurface,
  { color: string; metalness: number; roughness: number }
> = {
  shell: { color: '#f4fafd', metalness: 0.36, roughness: 0.26 },
  wing: { color: '#cfdde5', metalness: 0.62, roughness: 0.3 },
  accent: { color: '#1d5fa8', metalness: 0.3, roughness: 0.34 },
  glass: { color: '#0d1c27', metalness: 0.9, roughness: 0.08 },
  engine: { color: '#e3edf2', metalness: 0.72, roughness: 0.2 },
  dark: { color: '#22292e', metalness: 0.55, roughness: 0.52 },
};
