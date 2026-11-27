import { OVERPASS_URLS } from '../config'
import type { DistanceUnits } from './geo'
import { bearingDeg } from './navigation'
import { fetchWithTimeout } from './places'
import { QLEVER_OSM_URL } from './sources'
import type { LngLat } from './types'

// Speed limits from OpenStreetMap, matched to the road you're actually on and the way you're
// driving. The free vector tiles don't carry maxspeed, so the roads around you are loaded from
// Overpass or QLever, about a kilometer square at a time.

export interface Road {
  id: number
  line: LngLat[]
  highway: string
  name?: string
  /** 1: traffic only goes the way the line is drawn; -1: only against it; 0: both ways. */
  oneway: 1 | -1 | 0
  maxspeed?: string
  maxspeedForward?: string
  maxspeedBackward?: string
}

/** A posted limit, kept in the unit it was signed in. */
export interface SpeedLimit { value: number; unit: 'km/h' | 'mph'; kmh: number }

/**
 * A maxspeed tag to a limit. Only a plain number counts as verified ("50", "30 mph"): zone codes
 * like "DE:urban", "none", "signals", "walk" and multiple values ("50;30") give no limit.
 */
export function parseMaxspeed(tag: string | undefined): SpeedLimit | null {
  const m = tag && /^\s*(\d{1,3}(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(tag)
  if (!m) return null
  const value = Number(m[1])
  if (!(value > 0)) return null
  const unit = m[2]?.toLowerCase() === 'mph' ? 'mph' : 'km/h'
  return { value, unit, kmh: unit === 'mph' ? value * 1.609344 : value }
}

/** The limit in the units chosen in Settings: as signed when they match, converted otherwise. */
export function limitIn(limit: SpeedLimit, units: DistanceUnits): number {
  const want = units === 'mi' ? 'mph' : 'km/h'
  if (limit.unit === want) return limit.value
  return Math.round(want === 'mph' ? limit.kmh / 1.609344 : limit.kmh)
}

const angleDiff = (a: number, b: number) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d }

/** Closest point of a line to p: how far away, and the compass bearing of that piece of road. */
function nearestSegment(p: LngLat, line: LngLat[]): { away: number; bearing: number } {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540
  let best = { away: Infinity, bearing: 0 }
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * ky
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * ky
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    if (!len2) continue
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    const away = Math.hypot(ax + t * dx, ay + t * dy)
    if (away < best.away) best = { away, bearing: bearingDeg(line[i], line[i + 1]) }
  }
  return best
}

export interface RoadMatch {
  road: Road
  /** 'forward': driving the way the road is drawn in OSM; 'backward': against it. */
  direction: 'forward' | 'backward'
  away: number
  /** The posted limit for this road in this direction, or null when none is tagged. */
  limit: SpeedLimit | null
}

/** Within this angle of the road's direction counts as driving along it. */
const MAX_TURN_DEG = 35

/**
 * The road you're on, from your position and direction of travel. A road heading another way
 * (a cross street, a parallel road's opposite carriageway, a one-way the wrong way) doesn't
 * count. When two roads fit about equally well and their limits differ, there's no answer:
 * better no limit than the wrong road's.
 */
export function matchRoad(roads: readonly Road[], at: LngLat, heading: number | null, accuracy = 10): RoadMatch | null {
  if (heading == null) return null
  const maxAway = Math.min(35, 15 + accuracy * 0.6)
  const fits: (RoadMatch & { score: number })[] = []
  for (const road of roads) {
    const seg = nearestSegment(at, road.line)
    if (seg.away > maxAway) continue
    const along = angleDiff(heading, seg.bearing), against = angleDiff(heading, seg.bearing + 180)
    const direction = along <= MAX_TURN_DEG ? 'forward' : against <= MAX_TURN_DEG ? 'backward' : null
    if (!direction) continue
    if ((road.oneway === 1 && direction === 'backward') || (road.oneway === -1 && direction === 'forward')) continue
    const tag = direction === 'forward' ? road.maxspeedForward ?? road.maxspeed : road.maxspeedBackward ?? road.maxspeed
    fits.push({ road, direction, away: seg.away, limit: parseMaxspeed(tag), score: seg.away + Math.min(along, against) * 0.4 })
  }
  if (!fits.length) return null
  fits.sort((a, b) => a.score - b.score)
  const [best, next] = fits
  // Roads share end nodes, so the next piece of the same street often fits too; that's fine
  // when it has the same limit.
  if (next && next.score - best.score < 6 && next.limit?.kmh !== best.limit?.kmh) return null
  const { score: _score, ...match } = best
  return match
}

