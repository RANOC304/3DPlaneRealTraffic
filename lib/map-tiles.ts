// Satellite imagery for the globe, served as a level-of-detail tile pyramid.
//
// The rule this module exists to enforce is that the map is *never* torn down to
// make room for a better version of itself. Three things make that true:
//
//   * textures live in a module-level cache keyed by tile, so panning back over
//     ground you already visited is instant instead of a fresh download,
//   * a tile that has no imagery of its own yet draws the matching sub-rectangle
//     of the nearest ancestor that does, so every square metre of the visible
//     globe always carries real satellite pixels — blurry at worst, never blank,
//   * the coarse level is requested before the fine one, so detail sharpens in
//     place rather than appearing all at once after a stall.
//
// Which tiles are needed comes from a quadtree walk driven by how many screen
// pixels each tile would cover, so an oblique horizon view gets fine detail
// underfoot and coarse detail in the distance for a fraction of the requests a
// fixed window around the camera would spend.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Frustum,
  Matrix4,
  type PerspectiveCamera,
  SRGBColorSpace,
  Sphere,
  type Texture,
  TextureLoader,
  Vector3,
} from 'three';

export type MapTile = { zoom: number; x: number; y: number; key: string };

const tileTemplate = process.env.NEXT_PUBLIC_SATELLITE_TILE_URL
  ?? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/** Whole-globe coverage that stays mounted, so no camera move can bare the map. */
export const baseMapZoom = 2;
/** Deepest level the imagery service still answers with real detail. */
export const maxMapZoom = 19;

const degrees = Math.PI / 180;
// Six is the classic per-host browser limit; the tile services speak HTTP/2, so
// a wider pipe still fills the screen faster without starving the API calls.
const maxConcurrentLoads = 12;
const textureBudget = 1200;

type TileStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';
type TileEntry = { texture: Texture | null; status: TileStatus; usedAt: number };

const entries = new Map<string, TileEntry>();
const listeners = new Set<() => void>();
const liveKeys = new Set<string>();
const loader = new TextureLoader();
loader.setCrossOrigin('anonymous');

let queue: MapTile[] = [];
let activeLoads = 0;
let anisotropy = 1;
let notifyHandle: ReturnType<typeof setTimeout> | null = null;

export function mapTileKey(zoom: number, x: number, y: number) {
  return `${zoom}/${x}/${y}`;
}

export function mapTileUrl(zoom: number, x: number, y: number) {
  return tileTemplate
    .replace('{z}', String(zoom))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

const identities = new Map<string, MapTile>();

// One object per tile for the lifetime of the page, so a tile that survives a
// selection pass keeps its identity and the meshes and geometry built from it
// are not rebuilt for a coordinate that has not changed.
function makeTile(zoom: number, x: number, y: number): MapTile {
  const key = mapTileKey(zoom, x, y);
  let tile = identities.get(key);
  if (!tile) {
    tile = { zoom, x, y, key };
    identities.set(key, tile);
  }
  return tile;
}

/** The permanently mounted coverage layer, built once. */
export const baseMapTiles: MapTile[] = (() => {
  const count = 2 ** baseMapZoom;
  const tiles: MapTile[] = [];
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) tiles.push(makeTile(baseMapZoom, x, y));
  return tiles;
})();

/** Anisotropy depends on the GPU, so the renderer hands it over on first mount. */
export function configureMapTiles(maxAnisotropy: number) {
  anisotropy = maxAnisotropy;
}

