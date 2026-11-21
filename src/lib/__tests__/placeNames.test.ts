import { describe, expect, it } from 'vitest'
import { nameFor, renameExpression } from '../placeNames'
import { detectNameView } from '../worldview'

describe('place names by country view', () => {
  it('names the gulf the way each country does', () => {
    expect(nameFor('Gulf of Mexico', 'US')).toBe('Gulf of America')
    expect(nameFor('Golfo de México', 'MX')).toBe('Gulf of Mexico')
    expect(nameFor('Gulf of Mexico', 'IN')).toBe('Gulf of Mexico (Gulf of America)')
    expect(nameFor('Gulf of Mexico', null)).toBe('Gulf of Mexico (Gulf of America)')
    expect(nameFor('Denali', 'US')).toBe('Mount McKinley')
    expect(nameFor('Lake Michigan', 'US')).toBeNull()
  })
  it('keeps the original label for everything else', () => {
    const original = ['get', 'name']
    const expr = renameExpression(original, 'US') as unknown[]
    expect(expr[0]).toBe('case')
    expect(expr[expr.length - 1]).toBe(original)
    expect(expr).toContain('Gulf of America')
  })
  it('picks the US or Mexico view from the time zone', () => {
    expect(detectNameView('America/New_York', ['en-US'])).toBe('US')
    expect(detectNameView('America/Indiana/Indianapolis')).toBe('US')
    expect(detectNameView('America/Mexico_City', ['es-MX'])).toBe('MX')
    expect(detectNameView('Asia/Kolkata', ['en-US'])).toBe('IN')
    expect(detectNameView('Europe/London', ['en-US'])).toBeNull()
    // In the US with English (India) listed: US names, as Google shows by location.
    expect(detectNameView('America/New_York', ['en-US', 'en-IN'])).toBe('US')
  })
})
