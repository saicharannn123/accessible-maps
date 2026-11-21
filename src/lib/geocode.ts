import { GEOCODER_URL, PILOT_CITY } from '../config'
import { distanceMeters } from './geo'
import { matchKind, photonPlace, searchNearbyKind, searchNearbyTagged } from './search'
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
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Search failed (${res.status})`)
  return ((await res.json()) as { features: PhotonFeature[] }).features ?? []
}

const key = (p: Place) => `${p.name}|${p.coords[0].toFixed(4)},${p.coords[1].toFixed(4)}`
const quiet = <T,>(p: Promise<T[]>): Promise<T[]> => p.catch((e) => { if (e?.name === 'AbortError') throw e; return [] })

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
  const kind = matchKind(q)
  const dist = (p: Place) => distanceMeters(center, p.coords)
  const byDistance = (a: Place, b: Place) => dist(a) - dist(b)

  const [tagged, ofKind, local, anywhere] = await Promise.all([
    // Tag lookups (Overpass) can take many seconds, so callers ask for them in a second pass.
    kind && withTagged ? quiet(searchNearbyTagged(kind, center, signal)) : Promise.resolve([] as Place[]),
    kind ? quiet(searchNearbyKind(kind, center, signal)) : Promise.resolve([] as Place[]),
    photon(q, center, `&limit=25&bbox=${bbox(center, 0.35)}`, signal).then((fs) => fs.map((f) => photonPlace(f, center))),
    quiet(photon(q, center, '&limit=10&zoom=12&location_bias_scale=0.1', signal).then((fs) => fs.map((f) => photonPlace(f, center)))),
  ])

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
    const wider = await quiet(photon(q, center, `&limit=15&bbox=${bbox(center, 1.2)}`, signal))
    near1 = [...near1, ...take(wider.map((f) => photonPlace(f, center)).sort(byDistance))]
  }
  const close = near1.filter((p) => dist(p) <= NEAR_LIMIT_M * 1.5)
  const nearbyAnywhere = take(anywhere.filter((p) => dist(p) <= NEAR_LIMIT_M))
  // Far-away name matches ("Badminton, England") only when little is nearby, and labeled.
  const far = close.length + nearbyAnywhere.length >= MIN_LOCAL ? []
    : take(anywhere.filter((p) => dist(p) > NEAR_LIMIT_M)).map((p) => ({ ...p, far: true }))

  const places = [...close, ...nearbyAnywhere.sort(byDistance)].slice(0, 12).concat(far.slice(0, 4))
  return { kind: kind ? { label: kind.label, icon: kind.icon, tagged: !!(kind.sport || kind.cuisine) } : null, places }
}
