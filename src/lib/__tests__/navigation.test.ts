import { describe, expect, it } from 'vitest'
import { bearingDeg, navProgress, stepPositions } from '../navigation'
import type { LngLat, RouteResult } from '../types'

// An L-shaped route: about 220 m north, then about 170 m east.
const a: LngLat = [-74.3, 40.78], b: LngLat = [-74.3, 40.782], c: LngLat = [-74.298, 40.782]
const route: RouteResult = {
  geometry: [a, [-74.3, 40.781], b, [-74.299, 40.782], c],
  distanceMeters: 390, durationSeconds: 300, stepFreeVerified: false, warnings: [],
  steps: [
    { text: 'Head out', distanceMeters: 220, coords: a, icon: '●' },
    { text: 'Turn right onto Oak Street', distanceMeters: 170, coords: b, icon: '↱' },
    { text: 'Arrive at your destination', distanceMeters: 0, coords: c, icon: '⚑' },
  ],
}

describe('navigation', () => {
  it('points the way', () => {
    expect(Math.round(bearingDeg(a, b))).toBe(0)
    expect(Math.round(bearingDeg(b, c))).toBe(90)
  })
  it('places each step along the route', () => {
    const at = stepPositions(route)
    expect(at[0]).toBe(0)
    expect(at[1]).toBeGreaterThan(215)
    expect(at[1]).toBeLessThan(230)
  })
  it('counts down to the next turn and moves on after it', () => {
    const start = navProgress(route, [-74.3, 40.7805])
    expect(start.nextStep).toBe(1)
    expect(start.toNextMeters).toBeGreaterThan(150)
    expect(start.offRouteMeters).toBeLessThan(1)
    expect(Math.round(start.bearing)).toBe(0)
    const afterTurn = navProgress(route, [-74.2995, 40.782])
    expect(afterTurn.nextStep).toBe(2)
    expect(afterTurn.arrived).toBe(false)
    expect(navProgress(route, [-74.29805, 40.782]).arrived).toBe(true)
  })
  it('notices when you leave the route', () => {
    expect(navProgress(route, [-74.3015, 40.781]).offRouteMeters).toBeGreaterThan(100)
  })
})
