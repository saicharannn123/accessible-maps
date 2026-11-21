import { OSM_API_URL, OVERPASS_URLS, PHOTON_REVERSE_URL } from '../config'
import { distanceMeters } from './geo'
import type { LngLat } from './types'

/** One "near me" category, like the quick buttons in Google Maps and Apple Maps. */
export interface Category {
  id: string
  label: string
  icon: string
  color: string
  /** Overpass tag filters; a place matches if any one of them matches. */
  filters: string[]
  /** The same places as Photon osm_tag filters ("key:value"). */
  photon: string[]
  /** Unnamed places (e.g. a car park) are still useful for some categories. */
  allowUnnamed?: boolean
}

const SHOP_TYPES = 'clothes|shoes|electronics|mobile_phone|books|gift|jewelry|sports|furniture|hardware|doityourself|beauty|cosmetics|variety_store|toys|optician|computer|bag|boutique|houseware|stationery'

export const CATEGORIES: Category[] = [
  { id: 'restaurants', label: 'Restaurants', icon: '🍽️', color: '#ea580c', photon: ['amenity:restaurant'], filters: ['["amenity"="restaurant"]'] },
  { id: 'coffee', label: 'Coffee', icon: '☕', color: '#92400e', photon: ['amenity:cafe'], filters: ['["amenity"="cafe"]'] },
  { id: 'fast-food', label: 'Takeout', icon: '🍔', color: '#dc2626', photon: ['amenity:fast_food'], filters: ['["amenity"="fast_food"]'] },
  { id: 'groceries', label: 'Groceries', icon: '🛒', color: '#16a34a', photon: ['shop:supermarket', 'shop:convenience', 'shop:greengrocer', 'shop:grocery'], filters: ['["shop"~"^(supermarket|convenience|greengrocer|grocery)$"]'] },
  { id: 'malls', label: 'Malls', icon: '🏬', color: '#7c3aed', photon: ['shop:mall', 'shop:department_store'], filters: ['["shop"~"^(mall|department_store)$"]'] },
  { id: 'shops', label: 'Shopping', icon: '🛍️', color: '#db2777', photon: SHOP_TYPES.split('|').map((v) => `shop:${v}`), filters: [`["shop"~"^(${SHOP_TYPES})$"]`] },
  { id: 'gas', label: 'Gas', icon: '⛽', color: '#0f766e', photon: ['amenity:fuel'], filters: ['["amenity"="fuel"]'], allowUnnamed: true },
  { id: 'ev', label: 'EV charging', icon: '🔌', color: '#059669', photon: ['amenity:charging_station'], filters: ['["amenity"="charging_station"]'], allowUnnamed: true },
  { id: 'pharmacy', label: 'Pharmacies', icon: '💊', color: '#0891b2', photon: ['amenity:pharmacy', 'shop:chemist'], filters: ['["amenity"="pharmacy"]', '["shop"="chemist"]'] },
  { id: 'hospitals', label: 'Hospitals', icon: '🏥', color: '#be123c', photon: ['amenity:hospital', 'amenity:clinic'], filters: ['["amenity"~"^(hospital|clinic)$"]'] },
  { id: 'atm', label: 'ATMs & banks', icon: '🏧', color: '#1d4ed8', photon: ['amenity:atm', 'amenity:bank'], filters: ['["amenity"~"^(atm|bank)$"]'], allowUnnamed: true },
  { id: 'hotels', label: 'Hotels', icon: '🏨', color: '#4338ca', photon: ['tourism:hotel', 'tourism:motel', 'tourism:guest_house', 'tourism:hostel'], filters: ['["tourism"~"^(hotel|motel|guest_house|hostel)$"]'] },
  { id: 'parking', label: 'Parking', icon: '🅿️', color: '#2563eb', photon: ['amenity:parking'], filters: ['["amenity"="parking"]'], allowUnnamed: true },
  { id: 'bars', label: 'Bars', icon: '🍸', color: '#9333ea', photon: ['amenity:bar', 'amenity:pub'], filters: ['["amenity"~"^(bar|pub)$"]'] },
  { id: 'parks', label: 'Parks', icon: '🌳', color: '#15803d', photon: ['leisure:park'], filters: ['["leisure"="park"]'] },
  { id: 'gyms', label: 'Gyms', icon: '🏋️', color: '#475569', photon: ['leisure:fitness_centre'], filters: ['["leisure"="fitness_centre"]'] },
  { id: 'transit', label: 'Transit', icon: '🚉', color: '#0369a1', photon: ['railway:station', 'railway:halt', 'amenity:bus_station'], filters: ['["railway"~"^(station|halt)$"]', '["amenity"="bus_station"]'] },
  { id: 'restrooms', label: 'Restrooms', icon: '🚻', color: '#64748b', photon: ['amenity:toilets'], filters: ['["amenity"="toilets"]'], allowUnnamed: true },
  { id: 'attractions', label: 'Things to do', icon: '🎡', color: '#c2410c', photon: ['tourism:attraction', 'tourism:museum', 'tourism:zoo', 'tourism:theme_park', 'tourism:gallery', 'tourism:viewpoint'], filters: ['["tourism"~"^(attraction|museum|zoo|theme_park|gallery|viewpoint)$"]'] },
  { id: 'post', label: 'Post office', icon: '📮', color: '#b91c1c', photon: ['amenity:post_office'], filters: ['["amenity"="post_office"]'] },
]

