import { OVERPASS_URLS, PHOTON_REVERSE_URL } from '../config'
import { CATEGORIES, fetchWithTimeout } from './places'
import { distanceMeters, formatDistance } from './geo'
import type { LngLat, Place } from './types'

/**
 * Kinds of places people type into a maps search box ("hardware", "coffee", "pharmacy"...),
 * with the OpenStreetMap tags that find them. Every "Near me" category is included too.
 */
export interface PlaceKind {
  label: string
  icon: string
  words: string[]
  tags: string[]
  /** OSM sport=* value: places where this sport is played (courts, clubs, halls). */
  sport?: string
  /** OSM cuisine=* pattern for food kinds (restaurants serving it). */
  cuisine?: string
}

const SPORTS_PLACES = ['leisure:sports_centre', 'leisure:sports_hall', 'leisure:fitness_centre', 'shop:sports']

const EXTRA_KINDS: PlaceKind[] = [
  { label: 'Badminton', icon: '🏸', words: ['badminton', 'badminton court', 'shuttle'], tags: SPORTS_PLACES, sport: 'badminton' },
  { label: 'Tennis', icon: '🎾', words: ['tennis', 'tennis court'], tags: ['leisure:sports_centre', 'shop:sports'], sport: 'tennis' },
  { label: 'Pickleball', icon: '🏓', words: ['pickleball'], tags: ['leisure:sports_centre'], sport: 'pickleball' },
  { label: 'Table tennis', icon: '🏓', words: ['table tennis', 'ping pong'], tags: ['leisure:sports_centre'], sport: 'table_tennis' },
  { label: 'Basketball', icon: '🏀', words: ['basketball', 'basketball court'], tags: ['leisure:sports_centre'], sport: 'basketball' },
  { label: 'Soccer', icon: '⚽', words: ['soccer', 'football field', 'soccer field'], tags: ['leisure:sports_centre'], sport: 'soccer' },
  { label: 'Cricket', icon: '🏏', words: ['cricket', 'cricket ground'], tags: ['leisure:sports_centre'], sport: 'cricket' },
  { label: 'Swimming', icon: '🏊', words: ['swimming', 'swimming pool', 'pool', 'swim'], tags: ['leisure:swimming_pool', 'leisure:sports_centre', 'leisure:water_park'], sport: 'swimming' },
  { label: 'Golf', icon: '⛳', words: ['golf', 'golf course', 'driving range'], tags: ['leisure:golf_course', 'golf:driving_range'], sport: 'golf' },
  { label: 'Bowling', icon: '🎳', words: ['bowling', 'bowling alley'], tags: ['leisure:bowling_alley'], sport: '10pin' },
  { label: 'Ice skating', icon: '⛸️', words: ['ice skating', 'ice rink', 'skating'], tags: ['leisure:ice_rink'], sport: 'ice_skating' },
  { label: 'Yoga', icon: '🧘', words: ['yoga', 'yoga studio'], tags: ['leisure:fitness_centre'], sport: 'yoga' },
  { label: 'Sushi', icon: '🍣', words: ['sushi', 'japanese food', 'japanese restaurant'], tags: [], cuisine: 'sushi|japanese' },
  { label: 'Pizza', icon: '🍕', words: ['pizza', 'pizzeria'], tags: [], cuisine: 'pizza' },
  { label: 'Indian food', icon: '🍛', words: ['indian food', 'indian restaurant', 'biryani', 'curry'], tags: [], cuisine: 'indian' },
  { label: 'Chinese food', icon: '🥡', words: ['chinese food', 'chinese restaurant'], tags: [], cuisine: 'chinese' },
  { label: 'Mexican food', icon: '🌮', words: ['mexican food', 'tacos', 'taco', 'mexican restaurant', 'burrito'], tags: [], cuisine: 'mexican' },
  { label: 'Thai food', icon: '🍜', words: ['thai food', 'thai restaurant'], tags: [], cuisine: 'thai' },
  { label: 'Hardware stores', icon: '🔨', words: ['hardware', 'home improvement', 'diy', 'tools', 'home depot', 'lowes'], tags: ['shop:hardware', 'shop:doityourself', 'shop:trade'] },
  { label: 'Bakeries', icon: '🥐', words: ['bakery', 'bakeries', 'bread', 'pastry'], tags: ['shop:bakery', 'shop:pastry'] },
  { label: 'Ice cream', icon: '🍦', words: ['ice cream', 'gelato', 'frozen yogurt'], tags: ['amenity:ice_cream'] },
  { label: 'Convenience stores', icon: '🏪', words: ['convenience', 'corner store', 'deli', 'bodega'], tags: ['shop:convenience'] },
  { label: 'Liquor stores', icon: '🍷', words: ['liquor', 'wine', 'alcohol', 'beer'], tags: ['shop:alcohol', 'shop:wine', 'shop:beverages'] },
  { label: 'Florists', icon: '💐', words: ['florist', 'flowers', 'flower shop'], tags: ['shop:florist'] },
  { label: 'Pet stores', icon: '🐾', words: ['pet store', 'pet shop', 'pets', 'pet supplies'], tags: ['shop:pet'] },
  { label: 'Vets', icon: '🐕', words: ['vet', 'veterinarian', 'animal hospital'], tags: ['amenity:veterinary'] },
  { label: 'Hair salons', icon: '💇', words: ['hair', 'salon', 'haircut', 'barber', 'barbershop'], tags: ['shop:hairdresser', 'shop:beauty'] },
  { label: 'Laundry', icon: '🧺', words: ['laundry', 'laundromat', 'dry cleaning', 'dry cleaner'], tags: ['shop:laundry', 'shop:dry_cleaning'] },
  { label: 'Car repair', icon: '🔧', words: ['car repair', 'mechanic', 'auto repair', 'tire', 'tyres', 'garage'], tags: ['shop:car_repair', 'shop:tyres'] },
  { label: 'Car wash', icon: '🧽', words: ['car wash'], tags: ['amenity:car_wash'] },
  { label: 'Doctors', icon: '🩺', words: ['doctor', 'clinic', 'urgent care', 'medical'], tags: ['amenity:doctors', 'amenity:clinic'] },
  { label: 'Dentists', icon: '🦷', words: ['dentist', 'dental'], tags: ['amenity:dentist'] },
  { label: 'Libraries', icon: '📚', words: ['library', 'libraries'], tags: ['amenity:library'] },
  { label: 'Bookstores', icon: '📖', words: ['bookstore', 'books', 'book shop'], tags: ['shop:books'] },
  { label: 'Electronics', icon: '💻', words: ['electronics', 'computer', 'phone store', 'mobile phone', 'best buy'], tags: ['shop:electronics', 'shop:computer', 'shop:mobile_phone'] },
  { label: 'Clothing stores', icon: '👕', words: ['clothes', 'clothing', 'apparel', 'fashion'], tags: ['shop:clothes', 'shop:boutique'] },
  { label: 'Shoe stores', icon: '👟', words: ['shoes', 'shoe store', 'sneakers'], tags: ['shop:shoes'] },
  { label: 'Furniture stores', icon: '🛋️', words: ['furniture', 'mattress', 'home goods'], tags: ['shop:furniture', 'shop:bed', 'shop:houseware'] },
  { label: 'Department stores', icon: '🏬', words: ['department store', 'target', 'walmart', 'costco'], tags: ['shop:department_store', 'shop:wholesale', 'shop:general'] },
  { label: 'Movie theaters', icon: '🎬', words: ['movies', 'movie theater', 'cinema', 'theater', 'theatre'], tags: ['amenity:cinema', 'amenity:theatre'] },
  { label: 'Schools', icon: '🏫', words: ['school', 'schools', 'college', 'university'], tags: ['amenity:school', 'amenity:college', 'amenity:university'] },
  { label: 'Places of worship', icon: '⛪', words: ['church', 'temple', 'mosque', 'synagogue', 'gurdwara', 'worship'], tags: ['amenity:place_of_worship'] },
  { label: 'Police', icon: '🚓', words: ['police', 'police station'], tags: ['amenity:police'] },
]

