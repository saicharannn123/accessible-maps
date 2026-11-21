import { GEOCODER_URL, PILOT_CITY } from '../config'
import { matchKind, photonPlace, searchNearbyKind } from './search'
import type { LngLat, Place } from './types'

export interface SearchResults {
  /** Set when the search names a kind of place ("hardware"): the nearest ones come first. */
  kind: { label: string; icon: string } | null
  places: Place[]
}

/**
 * Search like a maps app: businesses, addresses and cities near you first, plus, when the words
 * name a kind of place ("hardware", "coffee", even misspelled), the nearest places of that kind.
 */
export async function searchPlaces(query: string, signal?: AbortSignal, near?: LngLat): Promise<Place[]> {
  return (await searchAll(query, signal, near)).places
}

export async function searchAll(query: string, signal?: AbortSignal, near?: LngLat): Promise<SearchResults> {
  const q = query.trim()
  if (q.length < 2) return { kind: null, places: [] }
  const center = near ?? PILOT_CITY.center
  const kind = matchKind(q)
  const [lon, lat] = center
  // zoom + location_bias_scale make Photon favor what's near you over famous places far away.
  const url = `${GEOCODER_URL}?q=${encodeURIComponent(q)}&limit=8&lang=en&lat=${lat}&lon=${lon}&zoom=12&location_bias_scale=0.1`
  const [byName, byKind] = await Promise.all([
    fetch(url, { signal }).then(async (res) => {
      if (!res.ok) throw new Error(`Search failed (${res.status})`)
      return ((await res.json()) as { features: Parameters<typeof photonPlace>[0][] }).features.map((f) => photonPlace(f, near))
    }),
    kind ? searchNearbyKind(kind, center, signal).catch((e) => { if (e?.name === 'AbortError') throw e; return [] as Place[] }) : Promise.resolve([] as Place[]),
  ])
  // When the words name a kind of place, nearby places of that kind beat far-away name matches.
  const seen = new Set(byKind.map((p) => p.name + p.coords.join()))
  const rest = byName.filter((p) => !seen.has(p.name + p.coords.join()))
  return { kind: kind && byKind.length ? { label: kind.label, icon: kind.icon } : null, places: [...byKind, ...rest].slice(0, 12) }
}