// ---------- loading roads ----------

const DRIVABLE = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road']
const CELL = 0.01 // degrees, about 1 km
type BBox = [number, number, number, number] // west, south, east, north

export const cellOf = ([lng, lat]: LngLat): string => `${Math.floor(lng / CELL)}:${Math.floor(lat / CELL)}`
function cellBox(key: string): BBox {
  const [x, y] = key.split(':').map(Number)
  return [x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL]
}

function onewayOf(tags: Record<string, string | undefined>): 1 | -1 | 0 {
  const v = tags.oneway
  if (v === '-1' || v === 'reverse') return -1
  if (v === 'yes' || v === '1' || v === 'true') return 1
  if (v === 'no') return 0
  // Motorways and roundabouts are one-way unless tagged otherwise.
  if (tags.highway === 'motorway' || tags.junction === 'roundabout') return 1
  return 0
}

function roadFrom(id: number, line: LngLat[], tags: Record<string, string | undefined>): Road | null {
  if (line.length < 2 || !tags.highway || !DRIVABLE.includes(tags.highway)) return null
  return {
    id, line, highway: tags.highway, name: tags.name, oneway: onewayOf(tags),
    maxspeed: tags.maxspeed, maxspeedForward: tags['maxspeed:forward'], maxspeedBackward: tags['maxspeed:backward'],
  }
}

type OverpassWay = { type?: string; id: number; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }
export function parseOverpassRoads(elements: OverpassWay[]): Road[] {
  return elements.flatMap((el) => {
    const r = roadFrom(el.id, (el.geometry ?? []).map((g) => [g.lon, g.lat] as LngLat), el.tags ?? {})
    return r ? [r] : []
  })
}

type QRow = Partial<Record<'w' | 'hw' | 'wkt' | 'ms' | 'msf' | 'msb' | 'ow' | 'jn' | 'nm', { value: string }>>
export function parseQleverRoads(rows: QRow[]): Road[] {
  const out: Road[] = []
  const seen = new Set<number>()
  for (const r of rows) {
    const id = Number(r.w?.value.split('/').pop())
    const m = r.wkt && /linestring\s*\(([^)]*)\)/i.exec(r.wkt.value)
    if (!id || !m || seen.has(id)) continue
    const line = m[1].split(',').map((pt) => pt.trim().split(/\s+/).map(Number) as LngLat).filter((p) => p.length === 2 && p.every(Number.isFinite))
    const road = roadFrom(id, line, { highway: r.hw?.value, maxspeed: r.ms?.value, 'maxspeed:forward': r.msf?.value, 'maxspeed:backward': r.msb?.value,
      oneway: r.ow?.value, junction: r.jn?.value, name: r.nm?.value })
    if (road) { seen.add(id); out.push(road) }
  }
  return out
}

async function fromOverpass([w, s, e, n]: BBox, signal: AbortSignal): Promise<Road[]> {
  const q = `[out:json][timeout:20];way["highway"~"^(${DRIVABLE.join('|')})$"](${s},${w},${n},${e});out tags geom;`
  return Promise.any(OVERPASS_URLS.map(async (url) => {
    const res = await fetchWithTimeout(url, { method: 'POST', body: new URLSearchParams({ data: q }) }, 25000, signal)
    if (!res.ok) throw new Error(`Overpass ${res.status}`)
    const data = (await res.json()) as { elements?: OverpassWay[] }
    if (!data.elements) throw new Error('Overpass gave no data')
    return parseOverpassRoads(data.elements)
  }))
}

