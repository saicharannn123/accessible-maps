import { OVERPASS_URL } from '../config'
import type { LngLat } from './types'

export interface Restroom {
  id: string
  coords: LngLat
  name: string
  wheelchair: 'yes' | 'limited' | 'no' | 'unknown'
  fee: 'free' | 'paid' | 'unknown'
  changingTable: boolean
  openingHours?: string
}

export interface LitWay {
  id: string
  lit: boolean
  line: LngLat[]
}

export interface Obstacle {
  id: string
  kind: 'steps' | 'raised-kerb' | 'elevator'
  coords: LngLat
  line?: LngLat[]
}

export interface AccessData {
  restrooms: Restroom[]
  lighting: LitWay[]
  obstacles: Obstacle[]
}

interface OsmElement {
  type: 'node' | 'way'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  geometry?: { lat: number; lon: number }[]
  tags?: Record<string, string>
}

type BBox = [number, number, number, number] // west, south, east, north

/** Build the Overpass query for one map area. Exported for tests. */
export function buildQuery([w, s, e, n]: BBox): string {
  const b = `(${s},${w},${n},${e})`
  return `[out:json][timeout:25];
(
  node["amenity"="toilets"]${b};
  way["amenity"="toilets"]${b};
  way["highway"]["lit"~"^(yes|no)$"]${b};
  way["highway"="steps"]${b};
  node["kerb"="raised"]${b};
  node["highway"="elevator"]${b};
);
out geom center;`
}

/** Turn raw Overpass elements into the layers the app draws. Exported for tests. */
export function parseElements(elements: OsmElement[]): AccessData {
  const restrooms: Restroom[] = []
  const lighting: LitWay[] = []
  const obstacles: Obstacle[] = []

  for (const el of elements) {
    const t = el.tags ?? {}
    const id = `${el.type}/${el.id}`
    const point: LngLat | null =
      el.lat != null && el.lon != null
        ? [el.lon, el.lat]
        : el.center
          ? [el.center.lon, el.center.lat]
          : el.geometry?.length
            ? [el.geometry[0].lon, el.geometry[0].lat]
            : null
    const line: LngLat[] | undefined = el.geometry?.map((g) => [g.lon, g.lat])

    if (t.amenity === 'toilets' && point) {
      const wc = t.wheelchair
      restrooms.push({
        id,
        coords: point,
        name: t.name || 'Public restroom',
        wheelchair: wc === 'yes' || wc === 'limited' || wc === 'no' ? wc : 'unknown',
        fee: t.fee === 'no' ? 'free' : t.fee === 'yes' ? 'paid' : 'unknown',
        changingTable: t.changing_table === 'yes',
        openingHours: t.opening_hours,
      })
    } else if (t.highway === 'steps' && point) {
      obstacles.push({ id, kind: 'steps', coords: point, line })
    } else if (t.kerb === 'raised' && point) {
      obstacles.push({ id, kind: 'raised-kerb', coords: point })
    } else if (t.highway === 'elevator' && point) {
      obstacles.push({ id, kind: 'elevator', coords: point })
    }

    // A footway can be both steps and lit/unlit, so lighting is checked separately.
    if (t.highway && (t.lit === 'yes' || t.lit === 'no') && line && line.length > 1) {
      lighting.push({ id, lit: t.lit === 'yes', line })
    }
  }
  return { restrooms, lighting, obstacles }
}

export async function fetchAccessData(bbox: BBox, signal?: AbortSignal): Promise<AccessData> {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: buildQuery(bbox) }),
    signal,
  })
  if (!res.ok) throw new Error(`Map details failed to load (${res.status})`)
  const data = (await res.json()) as { elements: OsmElement[] }
  return parseElements(data.elements)
}
