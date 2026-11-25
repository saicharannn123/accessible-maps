import { distanceMeters } from './geo'
import type { LngLat, RouteResult } from './types'

/** Where the traveler is along a route, worked out from their live position. */
export interface NavProgress {
  /** Index into route.steps of the next instruction to follow. */
  nextStep: number
  /** Meters until that instruction. */
  toNextMeters: number
  /** Meters left to the destination along the route. */
  remainingMeters: number
  /** How far the traveler is from the route line. */
  offRouteMeters: number
  /** Compass bearing of the route ahead, for pointing the map the way you're going. */
  bearing: number
  arrived: boolean
}

/** Bearing from a to b in degrees, 0 = north. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const r = Math.PI / 180
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r)
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r)
  return (Math.atan2(y, x) / r + 360) % 360
}

/** Cumulative distance along the line at each vertex. */
function alongDistances(line: LngLat[]): number[] {
  const out = [0]
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + distanceMeters(line[i - 1], line[i]))
  return out
}

/** Closest point on the line: its distance along the line, distance away, and segment index. */
function project(p: LngLat, line: LngLat[], along: number[]): { along: number; away: number; seg: number } {
  // Flat-earth math in meters around p is plenty for street-scale distances.
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540
  let best = { along: 0, away: Infinity, seg: 0 }
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * ky
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * ky
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    const away = Math.hypot(ax + t * dx, ay + t * dy)
    if (away < best.away) best = { along: along[i] + t * (along[i + 1] - along[i]), away, seg: i }
  }
  if (line.length === 1) best = { along: 0, away: distanceMeters(p, line[0]), seg: 0 }
  return best
}

/** Distance along the route at which each step's maneuver happens. */
export function stepPositions(route: RouteResult): number[] {
  const along = alongDistances(route.geometry)
  let from = 0
  return route.steps.map((s) => {
    // Steps come in order, so search forward from the previous one; a route that loops back on
    // itself would otherwise match a later turn to an earlier spot.
    let bestI = from, bestD = Infinity
    for (let i = from; i < route.geometry.length; i++) {
      const d = distanceMeters(s.coords, route.geometry[i])
      if (d < bestD) { bestD = d; bestI = i }
      if (d < 1) break
    }
    from = bestI
    return along[bestI]
  })
}

export function navProgress(route: RouteResult, at: LngLat, stepAlong = stepPositions(route)): NavProgress {
  const line = route.geometry
  const along = alongDistances(line)
  const total = along[along.length - 1] ?? 0
  const here = project(at, line, along)
  // The next instruction is the first maneuver still ahead (with a few meters of slack, so a
  // step counts as done once you're at the corner).
  let next = stepAlong.findIndex((a, i) => i > 0 && a > here.along + 8)
  if (next < 0) next = Math.max(route.steps.length - 1, 0)
  const ahead = line[Math.min(here.seg + 1, line.length - 1)]
  const behind = line[here.seg]
  return {
    nextStep: next,
    toNextMeters: Math.max(0, (stepAlong[next] ?? total) - here.along),
    remainingMeters: Math.max(0, total - here.along),
    offRouteMeters: here.away,
    bearing: line.length > 1 ? bearingDeg(behind, ahead) : 0,
    arrived: line.length > 0 && distanceMeters(at, line[line.length - 1]) < 25,
  }
}