export const CATEGORY_BY_ID: Record<string, Category> = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]))

export type Wheelchair = 'yes' | 'limited' | 'no' | 'unknown'

export interface NearbyPlace {
  id: string
  category: string
  name: string
  coords: LngLat
  distance: number
  /** What kind of place, e.g. "Italian restaurant" or "Supermarket". */
  kind: string
  address?: string
  openingHours?: string
  phone?: string
  website?: string
  wheelchair: Wheelchair
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

export const MAX_RESULTS = 60

/** Overpass query for one category around a point. Exported for tests. */
export function buildNearbyQuery(cat: Category, [lng, lat]: LngLat, radius: number): string {
  const around = `(around:${Math.round(radius)},${lat.toFixed(6)},${lng.toFixed(6)})`
  const named = cat.allowUnnamed ? '' : '["name"]'
  const parts = cat.filters.map((f) => `  nwr${f}${named}${around};`).join('\n')
  return `[out:json][timeout:25];
(
${parts}
);
out center tags 300;`
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function describeKind(cat: Category, t: Record<string, string>): string {
  if (t.cuisine && (t.amenity === 'restaurant' || t.amenity === 'fast_food')) {
    const cuisine = t.cuisine.split(';')[0]
    return `${titleCase(cuisine)} ${t.amenity === 'fast_food' ? 'takeout' : 'restaurant'}`
  }
  const v = t.shop ?? t.tourism ?? t.leisure ?? t.railway ?? t.amenity
  if (!v) return cat.label
  const pretty: Record<string, string> = {
    fuel: 'Gas station', charging_station: 'EV charger', atm: 'ATM', bank: 'Bank', cafe: 'Café',
    toilets: 'Public restroom', fitness_centre: 'Gym', department_store: 'Department store',
    mall: 'Shopping mall', guest_house: 'Guest house', bus_station: 'Bus station', halt: 'Train stop',
    post_office: 'Post office', fast_food: 'Takeout', doityourself: 'DIY store', variety_store: 'Variety store',
    mobile_phone: 'Phone shop',
  }
  return pretty[v] ?? titleCase(v)
}

function fallbackName(cat: Category, t: Record<string, string>): string {
  if (t.brand) return t.brand
  if (t.operator) return t.operator
  return describeKind(cat, t)
}

function address(t: Record<string, string>): string | undefined {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ')
  const s = [street, t['addr:city']].filter(Boolean).join(', ')
  return s || undefined
}

/** Turn Overpass elements into nearby places, nearest first. Exported for tests. */
export function parseNearby(elements: OsmElement[], cat: Category, center: LngLat): NearbyPlace[] {
  const seen = new Set<string>()
  const out: NearbyPlace[] = []
  for (const el of elements) {
    const t = el.tags ?? {}
    const coords: LngLat | null =
      el.lat != null && el.lon != null ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null
    if (!coords) continue
    if (!t.name && !cat.allowUnnamed) continue
    // Parking lots and similar are often mapped as private; leave those out.
    if (t.access === 'private' || t.access === 'no') continue
    const name = t.name ?? fallbackName(cat, t)
    // The same shop is sometimes mapped both as a point and as a building outline.
    const dedupe = `${name}|${coords[0].toFixed(4)}|${coords[1].toFixed(4)}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const wc = t.wheelchair
    out.push({
      id: `${el.type}/${el.id}`,
      category: cat.id,
      name,
      coords,
      distance: distanceMeters(center, coords),
      kind: describeKind(cat, t),
      address: address(t),
      openingHours: t.opening_hours,
      phone: t.phone ?? t['contact:phone'],
      website: t.website ?? t['contact:website'],
      wheelchair: wc === 'yes' || wc === 'limited' || wc === 'no' ? wc : 'unknown',
    })
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, MAX_RESULTS)
}

/** fetch() that gives up after `ms`, and also stops when the caller aborts. */
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms)
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw e instanceof Error && e.name === 'AbortError' ? new Error(`Timed out: ${url}`) : e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    osm_type: 'N' | 'W' | 'R'
    osm_id: number
    osm_key: string
    osm_value: string
    name?: string
    housenumber?: string
    street?: string
    city?: string
  }
}

const PHOTON_TYPE = { N: 'node', W: 'way', R: 'relation' } as const

/** Turn Photon results into Overpass-style elements, filling in full tags from the OSM API when we have them. Exported for tests. */
export function photonToElements(features: PhotonFeature[], fullTags: Map<string, Record<string, string>>): OsmElement[] {
  return features.map((f) => {
    const p = f.properties
    const type = PHOTON_TYPE[p.osm_type]
    const basic: Record<string, string> = { [p.osm_key]: p.osm_value }
    if (p.name) basic.name = p.name
    if (p.housenumber) basic['addr:housenumber'] = p.housenumber
    if (p.street) basic['addr:street'] = p.street
    if (p.city) basic['addr:city'] = p.city
    const full = fullTags.get(`${type}/${p.osm_id}`)
    return {
      type, id: p.osm_id,
      lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      // Photon's address is often more complete (it fills in the city), so keep it under the full tags.
      tags: full ? { ...basic, ...full } : basic,
    }
  })
}

/** Read the full tags (hours, phone, wheelchair...) for up to a few dozen places from the OSM API. */
async function fetchFullTags(features: PhotonFeature[], signal?: AbortSignal): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>()
  const groups: Record<'nodes' | 'ways' | 'relations', number[]> = { nodes: [], ways: [], relations: [] }
  for (const f of features) {
    const t = f.properties.osm_type
    groups[t === 'N' ? 'nodes' : t === 'W' ? 'ways' : 'relations'].push(f.properties.osm_id)
  }
  await Promise.all(Object.entries(groups).filter(([, ids]) => ids.length).map(async ([kind, ids]) => {
    try {
      const res = await fetchWithTimeout(`${OSM_API_URL}/${kind}.json?${kind}=${ids.join(',')}`, {}, 8000, signal)
      if (!res.ok) return
      const data = (await res.json()) as { elements: { type: string; id: number; tags?: Record<string, string> }[] }
      for (const el of data.elements) if (el.tags) out.set(`${el.type}/${el.id}`, el.tags)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      // Details are a bonus: without them we still show names and addresses.
    }
  }))
  return out
}

/** Fast path: Photon finds the nearest places of the category, then the OSM API adds their details. */
async function fetchNearbyPhoton(cat: Category, center: LngLat, radius: number, signal?: AbortSignal): Promise<NearbyPlace[]> {
  const params = new URLSearchParams({
    lat: center[1].toFixed(6), lon: center[0].toFixed(6),
    radius: String(Math.min(radius / 1000, 50)), limit: '50', lang: 'en',
  })
  for (const t of cat.photon) params.append('osm_tag', t)
  const res = await fetchWithTimeout(`${PHOTON_REVERSE_URL}?${params}`, {}, 10000, signal)
  if (!res.ok) throw new Error(`Places failed to load (${res.status})`)
  const features = ((await res.json()) as { features: PhotonFeature[] }).features ?? []
  const fullTags = await fetchFullTags(features, signal)
  return parseNearby(photonToElements(features, fullTags), cat, center).filter((p) => p.distance <= radius * 1.05)
}

/** Backup path: ask Overpass servers directly, one after another. */
async function fetchNearbyOverpass(cat: Category, center: LngLat, radius: number, signal?: AbortSignal): Promise<NearbyPlace[]> {
  const body = new URLSearchParams({ data: buildNearbyQuery(cat, center, radius) })
  let lastError: unknown = null
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', body }, 12000, signal)
      if (!res.ok) throw new Error(`Places failed to load (${res.status})`)
      const data = (await res.json()) as { elements: OsmElement[] }
      return parseNearby(data.elements, cat, center)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Places failed to load')
}

/** Find places of one category near a point, trying the fast source first and Overpass if it fails. */
export async function fetchNearby(cat: Category, center: LngLat, radius: number, signal?: AbortSignal): Promise<NearbyPlace[]> {
  try {
    return await fetchNearbyPhoton(cat, center, radius, signal)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    return fetchNearbyOverpass(cat, center, radius, signal)
  }
}
