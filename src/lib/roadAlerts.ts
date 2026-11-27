import { bearingDeg } from './navigation'
import { distanceMeters } from './geo'
import { ROAD_REPORT_TYPES, sameDirection, sameRoad, type RoadReport } from './roadReports'
import type { LngLat, RouteResult } from './types'

/** A report lies on the route if it is this close to the route line (about a road's width plus GPS slack). */
export const ON_ROUTE_METERS = 30
/** How far ahead to warn: about a minute at highway speed, less in town. */
export function lookaheadMeters(speedMps: number | null): number {
  const s = speedMps ?? 13
  return Math.max(800, Math.min(2500, s * 75))
}

export interface RouteAlert {
  report: RoadReport
  /** Meters along the route from you to the report. */
  aheadMeters: number
}

interface Projected { along: number; away: number; seg: number }

/** Precomputed distances along the route, so matching every report on every GPS fix stays cheap. */
export function alongTable(line: LngLat[]): number[] {
  const out = [0]
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + distanceMeters(line[i - 1], line[i]))
  return out
}

/** Closest point on the route to p: distance along the route, distance away, and segment. */
export function projectOnLine(p: LngLat, line: LngLat[], along: number[], fromSeg = 0): Projected {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540
  let best: Projected = { along: 0, away: Infinity, seg: 0 }
  for (let i = Math.max(0, fromSeg); i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * ky
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * ky
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    const away = Math.hypot(ax + t * dx, ay + t * dy)
    if (away < best.away) best = { along: along[i] + t * (along[i + 1] - along[i]), away, seg: i }
  }
  return best
}

/** The road the route is on at a given distance along it, from the turn-by-turn steps. */
export function roadAt(route: RouteResult, stepAlong: number[], at: number): string | null {
  let road: string | null = null
  for (let i = 0; i < route.steps.length; i++) {
    if ((stepAlong[i] ?? Infinity) <= at + 1) road = route.steps[i].road ?? road
    else break
  }
  return road
}

/**
 * Reports that are ahead of you on your route and that apply to your side of the road.
 * - On the route line: within ON_ROUTE_METERS, so a report on a parallel road further away is skipped.
 * - Ahead: between you and the lookahead distance; ones you've passed don't count.
 * - Same direction: a report made while driving the other way (e.g. the opposite carriageway of a
 *   highway, close enough to the route line) is skipped by comparing headings.
 * - Same road: when both the report and the route know the road's name, they must match, which
 *   catches a frontage or service road running right next to the route.
 */
export function alertsAhead(
  route: RouteResult,
  here: LngLat,
  reports: RoadReport[],
  opts: { stepAlong: number[]; along?: number[]; speedMps?: number | null } = { stepAlong: [] },
): RouteAlert[] {
  const line = route.geometry
  if (line.length < 2 || reports.length === 0) return []
  const along = opts.along ?? alongTable(line)
  const me = projectOnLine(here, line, along)
  const reach = lookaheadMeters(opts.speedMps ?? null)
  const out: RouteAlert[] = []
  for (const r of reports) {
    // Quick skip for anything far away.
    if (distanceMeters(here, r.coords) > reach + 500) continue
    const p = projectOnLine(r.coords, line, along, Math.max(0, me.seg - 1))
    if (p.away > ON_ROUTE_METERS) continue
    const ahead = p.along - me.along
    if (ahead < -15 || ahead > reach) continue
    const routeHeading = bearingDeg(line[p.seg], line[Math.min(p.seg + 1, line.length - 1)])
    if (!sameDirection(r.heading, routeHeading)) continue
    if (!sameRoad(r.road, roadAt(route, opts.stepAlong, p.along))) continue
    out.push({ report: r, aheadMeters: Math.max(0, ahead) })
  }
  return out.sort((a, b) => a.aheadMeters - b.aheadMeters)
}

/** The sentence to show and say for an alert. */
export const alertText = (r: RoadReport) => ROAD_REPORT_TYPES[r.type].alert
