import { GEOCODER_URL, PHOTON_REVERSE_URL, PILOT_CITY } from '../config'
import { distanceMeters } from './geo'
import { matchKind, photonPlace, searchNearbyKind, searchNearbyTagged } from './search'
import { AnswerCache, fetchJson, nominatimSearch } from './sources'
import type { LngLat, Place } from './types'

export interface SearchResults {
  /** Set when the search names a kind of place ("hardware", "badminton"). */
  kind: { label: string; icon: string; tagged: boolean } | null
  /** Nearby results first (nearest first), then any "far" ones. */
  places: Place[]
}

/** Beyond this, a name match is "farther away" (about 50 miles). */
const NEAR_LIMIT_M = 80_000
const MIN_LOCAL = 3

type PhotonFeature = Parameters<typeof photonPlace>[0]

/** Box of about ±`deg` latitude around a point (wider in longitude away from the equator). */
function bbox([lon, lat]: LngLat, deg: number): string {
  const dLon = deg / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  return [lon - dLon, lat - deg, lon + dLon, lat + deg].map((x) => x.toFixed(4)).join(',')
}

async function photon(q: string, center: LngLat, extra: string, signal?: AbortSignal): Promise<PhotonFeature[]> {
  const url = `${GEOCODER_URL}?q=${encodeURIComponent(q)}&lang=en&lat=${center[1]}&lon=${center[0]}${extra}`
  return (await fetchJson<{ features?: PhotonFeature[] }>(url, {}, { timeout: 7000, tries: 2, signal })).features ?? []
}

/**
 * Text search: Photon first (retrying once if it's busy), then Nominatim if Photon is down.
 * `box` keeps results inside an area; without it the whole world is searched.
 */
async function textSearch(q: string, center: LngLat, box: string | null, limit: number, signal?: AbortSignal, extra = ''): Promise<Place[]> {
  try {
    const fs = await photon(q, center, `&limit=${limit}${box ? `&bbox=${box}` : ''}${extra}`, signal)
    return fs.map((f) => photonPlace(f, center))
  } catch (e) {
    if (signal?.aborted) throw e
    return nominatimSearch(q, center, box, Math.min(limit, 15), signal)
  }
}

const key = (p: Place) => `${p.name}|${p.coords[0].toFixed(4)},${p.coords[1].toFixed(4)}`
/** A failed source counts as "no results" (and is noted in `failed`), never as a broken search. */
function quietly(failed: { n: number }) {
  return <T,>(p: Promise<T[]>): Promise<T[]> => p.catch((e) => {
    if (e?.name === 'AbortError') throw e
    failed.n++
    return []
  })
}

/** Thrown only when every search source is unreachable and there's nothing saved to show. */
export class SearchOfflineError extends Error {
  constructor() { super('Search sources are unreachable'); this.name = 'SearchOfflineError' }
}

const answers = new AnswerCache<SearchResults>()

/** Search places, nearest to you first. */
export async function searchPlaces(query: string, signal?: AbortSignal, near?: LngLat): Promise<Place[]> {
  return (await searchAll(query, signal, near)).places
}

/**
 * Search like a maps app. Everything starts from where you are:
 * 1. places of the kind you typed (badminton courts, sushi, hardware stores) around you,
 * 2. anything whose name or address matches, inside about 25 miles, nearest first,
 * 3. only if that finds little, a wider area, and last, famous matches far away, labeled as such.
 */
export async function searchAll(query: string, signal?: AbortSignal, near?: LngLat, withTagged = false): Promise<SearchResults> {
  const q = query.trim()
  if (q.length < 2) return { kind: null, places: [] }
  const center = near ?? PILOT_CITY.center
  // Same words from about the same spot (within ~1 km) reuse the answer for 10 minutes.
  const cacheKey = `${q.toLowerCase()}|${center[0].toFixed(2)},${center[1].toFixed(2)}|${withTagged}`
  const cached = answers.get(cacheKey)
  if (cached) return cached
  try {
    const result = await searchFresh(q, center, signal, withTagged)
    if (result.places.length || !result.offline) answers.set(cacheKey, result)
    if (result.offline && !result.places.length) {
      const old = answers.stale(cacheKey)
      if (old) return old
      throw new SearchOfflineError()
    }
    return result
  } catch (e) {
    if (e instanceof SearchOfflineError || signal?.aborted) throw e
    const old = answers.stale(cacheKey)
    if (old) return old
    throw e
  }
}

