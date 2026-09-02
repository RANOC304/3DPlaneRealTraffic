const defaultTerrainTemplate =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const terrainTemplate = process.env.TERRAIN_TILE_URL?.trim() || defaultTerrainTemplate;
const maximumTerrainZoom = 15;

function terrainUrl(z: number, x: number, y: number) {
  return terrainTemplate
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
    || z > maximumTerrainZoom
    || x < 0
    || y < 0
    || x >= count
    || y >= count
  ) {
    return new Response('Invalid terrain tile', { status: 400 });
  }

  try {
    const response = await fetch(terrainUrl(z, x, y), {
      headers: { Accept: 'image/png' },
      next: { revalidate: 2_592_000 },
    });

    if (!response.ok || !response.body) {
      return new Response('Terrain tile unavailable', { status: response.status || 502 });
    }

    return new Response(response.body, {
      headers: {
        'Content-Type': response.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400',
      },
    });
  } catch {
    return new Response('Terrain tile unavailable', { status: 502 });
  }
}