// The "Near me" categories, with the words people use for them.
const CATEGORY_WORDS: Record<string, string[]> = {
  restaurants: ['restaurant', 'restaurants', 'food', 'dinner', 'lunch', 'eat'],
  coffee: ['coffee', 'cafe', 'café', 'coffee shop', 'starbucks', 'dunkin'],
  'fast-food': ['takeout', 'fast food', 'burger', 'burgers', 'mcdonalds'],
  groceries: ['grocery', 'groceries', 'supermarket', 'food store'],
  malls: ['mall', 'malls', 'shopping center', 'shopping centre', 'outlet'],
  shops: ['shopping', 'shops', 'stores'],
  gas: ['gas', 'gas station', 'petrol', 'fuel'],
  ev: ['ev charging', 'charging station', 'ev charger', 'tesla supercharger'],
  pharmacy: ['pharmacy', 'pharmacies', 'drugstore', 'chemist', 'cvs', 'walgreens'],
  hospitals: ['hospital', 'hospitals', 'emergency', 'er'],
  atm: ['atm', 'bank', 'banks', 'cash'],
  hotels: ['hotel', 'hotels', 'motel', 'lodging', 'inn'],
  parking: ['parking', 'parking lot', 'garage parking'],
  bars: ['bar', 'bars', 'pub', 'pubs', 'nightlife'],
  parks: ['park', 'parks', 'playground'],
  gyms: ['gym', 'gyms', 'fitness'],
  transit: ['transit', 'train', 'train station', 'bus station', 'subway', 'station'],
  restrooms: ['restroom', 'restrooms', 'toilet', 'bathroom'],
  attractions: ['things to do', 'attractions', 'museum', 'zoo', 'tourist'],
  post: ['post office', 'mail', 'usps', 'post'],
}

