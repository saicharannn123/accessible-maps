import { distanceMeters } from './geo'
import type { Place } from './types'

/**
 * Addresses and postal codes (US ZIP codes, Indian PIN codes, and everyone else's postcodes):
 * how they read in search results, which results are really the same address, and whether a
 * search is just a postal code.
 */

const US_STATES: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA',
  'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'Puerto Rico': 'PR',
}

/** What a postal code is called where it is used. */
export function postalCodeName(country?: string): string {
  const c = country?.toUpperCase()
  return c === 'US' || c === 'PR' ? 'ZIP code' : c === 'IN' ? 'PIN code' : 'Postal code'
}

/** One clean postal code from what the data has ("07039;07052" → "07039", " 400 001" → "400001" for India). */
export function cleanPostcode(raw: string | undefined, country?: string): string | undefined {
  const first = raw?.split(/[;,]/)[0]?.trim()
  if (!first) return undefined
  if (country?.toUpperCase() === 'IN') return first.replace(/\s+/g, '')
  return first.toUpperCase()
}

export interface AddressParts {
  city?: string
  state?: string
  postcode?: string
  country?: string
}

/**
 * "Livingston, NJ 07039" or "Mumbai, Maharashtra 400001": the town, the state and the postal
 * code, written the way that country writes them. Parts that are missing are left out.
 */
export function cityStatePostal({ city, state, postcode, country }: AddressParts): string {
  const us = country?.toUpperCase() === 'US'
  const st = state && us ? (US_STATES[state] ?? state) : state
  const tail = [st, postcode].filter(Boolean).join(' ')
  return [city, tail].filter(Boolean).join(', ')
}

/** What goes in the search bar once a place is chosen: "276 Mill Road, Livingston, NJ 07039". */
export function searchBarText(p: Place): string {
  if (!p.area) return p.name
  const area = p.area.startsWith(`${p.name},`) ? p.area.slice(p.name.length + 1).trim() : p.area
  return area && area !== p.name ? `${p.name}, ${area}` : p.name
}

/**
 * The postal code a search is made of, if that is all it is: US ZIP ("07039", "07039-1234"),
 * Indian PIN ("400001", "400 001"), Canadian ("M5V 3L9") and UK ("SW1A 1AA") codes.
 */
export function postalQuery(q: string): string | null {
  const s = q.trim().replace(/^(zip|pin|postal|post)\s*(code)?\s*[:#]?\s*/i, '')
  if (/^\d{5}(-\d{4})?$/.test(s)) return s
  if (/^\d{3}\s?\d{3}$/.test(s)) return s.replace(/\s/, '')
  if (/^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/.test(s)) return s.toUpperCase()
  if (/^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/.test(s)) return s.toUpperCase()
  return null
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase()
  .replace(/\b(road)\b/g, 'rd').replace(/\b(street)\b/g, 'st').replace(/\b(avenue)\b/g, 'ave')
  .replace(/\b(drive)\b/g, 'dr').replace(/\b(lane)\b/g, 'ln').replace(/\b(boulevard)\b/g, 'blvd')
  .replace(/[^a-z0-9]+/g, ' ').trim()

/** Two results this close with the same name and address are one place (a house point and its building outline). */
const SAME_SPOT_M = 150

/** Do two results name the same address at the same place? */
export function sameAddress(a: Place, b: Place): boolean {
  if (a.osm && a.osm === b.osm) return true
  if (norm(a.name) !== norm(b.name)) return false
  // A known postal code or town that differs means a different address, however close.
  if (a.postcode && b.postcode && a.postcode !== b.postcode) return false
  if (a.street && b.street && norm(a.street) !== norm(b.street)) return false
  return distanceMeters(a.coords, b.coords) <= SAME_SPOT_M
}

/** How much a result tells you, so the fuller of two duplicates is kept. */
const fullness = (p: Place) => (p.postcode ? 2 : 0) + (p.area ? 1 : 0) + (p.osm ? 1 : 0) + (p.photo ? 1 : 0)

/**
 * Merge results that are the same address at the same spot, keeping the fullest one in the
 * place of the first. Distinct places with the same name stay, and any that would still read
 * the same get the county or the coordinates added so they're easy to tell apart.
 */
export function mergeSameAddresses(places: Place[]): Place[] {
  const out: Place[] = []
  for (const p of places) {
    const i = out.findIndex((q) => sameAddress(q, p))
    if (i < 0) out.push(p)
    else if (fullness(p) > fullness(out[i])) out[i] = { ...p, far: out[i].far }
  }
  const where = (p: Place) => p.detail.replace(/^[\d.,]+\s?(mi|km|ft|m)(\s·\s|$)/, '')
  return out.map((p) => {
    const twins = out.filter((q) => q !== p && norm(q.name) === norm(p.name) && where(q) === where(p))
    if (!twins.length) return p
    // The county if that settles it; otherwise, only when even the distance is the same, the coordinates.
    const extra = p.county && twins.every((q) => q.county !== p.county) ? p.county
      : twins.some((q) => q.detail === p.detail) ? `${p.coords[1].toFixed(3)}, ${p.coords[0].toFixed(3)}` : ''
    return extra ? { ...p, detail: [p.detail, extra].filter(Boolean).join(' · ') } : p
  })
}
