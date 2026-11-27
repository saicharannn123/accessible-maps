import { distanceMeters, formatDistance } from './geo'
import { cityStatePostal, cleanPostcode, postalCodeName } from './address'
import type { LngLat, Place } from './types'

// Backup search sources, so a search still answers when the main one (Photon) is busy or down.
// All are free and keyless: Nominatim (OpenStreetMap's own search) and QLever's copy of OSM.

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
export const QLEVER_OSM_URL = 'https://qlever.cs.uni-freiburg.de/api/osm-planet'

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
})

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * fetch + JSON with a time limit, retrying busy answers (429, 5xx) and network errors with a
 * growing pause. Gives up after `tries` attempts. Your own cancel (signal) stops it at once.
 */
export async function fetchJson<T>(url: string, init: RequestInit = {}, opts: { timeout?: number; tries?: number; signal?: AbortSignal } = {}): Promise<T> {
  const { timeout = 8000, tries = 2, signal } = opts
  let last: unknown
  for (let i = 0; i < tries; i++) {
    if (i > 0) await wait(500 * 2 ** (i - 1) + Math.random() * 250, signal)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    const stop = () => ctrl.abort()
    signal?.addEventListener('abort', stop)
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal })
      if (res.ok) return (await res.json()) as T
      last = new Error(`${new URL(url).host} answered ${res.status}`)
      if (res.status !== 429 && res.status < 500) break // a real "no", retrying won't help
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      last = e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
  }
  throw last instanceof Error ? last : new Error('Search source unavailable')
}

/** First answer that succeeds; fails only if all fail. */
export function firstOf<T>(tries: Promise<T>[]): Promise<T> {
  return Promise.any(tries).catch((e: AggregateError) => {
    if (e.errors?.some(isAbort)) throw new DOMException('Aborted', 'AbortError')
    throw e.errors?.[0] ?? e
  })
}

interface NominatimRow {
  lat: string
  lon: string
  name?: string
  display_name: string
  type?: string
  category?: string
  osm_type?: string
  osm_id?: number
  address?: Record<string, string>
}

/** Nominatim rows to places, in the same shape as Photon's. Exported for tests. */
export function nominatimPlaces(rows: NominatimRow[], from: LngLat | undefined): Place[] {
  return rows.map((r) => {
    const coords: LngLat = [Number(r.lon), Number(r.lat)]
    const a = r.address ?? {}
    const street = [a.house_number, a.road].filter(Boolean).join(' ')
    const town = a.city || a.town || a.village || a.hamlet || a.suburb
    const country = a.country_code?.toUpperCase()
    const postcode = cleanPostcode(a.postcode, country)
    const isPostcodeArea = r.type === 'postcode'
    const area = cityStatePostal({ city: town, state: a.state, postcode: isPostcodeArea ? undefined : postcode, country })
    const name = isPostcodeArea ? (postcode ?? r.display_name.split(',')[0]) : r.name || street || r.display_name.split(',')[0]
    const where = [r.name && !isPostcodeArea ? street : '', area].filter(Boolean).join(', ')
    const away = from ? formatDistance(distanceMeters(from, coords)) : ''
    const what = isPostcodeArea ? postalCodeName(country) : ''
    const place: Place = { name, detail: [away, what, where].filter(Boolean).join(' · '), coords }
    if (postcode) place.postcode = postcode
    if (country) place.country = country
    if (area) place.area = area
    if (street) place.street = street
    if (a.county) place.county = a.county
    if (r.osm_type && r.osm_id) place.osm = `${r.osm_type}/${r.osm_id}`
    if (isPostcodeArea) place.icon = '📮'
    return place
  })
}

/** Text search on Nominatim, optionally inside a box (west,south,east,north). */
export async function nominatimSearch(q: string, from: LngLat, box: string | null, limit: number, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: String(limit), 'accept-language': 'en' })
  if (box) {
    const [w, s, e, n] = box.split(',')
    params.set('viewbox', [w, n, e, s].join(','))
    params.set('bounded', '1')
  }
  const rows = await fetchJson<NominatimRow[]>(`${NOMINATIM_URL}?${params}`, {}, { timeout: 8000, tries: 2, signal })
  return nominatimPlaces(rows, from)
}

/** Postal-code areas with this exact code (a ZIP, PIN or postcode), in any country. */
export async function nominatimPostcode(code: string, from: LngLat, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ postalcode: code, format: 'jsonv2', addressdetails: '1', limit: '10', 'accept-language': 'en' })
  const rows = await fetchJson<NominatimRow[]>(`${NOMINATIM_URL}?${params}`, {}, { timeout: 8000, tries: 2, signal })
  const want = code.replace(/\s+/g, '').toUpperCase()
  const same = (r: NominatimRow) => (r.address?.postcode ?? '').replace(/\s+/g, '').toUpperCase().startsWith(want)
  return nominatimPlaces(rows.filter((r) => r.type === 'postcode' || same(r)), from)
}

