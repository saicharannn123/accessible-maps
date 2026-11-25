// BM Locator's own map data.
//
// A GitHub Actions job (.github/workflows/build-map-data.yml) builds our own vector tiles from
// OpenStreetMap with Planetiler, in the same OpenMapTiles layout the map styles already use, and
// the site serves them as one PMTiles file at tiles/bm-locator.pmtiles. The map's tile source is
// swapped for the bmtiles:// protocol below: a tile that lies fully inside our coverage comes from
// our own file; any other tile (or every tile, when the file is missing, e.g. in local dev) still
// comes from OpenFreeMap. When our file grows to cover the whole world, OpenFreeMap is no longer
// used at all, with no code change.
import * as maplibregl from 'maplibre-gl'
import type { StyleSpecification, VectorSourceSpecification } from 'maplibre-gl'
import { PMTiles } from 'pmtiles'

export const OWN_TILES_FILE = 'tiles/bm-locator.pmtiles'
/** Set VITE_MAP_DATA_URL to serve the file from our own server or bucket (e.g. the whole world). */
const OWN_TILES_URL: string | undefined = import.meta.env.VITE_MAP_DATA_URL || undefined
const PROTOCOL = 'bmtiles'
/** The OpenMapTiles source id that OpenFreeMap's styles (and our restyles of them) draw from. */
const SOURCE_ID = 'openmaptiles'

/** OpenStreetMap's licence (ODbL) and the OpenMapTiles schema licence both need this credit. */
export const OWN_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a>'
const FALLBACK_ATTRIBUTION = ' · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> outside our area'

export interface Coverage {
  /** [west, south, east, north] in degrees. */
  bounds: [number, number, number, number]
  minZoom: number
  maxZoom: number
}

let archive: PMTiles | null = null
let coverage: Promise<Coverage | null> | null = null
/** OpenFreeMap TileJSON URL → its tile URL template, fetched once. */
const fallbackTemplates = new Map<string, Promise<string | null>>()
let registered = false

function ownUrl(): string {
  return new URL(OWN_TILES_URL ?? OWN_TILES_FILE, document.baseURI).href
}

/** What our own tile file covers, or null when the site has none (yet). */
export function ownCoverage(): Promise<Coverage | null> {
  if (!coverage) {
    archive = new PMTiles(ownUrl())
    coverage = archive.getHeader().then(
      (h) => ({ bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], minZoom: h.minZoom, maxZoom: h.maxZoom }) as Coverage,
      () => null,
    )
  }
  return coverage
}

/** The tile's corners in degrees: [west, south, east, north]. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z
  const lon = (i: number) => (i / n) * 360 - 180
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)]
}

/** True when the whole tile lies inside our coverage, so our file has all of its data. */
export function tileInside(z: number, x: number, y: number, c: Coverage | null): boolean {
  if (!c || z < c.minZoom || z > c.maxZoom) return false
  const [w, s, e, n] = tileBounds(z, x, y)
  const [cw, cs, ce, cn] = c.bounds
  return w >= cw && e <= ce && s >= cs && n <= cn
}

function fallbackTemplate(tileJsonUrl: string): Promise<string | null> {
  let t = fallbackTemplates.get(tileJsonUrl)
  if (!t) {
    t = fetch(tileJsonUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { tiles?: string[] } | null) => j?.tiles?.[0] ?? null)
      .catch(() => null)
    fallbackTemplates.set(tileJsonUrl, t)
  }
  return t
}

/** Registers bmtiles://{z}/{x}/{y}?fallback=<TileJSON url> with MapLibre (once). */
export function registerOwnTiles() {
  if (registered) return
  registered = true
  maplibregl.addProtocol(PROTOCOL, async (params, abort) => {
    const m = /^bmtiles:\/\/(\d+)\/(\d+)\/(\d+)(?:\?fallback=(.*))?$/.exec(params.url)
    if (!m) throw new Error(`Bad tile url ${params.url}`)
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (tileInside(z, x, y, await ownCoverage())) {
      const tile = await archive!.getZxy(z, x, y, abort.signal).catch(() => undefined)
      if (tile?.data) return { data: new Uint8Array(tile.data), cacheControl: tile.cacheControl, expires: tile.expires }
    }
    const template = m[4] ? await fallbackTemplate(decodeURIComponent(m[4])) : null
    if (!template) return { data: new Uint8Array() } // nothing to show here
    const res = await fetch(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { signal: abort.signal })
    if (res.status === 204 || res.status === 404) return { data: new Uint8Array() }
    if (!res.ok) throw new Error(`Tile ${z}/${x}/${y}: ${res.status}`)
    return { data: new Uint8Array(await res.arrayBuffer()) }
  })
}

/**
 * Points the style's OpenMapTiles source at our own tiles (falling back to the original source
 * outside our coverage) and gives it BM Locator's credit line.
 */
export function withOwnTiles(style: StyleSpecification): StyleSpecification {
  const src = style.sources?.[SOURCE_ID] as VectorSourceSpecification | undefined
  if (!src || src.type !== 'vector') return style
  if (src.tiles?.[0]?.startsWith(`${PROTOCOL}://`)) return style
  const fallback = src.url ? `?fallback=${encodeURIComponent(src.url)}` : ''
  const own: VectorSourceSpecification = {
    type: 'vector',
    tiles: [`${PROTOCOL}://{z}/{x}/{y}${fallback}`],
    minzoom: 0,
    maxzoom: 14, // OpenMapTiles tiles stop at 14; MapLibre zooms them further on its own
    attribution: OWN_ATTRIBUTION + (fallback ? FALLBACK_ATTRIBUTION : ''),
  }
  return { ...style, sources: { ...style.sources, [SOURCE_ID]: own } }
}
