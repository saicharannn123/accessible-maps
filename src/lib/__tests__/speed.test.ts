import { describe, expect, it } from 'vitest'
import { limitIn, matchRoad, parseMaxspeed, parseOverpassRoads, parseQleverRoads, type Road } from '../roads'
import { currentSpeed, isStopped, speedIn, speedUnitLabel, travelHeading, type LocationFix } from '../speed'

const T = 1_700_000_000_000
// About 11.1 m per 0.0001° of latitude.
const fix = (lat: number, at: number, extra: Partial<LocationFix> = {}): LocationFix =>
  ({ lng: -74.3, lat, accuracy: 8, speed: null, heading: null, at, ...extra })

describe('current speed', () => {
  it('uses the device speed when the reading is fresh and accurate', () => {
    expect(currentSpeed([fix(40.78, T, { speed: 20 })], T + 1000)).toEqual({ mps: 20, reason: 'ok' })
  })
  it('shows nothing when there is no reading', () => {
    expect(currentSpeed([], T).mps).toBeNull()
  })
  it('drops a reading older than 5 seconds (signal lost)', () => {
    expect(currentSpeed([fix(40.78, T, { speed: 20 })], T + 6000)).toEqual({ mps: null, reason: 'stale' })
  })
  it('drops a rough reading', () => {
    expect(currentSpeed([fix(40.78, T, { speed: 20, accuracy: 80 })], T + 500)).toEqual({ mps: null, reason: 'inaccurate' })
  })
  it('drops an impossible speed', () => {
    expect(currentSpeed([fix(40.78, T, { speed: 300 })], T).mps).toBeNull()
  })
  it('measures speed between readings when the device gives none', () => {
    // 0.00054° north in 3 s is about 60 m: ~20 m/s.
    const r = currentSpeed([fix(40.78, T), fix(40.78054, T + 3000)], T + 3500)
    expect(r.reason).toBe('ok')
    expect(r.mps!).toBeGreaterThan(19)
    expect(r.mps!).toBeLessThan(21)
  })
  it('needs two readings to measure', () => {
    expect(currentSpeed([fix(40.78, T)], T).mps).toBeNull()
  })
  it('ignores rough earlier readings when measuring', () => {
    expect(currentSpeed([fix(40.78, T, { accuracy: 200 }), fix(40.78054, T + 3000)], T + 3000).mps).toBeNull()
  })
  it('knows when you are stopped', () => {
    expect(isStopped([fix(40.78, T, { speed: 0.4 })], T + 100)).toBe(true)
    expect(isStopped([fix(40.78, T, { speed: 12 })], T + 100)).toBe(false)
    expect(isStopped([fix(40.78, T, { speed: 0 })], T + 9000)).toBe(false) // too old to say
  })
  it('converts to the chosen units', () => {
    expect(Math.round(speedIn(20, 'mi'))).toBe(45)
    expect(Math.round(speedIn(20, 'km'))).toBe(72)
    expect(speedUnitLabel('mi')).toBe('mph')
    expect(speedUnitLabel('km')).toBe('km/h')
  })
})

describe('travel heading', () => {
  it('uses the device heading while moving', () => {
    expect(travelHeading([fix(40.78, T, { speed: 15, heading: 90 })], T)).toBe(90)
  })
  it('works it out from the readings otherwise', () => {
    expect(Math.round(travelHeading([fix(40.78, T), fix(40.7805, T + 3000)], T + 3000)!)).toBe(0)
    expect(Math.round(travelHeading([fix(40.7805, T), fix(40.78, T + 3000)], T + 3000)!)).toBe(180)
  })
  it('gives none when you have barely moved', () => {
    expect(travelHeading([fix(40.78, T), fix(40.78001, T + 3000)], T + 3000)).toBeNull()
  })
})

describe('posted limits', () => {
  it('reads plain numbers only', () => {
    expect(parseMaxspeed('50')).toEqual({ value: 50, unit: 'km/h', kmh: 50 })
    expect(parseMaxspeed('35 mph')?.unit).toBe('mph')
    expect(parseMaxspeed('35 mph')?.kmh).toBeCloseTo(56.33, 1)
    for (const t of ['DE:urban', 'none', 'signals', 'walk', '50;30', '', undefined, '0']) expect(parseMaxspeed(t)).toBeNull()
  })
  it('shows the signed number in matching units and converts otherwise', () => {
    expect(limitIn(parseMaxspeed('35 mph')!, 'mi')).toBe(35)
    expect(limitIn(parseMaxspeed('35 mph')!, 'km')).toBe(56)
    expect(limitIn(parseMaxspeed('100')!, 'mi')).toBe(62)
  })
})

