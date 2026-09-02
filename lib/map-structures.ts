import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  ShapeUtils,
  Vector2,
  Vector3,
} from 'three';

import { terrainSurfaceRadiusAtMercator } from '@/lib/map-tiles';

export const structureZoom = 14;

export type StructureTileRequest = {
  zoom: number;
  x: number;
  y: number;
  key: string;
};

type TilePoint = { x: number; y: number };
type TilePolygon = { rings: TilePoint[][]; seed: number };

type BuildingPolygon = TilePolygon & {
  height: number;
  minimumHeight: number;
  colour: string | null;
};

export type StructureTile = StructureTileRequest & {
  extent: number;
  buildings: BuildingPolygon[];
  woods: TilePolygon[];
};

export type TreeInstance = {
  position: Vector3;
  height: number;
  radius: number;
  colour: Color;
};

type StructureEntry = {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  usedAt: number;
  tile: StructureTile | null;
};

const entries = new Map<string, StructureEntry>();
const liveKeys = new Set<string>();
const listeners = new Set<() => void>();
const maximumConcurrentLoads = 4;
const tileBudget = 48;
const maximumBuildingFeatures = 5_000;
const maximumVerticesPerTile = 260_000;
const maximumTreesPerTile = 520;
const earthRadiusMeters = 6_371_000;
const structureHeightExaggeration = 1.35;
const degrees = Math.PI / 180;

let queue: StructureTileRequest[] = [];
let activeLoads = 0;
let notifyHandle: ReturnType<typeof setTimeout> | null = null;

function notify() {
  if (notifyHandle !== null) return;
  notifyHandle = setTimeout(() => {
    notifyHandle = null;
    listeners.forEach((listener) => listener());
  }, 80);
}

