import { describe, expect, it } from 'vitest'
import { cellBox, cellsFor, parseSignals } from '../signals'

describe('signals', () => {
  it('covers a view with grid cells', () => {
    expect(cellsFor([-74.315, 40.785, -74.305, 40.795])).toHaveLength(1)
    const keys = cellsFor([-74.325, 40.775, -74.305, 40.795])
    expect(keys.length).toBe(4)
    const [w, s, e, n] = cellBox(keys[0])
    expect(e - w).toBeCloseTo(0.02)
    expect(n - s).toBeCloseTo(0.02)
  })
  it('tells car lights from pedestrian crossing lights', () => {
    const out = parseSignals([
      { id: 1, lat: 40.79, lon: -74.31, tags: { highway: 'traffic_signals' } },
      { id: 2, lat: 40.791, lon: -74.311, tags: { highway: 'crossing', crossing: 'traffic_signals' } },
      { id: 3, tags: {} },
    ])
    expect(out.map((s) => s.kind)).toEqual(['traffic', 'crossing'])
    expect(out[0].coords).toEqual([-74.31, 40.79])
  })
})
