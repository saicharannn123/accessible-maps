import { describe, expect, it } from 'vitest'
import { cellTopic, foldEvents, parseEvent, sendLimit, topicsAround, type RoadEvent } from '../roadReports'
import { alertsAhead } from '../roadAlerts'
import { stepPositions } from '../navigation'
import { motionFrom } from '../useRoadReports'
import type { LngLat, RouteResult } from '../types'

const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)
const min = 60_000
const A = 'devaaaaaaaaaaaaa', B = 'devbbbbbbbbbbbbb', C = 'devccccccccccccc'
const newEv = (id: string, d: string, at: number, extra: Partial<RoadEvent> = {}): RoadEvent =>
  ({ v: 1, k: 'new', id, d, at, t: 'crash', la: 40.78, lo: -74.3, h: 0, r: 'Main Street', ...extra })
const vote = (k: 'yes' | 'no', id: string, d: string, at: number): RoadEvent => ({ v: 1, k, id, d, at })

describe('parseEvent', () => {
  it('accepts a well-formed report and rounds coordinates', () => {
    const e = parseEvent({ v: 1, k: 'new', id: 'abcdefgh12', d: A, t: 'police', la: 40.123456789, lo: -74.98765432, h: 90, r: 'NJ-10' }, T0, T0)
    expect(e).toMatchObject({ t: 'police', la: 40.12346, lo: -74.98765, h: 90, r: 'NJ-10' })
  })
  it('drops anything odd', () => {
    const ok = { v: 1, k: 'new', id: 'abcdefgh12', d: A, t: 'police', la: 40, lo: -74 }
    expect(parseEvent({ ...ok, t: 'aliens' }, T0, T0)).toBeNull()
    expect(parseEvent({ ...ok, la: 'x' }, T0, T0)).toBeNull()
    expect(parseEvent({ ...ok, la: 95 }, T0, T0)).toBeNull()
    expect(parseEvent({ ...ok, id: '<script>' }, T0, T0)).toBeNull()
    expect(parseEvent({ ...ok, v: 2 }, T0, T0)).toBeNull()
    expect(parseEvent(ok, T0 + 60 * min, T0)).toBeNull() // from the future
    expect(parseEvent(ok, T0 - 13 * 60 * min, T0)).toBeNull() // older than 12 h
    expect(parseEvent({ ...ok, r: '<img src=x onerror=alert(1)>' }, T0, T0)?.r).toBeNull()
    expect(parseEvent({ ...ok, h: 400 }, T0, T0)?.h).toBeNull()
  })
})

describe('foldEvents', () => {
  it('expires reports by type unless confirmed', () => {
    const evs = [newEv('rep1aaaa', A, T0, { t: 'police' })]
    expect(foldEvents(evs, T0 + 59 * min)).toHaveLength(1)
    expect(foldEvents(evs, T0 + 61 * min)).toHaveLength(0)
    // Confirmed at 50 min: lasts until 110 min.
    const confirmed = [...evs, vote('yes', 'rep1aaaa', B, T0 + 50 * min)]
    const [r] = foldEvents(confirmed, T0 + 100 * min)
    expect(r.lastConfirmedAt).toBe(T0 + 50 * min)
    expect(r.confirmations).toBe(2)
    expect(foldEvents(confirmed, T0 + 111 * min)).toHaveLength(0)
  })

  it('merges nearby reports of the same event, not different ones', () => {
    const evs = [
      newEv('rep1aaaa', A, T0),
      newEv('rep2bbbb', B, T0 + 5 * min, { la: 40.7805 }), // ~55 m away, same road and direction
      newEv('rep3cccc', C, T0 + 6 * min, { la: 40.7805, h: 180 }), // other direction
      newEv('rep4dddd', C, T0 + 7 * min, { la: 40.7805, r: 'Frontage Road' }), // parallel road
      newEv('rep5eeee', B, T0 + 8 * min, { la: 40.7805, t: 'hazard' }), // other type
    ]
    const out = foldEvents(evs, T0 + 10 * min)
    expect(out.map((r) => r.id).sort()).toEqual(['rep1aaaa', 'rep3cccc', 'rep4dddd', 'rep5eeee'])
    expect(out.find((r) => r.id === 'rep1aaaa')!.confirmations).toBe(2)
  })

  it('removes a report after two "not there anymore" votes, or one from its reporter', () => {
    const base = [newEv('rep1aaaa', A, T0)]
    expect(foldEvents([...base, vote('no', 'rep1aaaa', B, T0 + min)], T0 + 2 * min)).toHaveLength(1)
    expect(foldEvents([...base, vote('no', 'rep1aaaa', B, T0 + min), vote('no', 'rep1aaaa', B, T0 + min + 1)], T0 + 2 * min)).toHaveLength(1) // one vote per device
    expect(foldEvents([...base, vote('no', 'rep1aaaa', B, T0 + min), vote('no', 'rep1aaaa', C, T0 + 2 * min)], T0 + 3 * min)).toHaveLength(0)
    expect(foldEvents([...base, vote('no', 'rep1aaaa', A, T0 + min)], T0 + 2 * min)).toHaveLength(0)
    // A fresh confirmation wipes earlier "gone" votes.
    expect(foldEvents([...base, vote('no', 'rep1aaaa', B, T0 + min), vote('yes', 'rep1aaaa', 'devddddddddddddd', T0 + 2 * min), vote('no', 'rep1aaaa', C, T0 + 3 * min)], T0 + 4 * min)).toHaveLength(1)
  })

  it('ignores a device that floods reports and duplicate deliveries', () => {
    const flood = Array.from({ length: 10 }, (_, i) => newEv(`flood${i}aaa`, A, T0 + i * 1000, { la: 40 + i * 0.1 }))
    expect(foldEvents(flood, T0 + min)).toHaveLength(6)
    const dup = [newEv('rep1aaaa', A, T0), newEv('rep1aaaa', A, T0 + 300)]
    expect(foldEvents(dup, T0 + min)).toHaveLength(1)
  })

  it('never keeps a report past 12 hours, even when confirmed', () => {
    const evs = [newEv('rep1aaaa', A, T0, { t: 'closure' })]
    for (let i = 1; i <= 13; i++) evs.push(vote('yes', 'rep1aaaa', `dev${String(i).padStart(13, 'x')}`, T0 + i * 55 * min))
    expect(foldEvents(evs, T0 + 11.9 * 60 * min)).toHaveLength(1)
    expect(foldEvents(evs, T0 + 12.1 * 60 * min)).toHaveLength(0)
  })
})