type Cell = { value: string } | undefined
type OsmRow = Record<'o' | 'name' | 'c' | 'street' | 'num' | 'city', Cell>

const KEY = (k: string) => `<https://www.openstreetmap.org/wiki/Key:${k}>`

/** What to look for in OpenStreetMap: tags like "amenity:cafe", or a sport or cuisine. */
export interface OsmWant { tags?: string[]; sport?: string; cuisine?: string }

/** A SPARQL query for named OSM places matching `want` within `radiusDeg` of a point. Exported for tests. */
export function osmNearbyQuery(want: OsmWant, [lng, lat]: LngLat, radiusDeg = 0.25, limit = 40): string {
  const dLng = radiusDeg / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  const parts: string[] = []
  for (const t of want.tags ?? []) {
    const [k, v] = t.split(':')
    if (k && v) parts.push(`{ ?o ${KEY(k)} "${v.replace(/"/g, '')}" }`)
  }
  if (want.sport) parts.push(`{ ?o ${KEY('sport')} ?sp . FILTER(CONTAINS(?sp, "${want.sport.replace(/"/g, '')}")) }`)
  if (want.cuisine) parts.push(`{ ?o ${KEY('cuisine')} ?cu . FILTER(REGEX(?cu, "${want.cuisine.replace(/"/g, '')}")) }`)
  return `PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT ?o (SAMPLE(?nm) AS ?name) (SAMPLE(?wkt) AS ?c) (SAMPLE(?st) AS ?street) (SAMPLE(?hn) AS ?num) (SAMPLE(?ct) AS ?city) WHERE {
  ${parts.join(' UNION ')}
  ?o ${KEY('name')} ?nm .
  ?o geo:hasCentroid/geo:asWKT ?wkt .
  FILTER(geof:longitude(?wkt) >= ${(lng - dLng).toFixed(4)} && geof:longitude(?wkt) <= ${(lng + dLng).toFixed(4)} && geof:latitude(?wkt) >= ${(lat - radiusDeg).toFixed(4)} && geof:latitude(?wkt) <= ${(lat + radiusDeg).toFixed(4)})
  OPTIONAL { ?o ${KEY('addr:street')} ?st }
  OPTIONAL { ?o ${KEY('addr:housenumber')} ?hn }
  OPTIONAL { ?o ${KEY('addr:city')} ?ct }
}
GROUP BY ?o LIMIT ${limit}`
}

/** QLever OSM rows to places, nearest first. Exported for tests. */
export function osmPlaces(rows: OsmRow[], from: LngLat, icon?: string): Place[] {
  const out: (Place & { d: number })[] = []
  for (const r of rows) {
    const m = r.c && /point\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(r.c.value)
    if (!m || !r.name) continue
    const coords: LngLat = [Number(m[1]), Number(m[2])]
    const d = distanceMeters(from, coords)
    const street = [r.num?.value, r.street?.value].filter(Boolean).join(' ')
    const where = [street, r.city?.value].filter(Boolean).join(', ')
    out.push({ name: r.name.value, detail: [formatDistance(d), where].filter(Boolean).join(' · '), coords, icon, d })
  }
  return out.sort((a, b) => a.d - b.d).map((p) => ({ name: p.name, detail: p.detail, coords: p.coords, icon: p.icon }))
}

/** Named places of a kind near a point, from QLever's copy of OpenStreetMap. */
export async function osmNearby(want: OsmWant, from: LngLat, icon: string | undefined, signal?: AbortSignal): Promise<Place[]> {
  const data = await fetchJson<{ results?: { bindings?: OsmRow[] } }>(QLEVER_OSM_URL, {
    method: 'POST',
    headers: { Accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query: osmNearbyQuery(want, from) }),
  }, { timeout: 12000, tries: 1, signal })
  return osmPlaces(data.results?.bindings ?? [], from, icon)
}

/** A small memory of recent answers, so repeat searches are instant and survive a hiccup. */
export class AnswerCache<T> {
  private map = new Map<string, { at: number; value: T }>()
  private ttlMs: number
  private max: number
  constructor(ttlMs = 10 * 60_000, max = 80) { this.ttlMs = ttlMs; this.max = max }
  get(key: string): T | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > this.ttlMs) return undefined
    return hit.value
  }
  /** Even an expired answer, as a last resort when every source is down. */
  stale(key: string): T | undefined { return this.map.get(key)?.value }
  set(key: string, value: T) {
    this.map.delete(key)
    this.map.set(key, { at: Date.now(), value })
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }
}