export const PLACE_KINDS: PlaceKind[] = [
  ...EXTRA_KINDS,
  ...CATEGORIES.map((c) => ({ label: c.label, icon: c.icon, words: CATEGORY_WORDS[c.id] ?? [c.label.toLowerCase()], tags: c.photon })),
]

/** Edit distance with swaps counted as one change (so "hardwrae" is one typo away). */
export function typoDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** "hardware stores near me" -> "hardware". */
function core(query: string): string {
  return query.toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\b(near me|nearby|near by|around me|close by|open now|in my area)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s(stores?|shops?|places?)$/, '')
}

/** The kind of place a search is asking for, if any, allowing for small typos. Exported for tests. */
export function matchKind(query: string): PlaceKind | null {
  const q = core(query)
  if (q.length < 3) return null
  let best: { kind: PlaceKind; score: number } | null = null
  for (const kind of PLACE_KINDS) {
    for (const w of kind.words) {
      let score: number
      if (q === w || q === `${w}s` || `${q}s` === w) score = 0
      else if (q.length >= 4 && w.startsWith(q)) score = 0.5
      else {
        // Short words get no typo allowance, so "paris" doesn't turn into "parks".
        const allowed = w.length >= 8 ? 2 : w.length >= 6 ? 1 : 0
        const dist = typoDistance(q, w)
        if (dist > allowed) continue
        score = dist
      }
      if (!best || score < best.score) best = { kind, score }
    }
  }
  return best?.kind ?? null
}

interface PhotonFeature {
  geometry: { coordinates: LngLat }
  properties: { name?: string; street?: string; housenumber?: string; city?: string; district?: string; state?: string; osm_value?: string }
}

function placeFrom(f: PhotonFeature, from: LngLat | undefined, icon?: string): Place {
  const p = f.properties
  const street = [p.housenumber, p.street].filter(Boolean).join(' ')
  const name = p.name || street || 'Unnamed place'
  const where = [p.name ? street : '', p.district, p.city, p.state].filter(Boolean).join(', ')
  const away = from ? formatDistance(distanceMeters(from, f.geometry.coordinates)) : ''
  return { name, detail: [away, where].filter(Boolean).join(' · '), coords: f.geometry.coordinates, icon }
}

/** The nearest places of a kind (e.g. hardware stores), nearest first. */
export async function searchNearbyKind(kind: PlaceKind, center: LngLat, signal?: AbortSignal): Promise<Place[]> {
  if (!kind.tags.length) return []
  const params = new URLSearchParams({ lat: center[1].toFixed(6), lon: center[0].toFixed(6), radius: '30', limit: '8', lang: 'en' })
  for (const t of kind.tags) params.append('osm_tag', t)
  const res = await fetch(`${PHOTON_REVERSE_URL}?${params}`, { signal })
  if (!res.ok) throw new Error(`Search failed (${res.status})`)
  const features = ((await res.json()) as { features: PhotonFeature[] }).features ?? []
  return features.filter((f) => f.properties.name).map((f) => placeFrom(f, center, kind.icon))
}

export { placeFrom as photonPlace }

/**
 * Places where a sport is played, or restaurants serving a cuisine, near you, read straight
 * from OpenStreetMap tags (sport=badminton, cuisine=sushi). Overpass can be busy, so this gives
 * up quickly and the rest of the search still works without it.
 */
export async function searchNearbyTagged(kind: PlaceKind, center: LngLat, signal?: AbortSignal): Promise<Place[]> {
  const filter = kind.sport ? `["sport"~"(^|;)${kind.sport}($|;)"]` : kind.cuisine ? `["cuisine"~"(^|;)(${kind.cuisine})($|;)"]` : null
  if (!filter) return []
  const [lng, lat] = center
  const q = `[out:json][timeout:8];nwr${filter}(around:25000,${lat},${lng});out center tags 40;`
  for (const url of OVERPASS_URLS.slice(0, 2)) {
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', body: new URLSearchParams({ data: q }) }, 7000, signal)
      if (!res.ok) continue
      const data = (await res.json()) as { elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] }
      return data.elements.flatMap((el) => {
        const c = el.center ?? (el.lat != null && el.lon != null ? { lat: el.lat, lon: el.lon } : null)
        if (!c) return []
        const t = el.tags ?? {}
        const coords: LngLat = [c.lon, c.lat]
        const what = kind.sport ? (t.name ? '' : `${kind.label} ${t.leisure === 'pitch' ? 'court' : 'place'}`) : ''
        const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ')
        const where = [street, t['addr:city']].filter(Boolean).join(', ')
        return [{
          name: t.name || what || kind.label,
          detail: [formatDistance(distanceMeters(center, coords)), where].filter(Boolean).join(' · '),
          coords, icon: kind.icon,
        }]
      })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
    }
  }
  return []
}

