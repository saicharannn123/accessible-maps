import { describe, expect, it } from 'vitest'
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
