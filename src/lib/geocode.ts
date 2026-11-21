import { GEOCODER_URL, PILOT_CITY } from '../config'
import type { Place } from './types'

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    name?: string
    street?: string
    housenumber?: string
    city?: string
    district?: string
    state?: string
    country?: string
  }
}

/** Search places, biased toward the pilot city. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const [lon, lat] = PILOT_CITY.center
  const url = `${GEOCODER_URL}?q=${encodeURIComponent(q)}&limit=6&lat=${lat}&lon=${lon}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Search failed (${res.status})`)
  const data = (await res.json()) as { features: PhotonFeature[] }
  return data.features.map((f) => {
    const p = f.properties
    const street = [p.housenumber, p.street].filter(Boolean).join(' ')
    const name = p.name || street || 'Unnamed place'
    const detail = [p.name ? street : '', p.district, p.city, p.state]
      .filter(Boolean)
      .join(', ')
    return { name, detail, coords: f.geometry.coordinates }
  })
}
