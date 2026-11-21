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

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

export function formatDuration(s: number): string {
  const min = Math.round(s / 60)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}