export function subscribeToMapTiles(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Tiles land in bursts. Coalescing the notifications keeps a screenful of
// arrivals to one React pass instead of eighty.
function notify() {
  if (notifyHandle !== null) return;
  notifyHandle = setTimeout(() => {
    notifyHandle = null;
    listeners.forEach((listener) => listener());
  }, 80);
}

function entryFor(key: string) {
  let entry = entries.get(key);
  if (!entry) {
    entry = { texture: null, status: 'idle', usedAt: 0 };
    entries.set(key, entry);
  }
  return entry;
}

// Outside its published coverage the imagery service answers with a flat pale
// placeholder rather than a 404. Treating that as real map data would paint grey
// over perfectly good lower-zoom imagery, so it is detected and refused.
function isBlankTile(texture: Texture) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !texture.image) return false;
    context.drawImage(texture.image as CanvasImageSource, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data;
    let minimumLight = 255;
    let maximumLight = 0;
    let maximumChroma = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      minimumLight = Math.min(minimumLight, red, green, blue);
      maximumLight = Math.max(maximumLight, red, green, blue);
      maximumChroma = Math.max(maximumChroma, Math.abs(red - green), Math.abs(green - blue), Math.abs(blue - red));
    }
    return minimumLight > 170 && maximumLight - minimumLight < 55 && maximumChroma < 5;
  } catch {
    // A tainted canvas only means the check cannot run; the tile itself is fine.
    return false;
  }
}

function evictColdTextures() {
  if (entries.size <= textureBudget) return;
  const cold = [...entries.entries()]
    .filter(([key, entry]) => (
      entry.status === 'ready' && !liveKeys.has(key) && !key.startsWith(`${baseMapZoom}/`)
    ))
    .sort((first, second) => first[1].usedAt - second[1].usedAt);

  for (const [key, entry] of cold.slice(0, entries.size - textureBudget)) {
    entry.texture?.dispose();
    entries.delete(key);
  }
}

function pump() {
  while (activeLoads < maxConcurrentLoads && queue.length > 0) {
    const tile = queue.shift()!;
    const entry = entryFor(tile.key);
    if (entry.status !== 'idle' && entry.status !== 'failed') continue;

    entry.status = 'loading';
    activeLoads++;
    loader.load(
      mapTileUrl(tile.zoom, tile.x, tile.y),
      (texture) => {
        activeLoads--;
        if (tile.zoom > baseMapZoom && isBlankTile(texture)) {
          texture.dispose();
          entry.status = 'empty';
        } else {
          texture.colorSpace = SRGBColorSpace;
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
          entry.texture = texture;
          entry.status = 'ready';
        }
        entry.usedAt = performance.now();
        evictColdTextures();
        pump();
        notify();
      },
      undefined,
      () => {
        activeLoads--;
        entry.status = 'failed';
        pump();
        notify();
      },
    );
  }
}

/**
 * Replaces the pending work with what the current view needs. Requests already
 * in flight are left alone — they are on their way into the cache either way.
 */
export function requestMapTiles(wanted: MapTile[]) {
  queue = wanted.filter((tile) => {
    const status = entries.get(tile.key)?.status;
    return status === undefined || status === 'idle' || status === 'failed';
  });
  pump();
}

export function isMapTileReady(tile: MapTile) {
  return entries.get(tile.key)?.status === 'ready';
}

/**
 * The sharpest imagery available for this tile right now: its own texture when
 * it has arrived, otherwise the nearest ancestor's, whose matching sub-rectangle
 * the caller drapes over the tile.
 */
export function resolveMapTile(tile: MapTile): { texture: Texture; zoom: number } | null {
  let { zoom, x, y } = tile;
  while (zoom >= 0) {
    const entry = entries.get(mapTileKey(zoom, x, y));
    if (entry?.status === 'ready' && entry.texture) {
      entry.usedAt = performance.now();
      return { texture: entry.texture, zoom };
    }
    zoom--;
    x = Math.floor(x / 2);
    y = Math.floor(y / 2);
  }
  return null;
}

function tileLatitude(y: number, tileCount: number) {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / tileCount))) / degrees;
}

