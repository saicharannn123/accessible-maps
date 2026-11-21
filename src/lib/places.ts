import { OVERPASS_URLS } from '../config'
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
  /** Unnamed places (e.g. a car park) are still useful for some categories. */
  allowUnnamed?: boolean
}

const SHOP_TYPES = 'clothes|shoes|electronics|mobile_phone|books|gift|jewelry|sports|furniture|hardware|doityourself|beauty|cosmetics|variety_store|toys|optician|computer|bag|boutique|houseware|stationery'

export const CATEGORIES: Category[] = [
  { id: 'restaurants', label: 'Restaurants', icon: '🍽️', color: '#ea580c', filters: ['["amenity"="restaurant"]'] },
  { id: 'coffee', label: 'Coffee', icon: '☕', color: '#92400e', filters: ['["amenity"="cafe"]'] },
  { id: 'fast-food', label: 'Takeout', icon: '🍔', color: '#dc2626', filters: ['["amenity"="fast_food"]'] },
  { id: 'groceries', label: 'Groceries', icon: '🛒', color: '#16a34a', filters: ['["shop"~"^(supermarket|convenience|greengrocer|grocery)$"]'] },
  { id: 'malls', label: 'Malls', icon: '🏬', color: '#7c3aed', filters: ['["shop"~"^(mall|department_store)$"]'] },
  { id: 'shops', label: 'Shopping', icon: '🛍️', color: '#db2777', filters: [`["shop"~"^(${SHOP_TYPES})$"]`] },
  { id: 'gas', label: 'Gas', icon: '⛽', color: '#0f766e', filters: ['["amenity"="fuel"]'], allowUnnamed: true },
  { id: 'ev', label: 'EV charging', icon: '🔌', color: '#059669', filters: ['["amenity"="charging_station"]'], allowUnnamed: true },
  { id: 'pharmacy', label: 'Pharmacies', icon: '💊', color: '#0891b2', filters: ['["amenity"="pharmacy"]', '["shop"="chemist"]'] },
  { id: 'hospitals', label: 'Hospitals', icon: '🏥', color: '#be123c', filters: ['["amenity"~"^(hospital|clinic)$"]'] },
  { id: 'atm', label: 'ATMs & banks', icon: '🏧', color: '#1d4ed8', filters: ['["amenity"~"^(atm|bank)$"]'], allowUnnamed: true },
  { id: 'hotels', label: 'Hotels', icon: '🏨', color: '#4338ca', filters: ['["tourism"~"^(hotel|motel|guest_house|hostel)$"]'] },
  { id: 'parking', label: 'Parking', icon: '🅿️', color: '#2563eb', filters: ['["amenity"="parking"]'], allowUnnamed: true },
  { id: 'bars', label: 'Bars', icon: '🍸', color: '#9333ea', filters: ['["amenity"~"^(bar|pub)$"]'] },
  { id: 'parks', label: 'Parks', icon: '🌳', color: '#15803d', filters: ['["leisure"="park"]'] },
  { id: 'gyms', label: 'Gyms', icon: '🏋️', color: '#475569', filters: ['["leisure"="fitness_centre"]'] },
  { id: 'transit', label: 'Transit', icon: '🚉', color: '#0369a1', filters: ['["railway"~"^(station|halt)$"]', '["amenity"="bus_station"]'] },
  { id: 'restrooms', label: 'Restrooms', icon: '🚻', color: '#64748b', filters: ['["amenity"="toilets"]'], allowUnnamed: true },
  { id: 'attractions', label: 'Things to do', icon: '🎡', color: '#c2410c', filters: ['["tourism"~"^(attraction|museum|zoo|theme_park|gallery|viewpoint)$"]'] },
  { id: 'post', label: 'Post office', icon: '📮', color: '#b91c1c', filters: ['["amenity"="post_office"]'] },
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

interface OsmElement {
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

/** Find places of one category near a point. Tries a backup server if the main one is busy. */
export async function fetchNearby(cat: Category, center: LngLat, radius: number, signal?: AbortSignal): Promise<NearbyPlace[]> {
  const body = new URLSearchParams({ data: buildNearbyQuery(cat, center, radius) })
  let lastError: unknown = null
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', body, signal })
      if (!res.ok) throw new Error(`Places failed to load (${res.status})`)
      const data = (await res.json()) as { elements: OsmElement[] }
      return parseNearby(data.elements, cat, center)
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Places failed to load')
}
