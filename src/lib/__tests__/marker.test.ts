import { describe, expect, it } from 'vitest'
import { pickSnap, snapHeights } from '../useSheetDrag'
import { isMarkerStyle, markerHtml, resolveMarker } from '../marker'

describe('location marker', () => {
  it('Automatic is a dot while browsing and fits the trip while navigating', () => {
    expect(resolveMarker('auto', false, 'walk')).toBe('dot')
    expect(resolveMarker('auto', true, 'walk')).toBe('arrow')
    expect(resolveMarker('auto', true, 'car')).toBe('car')
    expect(resolveMarker('walker', true, 'car')).toBe('walker')
  })
  it('knows its styles and draws each one', () => {
    expect(isMarkerStyle('beam')).toBe(true)
    expect(isMarkerStyle('unicorn')).toBe(false)
    expect(markerHtml('walker')).toContain('🚶')
    expect(markerHtml('arrow')).toContain('<svg')
  })
})

describe('bottom sheet swipes', () => {
  const h = snapHeights(800)
  it('settles on the nearest stop after a slow drag', () => {
    expect(pickSnap(90, 0, 'half', h)).toBe('peek')
    expect(pickSnap(480, 0.1, 'half', h)).toBe('half')
    expect(pickSnap(620, -0.1, 'half', h)).toBe('full')
  })
  it('moves one stop in the direction of a flick', () => {
    expect(pickSnap(440, 0.8, 'half', h)).toBe('peek')
    expect(pickSnap(480, -0.8, 'half', h)).toBe('full')
    expect(pickSnap(100, -0.8, 'peek', h)).toBe('half')
    expect(pickSnap(600, 0.8, 'full', h)).toBe('half')
  })
})
