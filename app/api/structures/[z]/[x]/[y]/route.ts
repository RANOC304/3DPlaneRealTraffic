const defaultTileJsonUrl = 'https://tiles.openfreemap.org/planet';
const maximumStructureZoom = 14;
const tileJsonUrl = process.env.STRUCTURE_TILEJSON_URL?.trim() || defaultTileJsonUrl;
const fixedTileTemplate = process.env.STRUCTURE_TILE_URL?.trim();

type TileJson = { tiles?: unknown };

let cachedTemplate: { value: string; expiresAt: number } | null = null;

async function structureTileTemplate() {
  if (fixedTileTemplate) return fixedTileTemplate;
  const now = Date.now();
  if (cachedTemplate && cachedTemplate.expiresAt > now) return cachedTemplate.value;

  const response = await fetch(tileJsonUrl, { next: { revalidate: 21_600 } });
  if (!response.ok) throw new Error(`Structure TileJSON returned ${response.status}`);
  const data = (await response.json()) as TileJson;
  const template = Array.isArray(data.tiles)
    ? data.tiles.find((value): value is string => typeof value === 'string')
    : undefined;
  if (!template || !template.includes('{z}') || !template.includes('{x}') || !template.includes('{y}')) {
    throw new Error('Structure TileJSON has no usable tile template');
  }

  cachedTemplate = { value: template, expiresAt: now + 21_600_000 };
  return template;
}

function structureUrl(template: string, z: number, x: number, y: number) {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ z: string; x: string; y: string }> },
) {
  const params = await context.params;
  const z = Number(params.z);
  const x = Number(params.x);
  const y = Number(params.y);
  const count = 2 ** z;

  if (
    !Number.isInteger(z)
    || !Number.isInteger(x)
    || !Number.isInteger(y)
    || z < 0
    || z > maximumStructureZoom
    || x < 0
    || y < 0
    || x >= count
    || y >= count
  ) {
    return new Response('Invalid structure tile', { status: 400 });
  }

  try {
    const template = await structureTileTemplate();
    const response = await fetch(structureUrl(template, z, x, y), {
      headers: { Accept: 'application/vnd.mapbox-vector-tile, application/x-protobuf' },
      next: { revalidate: 604_800 },
    });

    if (!response.ok || !response.body) {
      return new Response('Structure tile unavailable', { status: response.status || 502 });
    }

    return new Response(response.body, {
      headers: {
        'Content-Type': 'application/vnd.mapbox-vector-tile',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
      },
    });
  } catch {
    return new Response('Structure tile unavailable', { status: 502 });
  }
}