async function fromQlever([w, s, e, n]: BBox, signal: AbortSignal): Promise<Road[]> {
  // Ways are found by their middle point, so the box is widened to catch long roads that pass
  // through it; the matching step ignores whatever is too far away.
  const pad = 0.02
  const key = (k: string) => `<https://www.openstreetmap.org/wiki/Key:${k}>`
  const query = `PREFIX osm: <https://www.openstreetmap.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?w ?hw ?wkt ?ms ?msf ?msb ?ow ?jn ?nm WHERE {
  ?w ${key('highway')} ?hw .
  FILTER(?hw IN (${DRIVABLE.map((h) => `"${h}"`).join(', ')}))
  ?w rdf:type osm:way .
  ?w geo:hasCentroid/geo:asWKT ?c .
  FILTER(geof:longitude(?c) >= ${(w - pad).toFixed(4)} && geof:longitude(?c) <= ${(e + pad).toFixed(4)} && geof:latitude(?c) >= ${(s - pad).toFixed(4)} && geof:latitude(?c) <= ${(n + pad).toFixed(4)})
  ?w geo:hasGeometry/geo:asWKT ?wkt .
  OPTIONAL { ?w ${key('maxspeed')} ?ms }
  OPTIONAL { ?w ${key('maxspeed:forward')} ?msf }
  OPTIONAL { ?w ${key('maxspeed:backward')} ?msb }
  OPTIONAL { ?w ${key('oneway')} ?ow }
  OPTIONAL { ?w ${key('junction')} ?jn }
  OPTIONAL { ?w ${key('name')} ?nm }
} LIMIT 20000`
  const res = await fetchWithTimeout(QLEVER_OSM_URL, {
    method: 'POST', headers: { Accept: 'application/sparql-results+json' }, body: new URLSearchParams({ query }),
  }, 25000, signal)
  if (!res.ok) throw new Error(`QLever ${res.status}`)
  const data = (await res.json()) as { results?: { bindings?: QRow[] } }
  const roads = parseQleverRoads(data.results?.bindings ?? [])
  if (!roads.length) throw new Error('QLever gave no roads')
  return roads
}

const cache = new Map<string, Road[]>()
const loading = new Map<string, Promise<Road[]>>()
const failedAt = new Map<string, number>()

/** The roads in the ~1 km cell around a point; fetched once, shared by every caller. */
export function loadRoadsAround(at: LngLat): Promise<Road[]> {
  const key = cellOf(at)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const pending = loading.get(key)
  if (pending) return pending
  // After a failure, wait a bit before asking the busy servers again.
  if (Date.now() - (failedAt.get(key) ?? 0) < 30_000) return Promise.reject(new Error('Roads not available right now'))
  const box = cellBox(key)
  const ctrl = new AbortController()
  const p = Promise.any([fromOverpass(box, ctrl.signal), fromQlever(box, ctrl.signal)])
    .then((roads) => { cache.set(key, roads); return roads })
    .catch((e) => { failedAt.set(key, Date.now()); throw e })
    .finally(() => { ctrl.abort(); loading.delete(key) })
  loading.set(key, p)
  return p
}

/** Roads already loaded near a point (this cell and its neighbors), for instant matching. */
export function roadsNear(at: LngLat): Road[] {
  const [x, y] = cellOf(at).split(':').map(Number)
  const seen = new Set<number>()
  const out: Road[] = []
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const r of cache.get(`${x + dx}:${y + dy}`) ?? []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r) }
  }
  return out
}

/** The point some distance ahead in a direction, to start loading the next cell before you get there. */
export function pointAhead([lng, lat]: LngLat, heading: number, meters: number): LngLat {
  const r = (heading * Math.PI) / 180
  return [lng + (Math.sin(r) * meters) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (Math.cos(r) * meters) / 110540]
}

/** For tests. */
export function _seedRoads(at: LngLat, roads: Road[]): void { cache.set(cellOf(at), roads) }
