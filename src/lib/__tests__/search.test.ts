import { describe, expect, it } from 'vitest'
import { matchKind, typoDistance } from '../search'

describe('place-kind search', () => {
  it('understands misspelled and plain-language searches', () => {
    expect(matchKind('hardward')?.label).toBe('Hardware stores')
    expect(matchKind('hardware stores near me')?.label).toBe('Hardware stores')
    expect(matchKind('cofee')?.label).toBe('Coffee')
    expect(matchKind('pharmacies')?.label).toBe('Pharmacies')
    expect(matchKind('gas station')?.label).toBe('Gas')
    expect(matchKind('hosp')?.label).toBe('Hospitals')
  })
  it('leaves names and towns alone', () => {
    expect(matchKind('paris')).toBeNull()
    expect(matchKind('livingston')).toBeNull()
    expect(matchKind('12 main street')).toBeNull()
  })
  it('counts a swapped pair of letters as one typo', () => {
    expect(typoDistance('hardwrae', 'hardware')).toBe(1)
  })
})

describe('sports and food searches', () => {
  it('finds the sport or cuisine people mean', () => {
    expect(matchKind('badminton')?.sport).toBe('badminton')
    expect(matchKind('badminton courts near me')?.sport).toBe('badminton')
    expect(matchKind('tennis')?.sport).toBe('tennis')
    expect(matchKind('sushi')?.cuisine).toContain('sushi')
    expect(matchKind('dentist')?.label).toBe('Dentists')
  })
})