// A north-south avenue (drawn south to north) with different limits each way, a one-way street
// running north 25 m east of it, and an east-west cross street.
const avenue: Road = { id: 1, highway: 'primary', name: 'Main Ave', oneway: 0, maxspeed: '40 mph', maxspeedBackward: '30 mph',
  line: [[-74.3, 40.77], [-74.3, 40.79]] }
const oneWay: Road = { id: 2, highway: 'secondary', name: 'Side St', oneway: 1, maxspeed: '25 mph',
  line: [[-74.2997, 40.77], [-74.2997, 40.79]] }
const cross: Road = { id: 3, highway: 'residential', name: 'Oak St', oneway: 0, maxspeed: '15 mph',
  line: [[-74.31, 40.78], [-74.29, 40.78]] }
const roads = [avenue, oneWay, cross]

describe('matching your road and direction', () => {
  it('picks the road you drive along, with the limit for your direction', () => {
    const north = matchRoad(roads, [-74.30002, 40.785], 2)
    expect(north?.road.id).toBe(1)
    expect(north?.direction).toBe('forward')
    expect(north?.limit?.value).toBe(40)
    const south = matchRoad(roads, [-74.30002, 40.785], 181)
    expect(south?.road.id).toBe(1)
    expect(south?.limit?.value).toBe(30)
  })
  it('ignores the cross street at a junction', () => {
    expect(matchRoad(roads, [-74.3, 40.78], 0)?.road.id).toBe(1)
    expect(matchRoad(roads, [-74.3, 40.78], 90)?.road.id).toBe(3)
  })
  it('never uses a one-way street against its direction', () => {
    // Closer to Side St but heading south (its wrong way): the avenue 14 m away fits instead.
    expect(matchRoad(roads, [-74.29983, 40.785], 180)?.road.id).toBe(1)
  })
  it('gives no limit when two parallel roads fit equally and disagree', () => {
    // Halfway between the avenue and Side St, both heading north.
    expect(matchRoad(roads, [-74.29985, 40.785], 0)).toBeNull()
  })
  it('gives nothing without a direction or far from any road', () => {
    expect(matchRoad(roads, [-74.30002, 40.785], null)).toBeNull()
    expect(matchRoad(roads, [-74.28, 40.785], 0)).toBeNull()
  })
  it('a road with no limit tagged matches with no limit, rather than borrowing a neighbor’s', () => {
    const plain: Road = { ...avenue, maxspeed: undefined, maxspeedBackward: undefined }
    const m = matchRoad([plain, cross], [-74.30002, 40.785], 0)
    expect(m?.road.id).toBe(1)
    expect(m?.limit).toBeNull()
  })
})

describe('loading roads', () => {
  it('reads Overpass ways', () => {
    const r = parseOverpassRoads([
      { id: 9, geometry: [{ lat: 40.7, lon: -74.3 }, { lat: 40.71, lon: -74.3 }], tags: { highway: 'motorway', maxspeed: '65 mph' } },
      { id: 10, geometry: [{ lat: 40.7, lon: -74.3 }, { lat: 40.71, lon: -74.3 }], tags: { highway: 'footway' } },
    ])
    expect(r).toHaveLength(1)
    expect(r[0].oneway).toBe(1) // motorways are one-way
    expect(r[0].maxspeed).toBe('65 mph')
  })
  it('reads QLever rows', () => {
    const r = parseQleverRoads([
      { w: { value: 'https://www.openstreetmap.org/way/42' }, hw: { value: 'primary' }, wkt: { value: 'LINESTRING(-74.3 40.7,-74.3 40.71)' },
        ms: { value: '50' }, ow: { value: '-1' } },
      { w: { value: 'https://www.openstreetmap.org/way/42' }, hw: { value: 'primary' }, wkt: { value: 'LINESTRING(-74.3 40.7,-74.3 40.71)' } },
    ])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 42, oneway: -1, maxspeed: '50', line: [[-74.3, 40.7], [-74.3, 40.71]] })
  })
})