export function subscribeToStructureTiles(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function entryFor(key: string) {
  let entry = entries.get(key);
  if (!entry) {
    entry = { status: 'idle', usedAt: 0, tile: null };
    entries.set(key, entry);
  }
  return entry;
}

function asNumber(value: number | string | boolean | undefined, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function copyPolygons(rings: ReturnType<ReturnType<VectorTile['layers'][string]['feature']>['loadGeometry']>) {
  return classifyRings(rings).map((polygon) => polygon.map((ring) => (
    ring.map((point) => ({ x: point.x, y: point.y }))
  )));
}

function parseStructureTile(request: StructureTileRequest, bytes: ArrayBuffer): StructureTile {
  if (bytes.byteLength === 0) return { ...request, extent: 4096, buildings: [], woods: [] };
  const vectorTile = new VectorTile(new PbfReader(bytes));
  const buildingLayer = vectorTile.layers.building;
  const landcoverLayer = vectorTile.layers.landcover;
  const transportationLayer = vectorTile.layers.transportation;
  const extent = buildingLayer?.extent ?? landcoverLayer?.extent ?? transportationLayer?.extent ?? 4096;
  const buildings: BuildingPolygon[] = [];
  const woods: TilePolygon[] = [];

  if (buildingLayer) {
    const count = Math.min(buildingLayer.length, maximumBuildingFeatures);
    for (let index = 0; index < count; index++) {
      const feature = buildingLayer.feature(index);
      if (feature.type !== 3 || feature.properties.hide_3d === true || feature.properties.hide_3d === 1) continue;
      const minimumHeight = Math.max(0, asNumber(feature.properties.render_min_height, 0));
      const measuredHeight = asNumber(feature.properties.render_height, 9);
      const height = Math.max(minimumHeight + 1.5, Math.min(420, measuredHeight));
      const colour = typeof feature.properties.colour === 'string' ? feature.properties.colour : null;
      for (const [part, rings] of copyPolygons(feature.loadGeometry()).entries()) {
        buildings.push({
          rings,
          height,
          minimumHeight,
          colour,
          seed: (feature.id ?? index) * 31 + part,
        });
      }
    }
  }

  if (transportationLayer) {
    for (let index = 0; index < transportationLayer.length; index++) {
      const feature = transportationLayer.feature(index);
      if (
        feature.type !== 3
        || (feature.properties.class !== 'bridge' && feature.properties.brunnel !== 'bridge')
      ) continue;
      const layer = Math.max(1, asNumber(feature.properties.layer, 1));
      const minimumHeight = 3 + layer * 3.5;
      for (const [part, rings] of copyPolygons(feature.loadGeometry()).entries()) {
        buildings.push({
          rings,
          minimumHeight,
          height: minimumHeight + 1.4,
          colour: '#8d969a',
          seed: 900_000 + (feature.id ?? index) * 41 + part,
        });
      }
    }
  }

  if (landcoverLayer) {
    for (let index = 0; index < landcoverLayer.length; index++) {
      const feature = landcoverLayer.feature(index);
      if (feature.type !== 3 || feature.properties.class !== 'wood') continue;
      for (const [part, rings] of copyPolygons(feature.loadGeometry()).entries()) {
        woods.push({ rings, seed: (feature.id ?? index) * 37 + part });
      }
    }
  }

  return { ...request, extent, buildings, woods };
}

function evictColdTiles() {
  if (entries.size <= tileBudget) return;
  const cold = [...entries.entries()]
    .filter(([key, entry]) => entry.status === 'ready' && !liveKeys.has(key))
    .sort((first, second) => first[1].usedAt - second[1].usedAt);
  for (const [key] of cold.slice(0, entries.size - tileBudget)) entries.delete(key);
}

function pump() {
  while (activeLoads < maximumConcurrentLoads && queue.length > 0) {
    const request = queue.shift()!;
    const entry = entryFor(request.key);
    if (entry.status !== 'idle') continue;
    entry.status = 'loading';
    activeLoads++;

    void fetch(`/api/structures/${request.zoom}/${request.x}/${request.y}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Structure tile returned ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => {
        entry.tile = parseStructureTile(request, bytes);
        entry.status = 'ready';
      })
      .catch(() => {
        entry.tile = null;
        entry.status = 'failed';
      })
      .finally(() => {
        activeLoads--;
        entry.usedAt = performance.now();
        evictColdTiles();
        pump();
        notify();
      });
  }
}

export function requestStructureTiles(requests: StructureTileRequest[]) {
  liveKeys.clear();
  for (const request of requests) liveKeys.add(request.key);
  queue = requests.filter((request) => {
    const status = entries.get(request.key)?.status;
    return status === undefined || status === 'idle';
  });
  pump();
}

export function resolveStructureTile(request: StructureTileRequest) {
  const entry = entries.get(request.key);
  if (entry?.status !== 'ready' || !entry.tile) return null;
  entry.usedAt = performance.now();
  return entry.tile;
}

export function structureRequestsNear(globalX: number, globalY: number, radius: number) {
  const count = 2 ** structureZoom;
  const centerX = Math.floor((((globalX % 1) + 1) % 1) * count);
  const centerY = Math.max(0, Math.min(count - 1, Math.floor(globalY * count)));
  const requests: StructureTileRequest[] = [];
  for (let offsetY = -radius; offsetY <= radius; offsetY++) {
    const y = centerY + offsetY;
    if (y < 0 || y >= count) continue;
    for (let offsetX = -radius; offsetX <= radius; offsetX++) {
      const x = ((centerX + offsetX) % count + count) % count;
      requests.push({ zoom: structureZoom, x, y, key: `${structureZoom}/${x}/${y}` });
    }
  }
  return requests;
}

export function worldPointToMercator(point: Vector3) {
  const length = point.length();
  if (length < 1e-9) return { x: 0.5, y: 0.5 };
  const latitude = Math.asin(point.y / length);
  const longitude = Math.atan2(-point.z, point.x);
  const limitedLatitude = Math.max(-85.05112878 * degrees, Math.min(85.05112878 * degrees, latitude));
  return {
    x: longitude / (2 * Math.PI) + 0.5,
    y: (1 - Math.asinh(Math.tan(limitedLatitude)) / Math.PI) / 2,
  };
}

function cleanRing(ring: TilePoint[]) {
  if (ring.length < 3) return [];
  const last = ring[ring.length - 1];
  const points = ring[0].x === last.x && ring[0].y === last.y ? ring.slice(0, -1) : ring;
  return points.length >= 3 ? points : [];
}

function positionFor(
  tile: StructureTile,
  point: TilePoint,
  baseRadius: number,
  heightMeters: number,
  target = new Vector3(),
) {
  const count = 2 ** tile.zoom;
  const globalX = (tile.x + point.x / tile.extent) / count;
  const globalY = (tile.y + point.y / tile.extent) / count;
  const longitude = (globalX * 360 - 180) * degrees;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * globalY)));
  const radius = terrainSurfaceRadiusAtMercator(globalX, globalY, baseRadius)
    + (heightMeters / earthRadiusMeters) * baseRadius * structureHeightExaggeration;
  const cosLatitude = Math.cos(latitude);
  return target.set(
    radius * cosLatitude * Math.cos(longitude),
    radius * Math.sin(latitude),
    -radius * cosLatitude * Math.sin(longitude),
  );
}

const buildingPalette = ['#9ea6a5', '#b1aaa0', '#8f9ca2', '#b6b3a8', '#89979a'];

function buildingColour(value: string | null, seed: number) {
  const fallback = buildingPalette[Math.abs(seed) % buildingPalette.length];
  if (!value || !/^(#[\da-f]{3,8}|[a-z]{3,20})$/i.test(value.trim())) return new Color(fallback);
  try {
    return new Color(value.trim());
  } catch {
    return new Color(fallback);
  }
}

export function buildStructureGeometry(tile: StructureTile, baseRadius: number) {
  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const scratch = new Vector3();
  const roofTint = new Color('#d9e1df');

  const addVertex = (point: TilePoint, height: number, colour: Color) => {
    positionFor(tile, point, baseRadius, height, scratch);
    positions.push(scratch.x, scratch.y, scratch.z);
    colours.push(colour.r, colour.g, colour.b);
    return positions.length / 3 - 1;
  };

  for (const building of tile.buildings) {
    if (positions.length / 3 >= maximumVerticesPerTile) break;
    const rings = building.rings.map(cleanRing).filter((ring) => ring.length >= 3);
    if (rings.length === 0) continue;
    const wallColour = buildingColour(building.colour, building.seed);
    const roofColour = wallColour.clone().lerp(roofTint, 0.28);
    const contour = rings[0].map((point) => new Vector2(point.x, point.y));
    const holes = rings.slice(1).map((ring) => ring.map((point) => new Vector2(point.x, point.y)));
    const roofTriangles = ShapeUtils.triangulateShape(contour, holes);
    const roofPoints = rings.flat();
    const roofStart = positions.length / 3;
    for (const point of roofPoints) addVertex(point, building.height, roofColour);
    for (const triangle of roofTriangles) {
      indices.push(roofStart + triangle[0], roofStart + triangle[1], roofStart + triangle[2]);
    }

    for (const ring of rings) {
      for (let index = 0; index < ring.length; index++) {
        const next = (index + 1) % ring.length;
        const bottomA = addVertex(ring[index], building.minimumHeight, wallColour);
        const bottomB = addVertex(ring[next], building.minimumHeight, wallColour);
        const topA = addVertex(ring[index], building.height, wallColour);
        const topB = addVertex(ring[next], building.height, wallColour);
        indices.push(bottomA, bottomB, topA, topA, bottomB, topB);
      }
    }
  }

  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function pointInRing(point: TilePoint, ring: TilePoint[]) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const a = ring[current];
    const b = ring[previous];
    if (
      (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) inside = !inside;
  }
  return inside;
}

function hash(value: number) {
  const sine = Math.sin(value * 12.9898) * 43758.5453;
  return sine - Math.floor(sine);
}

export function buildTreeInstances(tile: StructureTile, baseRadius: number) {
  const trees: TreeInstance[] = [];
  const spacing = 104;
  const treePalette = ['#23533f', '#2d6449', '#1d4939', '#386c4b'];

  for (const wood of tile.woods) {
    const rings = wood.rings.map(cleanRing).filter((ring) => ring.length >= 3);
    if (rings.length === 0) continue;
    const outer = rings[0];
    const minimumX = Math.min(...outer.map((point) => point.x));
    const maximumX = Math.max(...outer.map((point) => point.x));
    const minimumY = Math.min(...outer.map((point) => point.y));
    const maximumY = Math.max(...outer.map((point) => point.y));

    for (let y = Math.floor(minimumY / spacing) * spacing; y <= maximumY; y += spacing) {
      for (let x = Math.floor(minimumX / spacing) * spacing; x <= maximumX; x += spacing) {
        const seed = wood.seed + x * 0.17 + y * 0.31;
        const point = {
          x: x + spacing * (0.18 + hash(seed) * 0.64),
          y: y + spacing * (0.18 + hash(seed + 19.3) * 0.64),
        };
        if (!pointInRing(point, outer) || rings.slice(1).some((ring) => pointInRing(point, ring))) continue;
        const heightMeters = 7 + hash(seed + 41.7) * 10;
        const surface = positionFor(tile, point, baseRadius, 0);
        trees.push({
          position: surface.clone(),
          height: (heightMeters / earthRadiusMeters) * baseRadius * 1.25,
          radius: ((2.4 + hash(seed + 73.1) * 2.8) / earthRadiusMeters) * baseRadius * 1.25,
          colour: new Color(treePalette[Math.floor(hash(seed + 101.9) * treePalette.length)]),
        });
        if (trees.length >= maximumTreesPerTile) return trees;
      }
    }
  }

  return trees;
}