describe('map squares', () => {
  it('names a topic per 1° square and covers neighbors', () => {
    expect(cellTopic([-74.3, 40.78])).toBe('bmlocator-road1-130-105')
    const ts = topicsAround([[-74.3, 40.78]])
    expect(ts[0]).toBe('bmlocator-road1-130-105')
    expect(ts.length).toBeLessThanOrEqual(12)
  })
  it('limits how often one device can report', () => {
    expect(sendLimit({ news: [], votes: {} }, T0)).toBeNull()
    expect(sendLimit({ news: [T0 - 5000], votes: {} }, T0)).toMatch(/wait/)
    expect(sendLimit({ news: [1, 2, 3, 4, 5].map((i) => T0 - i * 5 * min), votes: {} }, T0)).toMatch(/this hour/)
  })
})

// A straight road going north ~2 km, with a parallel road 60 m east.
const lat = (m: number) => 40.78 + m / 110540
const route: RouteResult = {
  geometry: Array.from({ length: 21 }, (_, i) => [-74.3, lat(i * 100)] as LngLat),
  distanceMeters: 2000, durationSeconds: 120, stepFreeVerified: false, warnings: [],
  steps: [
    { text: 'Head out on Main Street', distanceMeters: 2000, coords: [-74.3, lat(0)], icon: '●', road: 'Main Street' },
    { text: 'Arrive', distanceMeters: 0, coords: [-74.3, lat(2000)], icon: '⚑' },
  ],
}
const report = (id: string, at: LngLat, extra: Partial<{ heading: number | null; road: string | null }> = {}) => ({
  id, type: 'police' as const, coords: at, heading: 0, road: 'Main Street', createdAt: T0, lastConfirmedAt: T0,
  confirmations: 1, goneVotes: 0, cell: 'x', reporter: A, ...extra,
})

describe('alertsAhead', () => {
  const stepAlong = stepPositions(route)
  const here: LngLat = [-74.3, lat(100)]
  const east = 60 / (111320 * Math.cos((40.78 * Math.PI) / 180))
  it('alerts for reports ahead on the route in my direction', () => {
    const out = alertsAhead(route, here, [report('ahead', [-74.3, lat(600)])], { stepAlong, speedMps: 20 })
    expect(out).toHaveLength(1)
    expect(Math.round(out[0].aheadMeters / 10) * 10).toBe(500)
  })
  it('skips reports behind, too far, on a parallel road, or for the other direction', () => {
    const rs = [
      report('behind', [-74.3, lat(20)]),
      report('far', [-74.3, lat(1900)]),
      report('parallel', [-74.3 + east, lat(600)], { road: null }),
      report('opposite', [-74.3, lat(700)], { heading: 180 }),
      report('other-name', [-74.3 + east / 4, lat(800)], { road: 'Frontage Road' }),
    ]
    expect(alertsAhead(route, here, rs, { stepAlong, speedMps: 13 })).toEqual([])
  })
  it('alerts when direction or road is unknown', () => {
    const out = alertsAhead(route, here, [report('unknown', [-74.3, lat(400)], { heading: null, road: null })], { stepAlong, speedMps: 13 })
    expect(out.map((a) => a.report.id)).toEqual(['unknown'])
  })
})

describe('motionFrom', () => {
  it('tells moving from stopped and ignores stale or rough fixes', () => {
    const fix = (s: number, m: number, acc = 10) => ({ at: T0 + s * 1000, p: [-74.3, lat(m)] as LngLat, acc })
    expect(motionFrom([fix(0, 0), fix(4, 60)], T0 + 4000).moving).toBe(true) // 15 m/s
    expect(motionFrom([fix(0, 0), fix(4, 2)], T0 + 4000).moving).toBe(false)
    expect(motionFrom([fix(0, 0), fix(4, 60)], T0 + 20000).moving).toBe(false) // no fresh fixes
    expect(motionFrom([fix(0, 0, 200), fix(4, 60, 200)], T0 + 4000).speedMps).toBeNull()
  })
})
