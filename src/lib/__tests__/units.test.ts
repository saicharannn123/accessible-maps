import { describe, expect, it } from 'vitest'
import { detectUnits, formatDistance, radiusChoices, snapRadius } from '../geo'

describe('distance units', () => {
  it('formats like a maps app', () => {
    expect(formatDistance(4667, 'mi')).toBe('2.9 mi')
    expect(formatDistance(100, 'mi')).toBe('330 ft')
    expect(formatDistance(40000, 'mi')).toBe('25 mi')
    expect(formatDistance(2900, 'km')).toBe('2.9 km')
    expect(formatDistance(347, 'km')).toBe('350 m')
  })
  it('uses miles in the US and UK only', () => {
    expect(detectUnits('America/New_York')).toBe('mi')
    expect(detectUnits('Europe/London')).toBe('mi')
    expect(detectUnits('Asia/Kolkata', ['en-US'])).toBe('km')
    expect(detectUnits('America/Toronto')).toBe('km')
    expect(detectUnits(undefined, ['en-US'])).toBe('mi')
  })
  it('keeps search radii in round numbers', () => {
    expect(radiusChoices('mi').map((r) => r.label)).toEqual(['¼ mi', '½ mi', '1 mi', '3 mi', '5 mi', '15 mi'])
    expect(snapRadius(1000, 'mi')).toBe(805)
    expect(snapRadius(1609, 'km')).toBe(2000)
  })
})