// Matches the globe's own lat/lon convention exactly; a tile drawn on a
// different axis convention than the aircraft would put cities under the wrong
// flight paths.
function spherePoint(lat: number, lon: number, radius: number, target: Vector3) {
  const phi = (90 - lat) * degrees;
  const theta = (lon + 180) * degrees;
  return target.set(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function tileCorner(zoom: number, x: number, y: number, radius: number, target: Vector3) {
  const tileCount = 2 ** zoom;
  return spherePoint(tileLatitude(y, tileCount), (x / tileCount) * 360 - 180, radius, target);
}

/**
 * A flat triangle mesh draped over the curved globe. Segments are sized so each
 * quad spans about a degree of longitude at every zoom: with wider steps the
 * mesh chord sinks beneath the fallback globe underneath it, which is what used
 * to stipple the map with dark diamonds.
 */
export function buildMapTileGeometry(tile: MapTile, radius: number, sourceZoom = tile.zoom) {
  const tileCount = 2 ** tile.zoom;
  const segments = Math.min(96, Math.max(2, Math.ceil(360 / tileCount)));
  // When the imagery comes from an ancestor, the tile covers just a fraction of
  // it; baking that window into the UVs keeps the shared texture untouched, so
  // one cached tile can back any number of descendants at once.
  const span = 2 ** (tile.zoom - sourceZoom);
  const uvScale = 1 / span;
  const uvOriginX = (tile.x % span) * uvScale;
  // Imagery rows run north to south and Three.js UVs run bottom to top.
  const uvOriginY = (span - 1 - (tile.y % span)) * uvScale;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();

  for (let row = 0; row <= segments; row++) {
    const rowProgress = row / segments;
    const lat = tileLatitude(tile.y + rowProgress, tileCount);
    for (let column = 0; column <= segments; column++) {
      const columnProgress = column / segments;
      const lon = ((tile.x + columnProgress) / tileCount) * 360 - 180;
      spherePoint(lat, lon, radius, point);
      positions.push(point.x, point.y, point.z);
      uvs.push(uvOriginX + columnProgress * uvScale, uvOriginY + (1 - rowProgress) * uvScale);
    }
  }

  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const a = row * (segments + 1) + column;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const frustum = new Frustum();
const viewProjection = new Matrix4();
const cameraPosition = new Vector3();
const boundingSphere = new Sphere();
const corner = new Vector3();
const northEdge = new Vector3();
const southEdge = new Vector3();
const westEdge = new Vector3();
const eastEdge = new Vector3();

type Candidate = { zoom: number; x: number; y: number; slack: number };

// How far the walk may guess ahead of the imagery it already holds. Refining
// only under a loaded tile is what makes the map sharpen level by level; a
// couple of levels of slack keeps that from feeling like a staircase, while
// still stopping a dive to street level over open ocean from spending a hundred
// requests to discover there is nothing down there.
const speculativeLevels = 2;

/**
 * Bounds the curved patch a tile covers. Its centre is the tile's own centre on
 * the globe and its radius reaches the corners, which are the patch's furthest
 * points — a bound that is tight enough to cull with and can never clip a tile
 * that is really on screen.
 */
function boundTile(node: Candidate, radius: number) {
  tileCorner(node.zoom, node.x + 0.5, node.y + 0.5, radius, boundingSphere.center);
  let extent = 0;
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    tileCorner(node.zoom, node.x + x, node.y + y, radius, corner);
    extent = Math.max(extent, boundingSphere.center.distanceTo(corner));
  }
  boundingSphere.radius = extent;
}

/**
 * The tiles the camera can currently see, finest where the ground is closest.
 *
 * Returns the levels to draw; the coarser nodes the walk passed through are
 * queued for loading as well so every drawn tile has an ancestor to borrow
 * imagery from while its own is still in flight.
 */
export function selectMapTiles(options: {
  camera: PerspectiveCamera;
  radius: number;
  viewportHeight: number;
  pixelBudget?: number;
  maxZoom?: number;
  maxTiles?: number;
}): MapTile[] {
  const { camera, radius, viewportHeight } = options;
  const pixelBudget = options.pixelBudget ?? 340;
  const deepest = Math.min(maxMapZoom, options.maxZoom ?? maxMapZoom);
  const maxTiles = options.maxTiles ?? 220;

  // The renderer refreshes these during its own pass, which has not run yet for
  // the frame this selection belongs to.
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  camera.getWorldPosition(cameraPosition);
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProjection);

  const pixelsPerUnit = viewportHeight / (2 * Math.tan((camera.fov * degrees) / 2));
  const cameraDistance = Math.max(radius, cameraPosition.length());
  const horizonAngle = Math.acos(Math.min(1, radius / cameraDistance));

  const drawn: Array<{ tile: MapTile; distance: number }> = [];
  const wanted: Array<{ tile: MapTile; distance: number }> = [];
  const stack: Candidate[] = baseMapTiles.map((tile) => ({
    zoom: tile.zoom,
    x: tile.x,
    y: tile.y,
    slack: speculativeLevels,
  }));

  while (stack.length > 0) {
    const node = stack.pop()!;
    boundTile(node, radius);

    const distance = Math.max(1e-6, cameraPosition.distanceTo(boundingSphere.center) - boundingSphere.radius);
    const isBase = node.zoom === baseMapZoom;
    const tile = makeTile(node.zoom, node.x, node.y);

    if (!isBase) {
      // Ground the camera cannot see over the curve of the planet is skipped
      // before the frustum is even consulted; at low altitude that is most of
      // the globe, and requesting it would starve the tiles underfoot.
      const angularRadius = Math.min(Math.PI, boundingSphere.radius / radius);
      const facing = boundingSphere.center.dot(cameraPosition) / (boundingSphere.center.length() * cameraDistance);
      if (facing < Math.cos(horizonAngle + angularRadius)) continue;
      if (!frustum.intersectsSphere(boundingSphere)) continue;
    }

    // Ground size, not the bounding radius: the bound is deliberately generous
    // and would push the whole map one level sharper than it needs to be.
    tileCorner(node.zoom, node.x, node.y + 0.5, radius, westEdge);
    tileCorner(node.zoom, node.x + 1, node.y + 0.5, radius, eastEdge);
    tileCorner(node.zoom, node.x + 0.5, node.y, radius, northEdge);
    tileCorner(node.zoom, node.x + 0.5, node.y + 1, radius, southEdge);
    const groundSize = Math.max(westEdge.distanceTo(eastEdge), northEdge.distanceTo(southEdge));
    const screenSize = (groundSize * pixelsPerUnit) / distance;
    const status = entries.get(tile.key)?.status;
    // A tile the service has no imagery for is the end of that branch: its
    // children would be placeholders too.
    const slack = status === 'ready' ? speculativeLevels : node.slack;
    const refine = node.zoom < deepest && screenSize > pixelBudget && status !== 'empty' && slack > 0;

    if (refine) {
      // The coarse level is still requested: it is what the children borrow
      // imagery from while their own tiles are downloading.
      wanted.push({ tile, distance });
      const childX = node.x * 2;
      const childY = node.y * 2;
      const childSlack = status === 'ready' ? speculativeLevels : slack - 1;
      stack.push(
        { zoom: node.zoom + 1, x: childX, y: childY, slack: childSlack },
        { zoom: node.zoom + 1, x: childX + 1, y: childY, slack: childSlack },
        { zoom: node.zoom + 1, x: childX, y: childY + 1, slack: childSlack },
        { zoom: node.zoom + 1, x: childX + 1, y: childY + 1, slack: childSlack },
      );
      if (isBase) drawn.push({ tile, distance });
      continue;
    }

    drawn.push({ tile, distance });
    wanted.push({ tile, distance });
  }

  if (drawn.length > maxTiles) {
    drawn.sort((first, second) => first.distance - second.distance);
    drawn.length = maxTiles;
  }

  // Coarse before fine, near before far: the view fills in from a complete
  // blurry map and sharpens, instead of arriving as scattered sharp patches.
  wanted.sort((first, second) => (
    first.tile.zoom - second.tile.zoom || first.distance - second.distance
  ));
  requestMapTiles(wanted.map((candidate) => candidate.tile));

  liveKeys.clear();
  for (const candidate of drawn) liveKeys.add(candidate.tile.key);
  for (const tile of baseMapTiles) liveKeys.add(tile.key);

  return drawn.map((candidate) => candidate.tile);
}