async function searchFresh(q: string, center: LngLat, signal: AbortSignal | undefined, withTagged: boolean): Promise<SearchResults & { offline?: boolean }> {
  const kind = matchKind(q)
  const dist = (p: Place) => distanceMeters(center, p.coords)
  const byDistance = (a: Place, b: Place) => dist(a) - dist(b)
  const failed = { n: 0 }
  const quiet = quietly(failed)

  const [tagged, ofKind, local, anywhere] = await Promise.all([
    // Tag lookups can take many seconds, so callers ask for them in a second pass.
    kind && withTagged ? quiet(searchNearbyTagged(kind, center, signal)) : Promise.resolve([] as Place[]),
    kind ? quiet(searchNearbyKind(kind, center, signal)) : Promise.resolve([] as Place[]),
    quiet(textSearch(q, center, bbox(center, 0.35), 25, signal)),
    quiet(textSearch(q, center, null, 10, signal, '&zoom=12&location_bias_scale=0.1')),
  ])
  const sources = 2 + (kind ? 1 : 0) + (kind && withTagged ? 1 : 0)
  const offline = failed.n >= sources

  const seen = new Set<string>()
  const take = (ps: Place[]) => ps.filter((p) => { const k = key(p); if (seen.has(k)) return false; seen.add(k); return true })
  // Exactly what you asked for (e.g. courts tagged badminton) first, then name matches and the
  // wider kind (sports centres), all nearest first.
  // Places named what you typed ("Walmart", "Sushi Palace") beat generic places of the kind.
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  const named = (p: Place) => words.length > 0 && words.every((w) => p.name.toLowerCase().includes(w))
  const localNamed = local.filter((p) => named(p) && dist(p) <= NEAR_LIMIT_M)
  let near1 = [
    ...take([...tagged].sort(byDistance)),
    ...take([...localNamed].sort(byDistance)),
    ...take([...local, ...ofKind].sort(byDistance)),
  ]

  if (near1.length < MIN_LOCAL) {
    const wider = offline ? [] : await quiet(textSearch(q, center, bbox(center, 1.2), 15, signal))
    near1 = [...near1, ...take([...wider].sort(byDistance))]
  }
  const close = near1.filter((p) => dist(p) <= NEAR_LIMIT_M * 1.5)
  const nearbyAnywhere = take(anywhere.filter((p) => dist(p) <= NEAR_LIMIT_M))
  // A name that only exists far away ("Yosemite National Park" typed in India) goes first, so
  // loose nearby matches ("Nanda Devi National Park") don't hide it. Not for kinds like "coffee".
  // Same for an exact name ("Paris" typed in California, where only "Paris Lake" is near).
  const exact = (p: Place) => p.name.toLowerCase() === q.toLowerCase()
  const nearby = [...close, ...nearbyAnywhere]
  const namedNear = nearby.some(named)
  const exactNear = nearby.some(exact)
  const farNamed = kind ? []
    : take(anywhere.filter((p) => dist(p) > NEAR_LIMIT_M && ((!namedNear && named(p)) || (!exactNear && exact(p)))))
      .slice(0, 3).map((p) => ({ ...p, far: true }))
  // Far-away name matches ("Badminton, England") only when little is nearby, and labeled.
  const far = close.length + nearbyAnywhere.length >= MIN_LOCAL ? []
    : take(anywhere.filter((p) => dist(p) > NEAR_LIMIT_M)).map((p) => ({ ...p, far: true }))

  const places = [...farNamed, ...close, ...nearbyAnywhere.sort(byDistance)].slice(0, 12).concat(far.slice(0, 4))
  return { kind: kind ? { label: kind.label, icon: kind.icon, tagged: !!(kind.sport || kind.cuisine) } : null, places, offline }
}

/** The address or place name at a point, for a pin dropped on the map. */
export async function reverseGeocode(c: LngLat, signal?: AbortSignal): Promise<Place | null> {
  const res = await fetch(`${PHOTON_REVERSE_URL}?lat=${c[1].toFixed(6)}&lon=${c[0].toFixed(6)}&limit=1&lang=en`, { signal })
  if (!res.ok) return null
  const f = ((await res.json()) as { features: PhotonFeature[] }).features?.[0]
  if (!f || distanceMeters(c, f.geometry.coordinates) > 150) return null
  const p = f.properties
  const street = [p.housenumber, p.street].filter(Boolean).join(' ')
  // A business name only fits when the pin is right on it; otherwise "Pressed" (a nearby shop)
  // reads like a bug, so name the spot by its street instead.
  const onPlace = !!p.name && distanceMeters(c, f.geometry.coordinates) <= 40
  const name = (onPlace ? p.name : street) || p.name || street
  if (!name) return null
  const detail = [name === p.name ? street : '', p.city, p.state].filter(Boolean).join(', ')
  // Keep the exact spot that was tapped; the address just names it.
  return { name, detail, coords: c }
}
