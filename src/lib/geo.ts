import type { LngLat } from './types'

const R = 6371000

/** Distance in meters between two points. */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Distance in meters from point p to the segment a-b (flat approximation, fine at city scale). */
export function distanceToSegment(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111320
  const ky = 110540
  const ax = (a[0] - p[0]) * kx
  const ay = (a[1] - p[1]) * ky
  const bx = (b[0] - p[0]) * kx
  const by = (b[1] - p[1]) * ky
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.sqrt(cx * cx + cy * cy)
}

/** Shortest distance in meters from point p to a polyline. */
export function distanceToLine(p: LngLat, line: LngLat[]): number {
  if (line.length === 0) return Infinity
  if (line.length === 1) return distanceMeters(p, line[0])
  let best = Infinity
  for (let i = 0; i < line.length - 1; i++) {
    best = Math.min(best, distanceToSegment(p, line[i], line[i + 1]))
  }
  return best
}

export function bboxOf(line: LngLat[], padDeg = 0.002): [number, number, number, number] {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const [lng, lat] of line) {
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
  }
  return [minLng - padDeg, minLat - padDeg, maxLng + padDeg, maxLat + padDeg]
}

export type DistanceUnits = 'km' | 'mi'

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.28084

// The app shows one unit system at a time; App sets it from the visitor's setting.
let units: DistanceUnits = 'km'
export function setDistanceUnits(u: DistanceUnits): void { units = u }
export function distanceUnits(): DistanceUnits { return units }

/** "350 m" / "2.9 km", or "500 ft" / "1.8 mi", like Google Maps. */
export function formatDistance(m: number, u: DistanceUnits = units): string {
  if (u === 'mi') {
    const mi = m / METERS_PER_MILE
    if (mi < 0.1) return `${Math.max(10, Math.round((m * FEET_PER_METER) / 10) * 10)} ft`
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`
  }
  if (m < 1000) return `${Math.max(1, Math.round(m / 10) * 10)} m`
  return m < 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`
}

/** Search radius choices in round numbers of the visitor's units (stored in meters). */
export function radiusChoices(u: DistanceUnits = units): { m: number; label: string }[] {
  return u === 'mi'
    ? [[0.25, '¼ mi'], [0.5, '½ mi'], [1, '1 mi'], [3, '3 mi'], [5, '5 mi'], [15, '15 mi']].map(([v, label]) => ({ m: Math.round((v as number) * METERS_PER_MILE), label: label as string }))
    : [[500, '500 m'], [1000, '1 km'], [2000, '2 km'], [5000, '5 km'], [10000, '10 km'], [25000, '25 km']].map(([m, label]) => ({ m: m as number, label: label as string }))
}

/** The closest radius choice to a distance, so switching units keeps a sensible search area. */
export function snapRadius(m: number, u: DistanceUnits = units): number {
  return radiusChoices(u).reduce((best, c) => (Math.abs(c.m - m) < Math.abs(best - m) ? c.m : best), radiusChoices(u)[0].m)
}

/** Miles in the US, UK, Liberia and Myanmar; kilometers elsewhere. */
export function detectUnits(timeZone?: string, languages: readonly string[] = []): DistanceUnits {
  if (timeZone) {
    if (/^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Nome|Adak|Boise|Detroit|Menominee|Metlakatla|Yakutat|Indiana\/.*|Kentucky\/.*|North_Dakota\/.*|Puerto_Rico)|Pacific\/(Honolulu|Guam)|Europe\/(London|Belfast)|Africa\/Monrovia|Asia\/(Yangon|Rangoon))$/.test(timeZone)) return 'mi'
    return 'km'
  }
  const region = languages[0]?.split('-')[1]?.toUpperCase()
  return region && ['US', 'GB', 'LR', 'MM'].includes(region) ? 'mi' : 'km'
}

export function browserUnits(): DistanceUnits {
  try {
    return detectUnits(Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages ?? [navigator.language])
  } catch {
    return 'km'
  }
}

export function formatDuration(s: number): string {
  const min = Math.round(s / 60)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}
