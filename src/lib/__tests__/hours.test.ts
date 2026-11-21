import { describe, expect, it } from 'vitest'
import { openStatus, parseOpeningHours } from '../hours'

// 2026-11-18 is a Wednesday.
const at = (day: number, h: number, m = 0) => new Date(2026, 10, 16 + day, h, m) // day 0 = Monday

describe('opening hours', () => {
  it('reads common formats', () => {
    expect(parseOpeningHours('Mo-Fr 08:00-18:00; Sa 09:00-14:00; Su off')?.[5]).toEqual([[540, 840]])
    expect(parseOpeningHours('Mo-Fr 08:00-12:00,13:00-17:00, Sa 10:00-12:00')?.[0]).toEqual([[480, 720], [780, 1020]])
    expect(parseOpeningHours('Mo-Fr 08:00-12:00,13:00-17:00, Sa 10:00-12:00')?.[5]).toEqual([[600, 720]])
    expect(parseOpeningHours('Fr-Mo 10:00-14:00')?.map((d) => d.length)).toEqual([1, 0, 0, 0, 1, 1, 1])
    expect(parseOpeningHours('Mo,We 09:00-10:00')?.map((d) => d.length)).toEqual([1, 0, 1, 0, 0, 0, 0])
    expect(parseOpeningHours('sunrise-sunset')).toBeNull()
    expect(parseOpeningHours('Jan-Mar Mo 10:00-12:00')).toBeNull()
  })

  it('says open or closed with the next change', () => {
    const h = 'Mo-Fr 08:00-18:00; Sa 09:00-14:00; Su off; PH off'
    expect(openStatus(h, at(2, 12))).toEqual({ open: true, detail: 'Closes 6 PM' })
    expect(openStatus(h, at(2, 19))).toEqual({ open: false, detail: 'Opens 8 AM tomorrow' })
    expect(openStatus(h, at(5, 15))).toEqual({ open: false, detail: 'Opens 8 AM Mon' })
    expect(openStatus(h, at(0, 7, 30))).toEqual({ open: false, detail: 'Opens 8 AM' })
  })

  it('handles late nights and 24/7', () => {
    expect(openStatus('Mo-Su 18:00-02:00', at(2, 1))).toEqual({ open: true, detail: 'Closes 2 AM' })
    expect(openStatus('Mo-Su 18:00-02:00', at(2, 23))).toEqual({ open: true, detail: 'Closes 2 AM' })
    expect(openStatus('24/7', at(3, 3))).toEqual({ open: true, detail: 'Open 24 hours' })
    expect(openStatus('Mo-Su 00:00-24:00', at(3, 3))).toEqual({ open: true, detail: 'Open 24 hours' })
    expect(openStatus('Mo-Su 10:30-21:30', at(3, 21, 0))).toEqual({ open: true, detail: 'Closes 9:30 PM' })
    expect(openStatus(undefined)).toBeNull()
  })
})
