import { OVERPASS_URLS } from '../config'
import { fetchWithTimeout } from './places'
import type { LngLat } from './types'

// Traffic lights from OpenStreetMap. The free vector tiles don't carry them, so they come from
// Overpass, a few square kilometers at a time, and each area is fetched only once.

export interface Signal { id: number; coords: LngLat; kind: 'traffic' | 'crossing' }
type BBox = [number, number, number, number] // west, south, east, north

export const SIGNAL_MIN_ZOOM = 15
const CELL = 0.02 // degrees, about 2 km
const MAX_CELLS = 9

/** The grid cells (as "x:y" keys) that cover a map view. */
export function cellsFor([w, s, e, n]: BBox): string[] {
  const keys: string[] = []
  for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) {
    for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) keys.push(`${x}:${y}`)
  }
  return keys
}

export function cellBox(key: string): BBox {
  const [x, y] = key.split(':').map(Number)
  return [x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL]
}

function cellOf([lng, lat]: LngLat): string {
  return `${Math.floor(lng / CELL)}:${Math.floor(lat / CELL)}`
}

/** Overpass elements to signals: a light at a crossing only is a pedestrian signal. */
export function parseSignals(elements: { id: number; lat?: number; lon?: number; tags?: Record<string, string> }[]): Signal[] {
  const out: Signal[] = []
  for (const el of elements) {
    if (el.lat == null || el.lon == null) continue
    const t = el.tags ?? {}
    out.push({ id: el.id, coords: [el.lon, el.lat], kind: t.highway === 'traffic_signals' ? 'traffic' : 'crossing' })
  }
  return out
}

const cache = new Map<string, Signal[]>()

/** All signals in the view, fetching only the areas not seen before. */
export async function loadSignals(view: BBox, signal?: AbortSignal): Promise<Signal[]> {
  const keys = cellsFor(view).slice(0, MAX_CELLS)
  const missing = keys.filter((k) => !cache.has(k))
  if (missing.length) {
    const boxes = missing.map(cellBox)
    const w = Math.min(...boxes.map((b) => b[0])), s = Math.min(...boxes.map((b) => b[1]))
    const e = Math.max(...boxes.map((b) => b[2])), n = Math.max(...boxes.map((b) => b[3]))
    const q = `[out:json][timeout:15];(node["highway"="traffic_signals"](${s},${w},${n},${e});node["crossing"="traffic_signals"](${s},${w},${n},${e}););out body;`
    // Public Overpass servers are often slow or down, so ask them all at once and take the first answer.
    const race = new AbortController()
    const stop = () => race.abort()
    signal?.addEventListener('abort', stop)
    let found: Signal[] | null = null
    try {
      found = await Promise.any([fromQlever([w, s, e, n], race.signal), ...OVERPASS_URLS.map(async (url) => {
        const res = await fetchWithTimeout(url, { method: 'POST', body: new URLSearchParams({ data: q }) }, 25000, race.signal)
        if (!res.ok) throw new Error(`Overpass ${res.status}`)
        const data = (await res.json()) as { elements?: [] }
        if (!data.elements) throw new Error('Overpass gave no data')
        return parseSignals(data.elements)
      })])
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    } finally {
      race.abort()
      signal?.removeEventListener('abort', stop)
    }
    if (!found) throw new Error('Traffic signals could not be loaded')
    for (const k of missing) cache.set(k, [])
    for (const sig of found) cache.get(cellOf(sig.coords))?.push(sig)
  }
  const seen = new Set<number>()
  return keys.flatMap((k) => cache.get(k) ?? []).filter((s) => !seen.has(s.id) && seen.add(s.id))
}

const QLEVER_OSM_URL = 'https://qlever.cs.uni-freiburg.de/api/osm-planet'

/** QLever keeps a copy of OpenStreetMap too, and stays up when Overpass is down. */
async function fromQlever([w, s, e, n]: BBox, signal: AbortSignal): Promise<Signal[]> {
  const query = `PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX osm: <https://www.openstreetmap.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?n ?hw ?wkt WHERE {
  { ?n osmkey:highway "traffic_signals" } UNION { ?n osmkey:crossing "traffic_signals" }
  ?n rdf:type osm:node .
  ?n geo:hasGeometry/geo:asWKT ?wkt .
  OPTIONAL { ?n osmkey:highway ?hw }
  FILTER(geof:longitude(?wkt) >= ${w} && geof:longitude(?wkt) <= ${e} && geof:latitude(?wkt) >= ${s} && geof:latitude(?wkt) <= ${n})
} LIMIT 5000`
  const res = await fetchWithTimeout(QLEVER_OSM_URL, {
    method: 'POST', headers: { Accept: 'application/sparql-results+json' }, body: new URLSearchParams({ query }),
  }, 25000, signal)
  if (!res.ok) throw new Error(`QLever ${res.status}`)
  type B = Record<'n' | 'hw' | 'wkt', { value: string } | undefined>
  const data = (await res.json()) as { results?: { bindings?: B[] } }
  return parseQleverSignals(data.results?.bindings ?? [])
}

export function parseQleverSignals(rows: Record<'n' | 'hw' | 'wkt', { value: string } | undefined>[]): Signal[] {
  const out: Signal[] = []
  const seen = new Set<number>()
  for (const r of rows) {
    const m = r.wkt && /point\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(r.wkt.value)
    const id = Number(r.n?.value.split('/').pop())
    if (!m || !id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, coords: [Number(m[1]), Number(m[2])], kind: r.hw?.value === 'traffic_signals' ? 'traffic' : 'crossing' })
  }
  return out
}
