import { describe, expect, it } from 'vitest'
import { distanceMeters, distanceToLine, formatDistance } from '../geo'
import { buildQuery, parseElements } from '../overpass'
import { findWarnings, orsRequest, osrmSteps, osrmUrl } from '../routing'
import type { LngLat, Settings } from '../types'

const line: LngLat[] = [[-122.3400, 47.6000], [-122.3300, 47.6000]]
const wheelchair: Settings = { profile: 'wheelchair', maxInclinePercent: 6, worldview: 'auto', mapLook: 'clean', travelMode: 'accessible', units: 'km' }

describe('geo', () => {
  it('measures distances', () => {
    expect(distanceMeters([0, 0], [0, 1])).toBeGreaterThan(111000)
    expect(distanceMeters([0, 0], [0, 1])).toBeLessThan(111400)
    expect(distanceToLine([-122.335, 47.6], line)).toBeLessThan(1)
    expect(distanceToLine([-122.335, 47.6009], line)).toBeGreaterThan(90)
    expect(formatDistance(450)).toBe('450 m')
    expect(formatDistance(2345)).toBe('2.3 km')
  })
})

describe('overpass', () => {
  it('puts the bbox in south,west,north,east order', () => {
    expect(buildQuery([1, 2, 3, 4])).toContain('(2,1,4,3)')
  })
  it('parses restrooms, lighting and steps', () => {
    const d = parseElements([
      { type: 'node', id: 1, lat: 47.6, lon: -122.33, tags: { amenity: 'toilets', wheelchair: 'yes', fee: 'no', changing_table: 'yes' } },
      { type: 'way', id: 2, geometry: [{ lat: 47.6, lon: -122.34 }, { lat: 47.6, lon: -122.335 }], tags: { highway: 'footway', lit: 'no' } },
      { type: 'way', id: 3, geometry: [{ lat: 47.6, lon: -122.336 }, { lat: 47.6001, lon: -122.336 }], tags: { highway: 'steps', lit: 'yes' } },
    ])
    expect(d.restrooms[0]).toMatchObject({ wheelchair: 'yes', fee: 'free', changingTable: true })
    expect(d.lighting).toHaveLength(2)
    expect(d.obstacles[0]).toMatchObject({ kind: 'steps' })
  })
})

describe('routing', () => {
  it('maps profiles to OpenRouteService options', () => {
    const w = orsRequest([[0, 0], [1, 1]], { profile: 'wheelchair', maxInclinePercent: 5, worldview: 'auto', mapLook: 'clean', travelMode: 'accessible', units: 'km' })
    expect(w.profile).toBe('wheelchair')
    expect(w.body.options).toMatchObject({ profile_params: { restrictions: { maximum_incline: 6 } } })
    expect(orsRequest([[0, 0], [1, 1]], { profile: 'cane', maxInclinePercent: 6, worldview: 'auto', mapLook: 'clean', travelMode: 'accessible', units: 'km' }).body.options).toEqual({ avoid_features: ['steps'] })
  })

  it('warns about steps, reports and unverified routes', () => {
    const route = { geometry: line, distanceMeters: 750, durationSeconds: 750, stepFreeVerified: false }
    const access = parseElements([
      { type: 'way', id: 3, geometry: [{ lat: 47.6, lon: -122.336 }, { lat: 47.6001, lon: -122.336 }], tags: { highway: 'steps' } },
      { type: 'way', id: 4, geometry: [{ lat: 47.61, lon: -122.336 }, { lat: 47.6101, lon: -122.336 }], tags: { highway: 'steps' } },
    ])
    const now = Date.now()
    const reports = [
      { id: 'a', type: 'broken-elevator' as const, note: 'East side', coords: [-122.332, 47.6001] as LngLat, createdAt: now - 3600_000 },
      { id: 'b', type: 'blocked-sidewalk' as const, note: '', coords: [-122.332, 47.61] as LngLat, createdAt: now },
    ]
    const kinds = findWarnings(route, wheelchair, access, reports, now).map((w) => w.kind)
    expect(kinds).toEqual(['not-verified', 'steps', 'report'])
  })

  it('flags unlit streets only for night walking', () => {
    const route = { geometry: line, distanceMeters: 750, durationSeconds: 750, stepFreeVerified: true }
    const access = parseElements([
      { type: 'way', id: 2, geometry: [{ lat: 47.6, lon: -122.34 }, { lat: 47.6, lon: -122.338 }, { lat: 47.6, lon: -122.336 }], tags: { highway: 'footway', lit: 'no' } },
    ])
    expect(findWarnings(route, wheelchair, access, []).map((w) => w.kind)).toEqual([])
    expect(findWarnings(route, { ...wheelchair, profile: 'night' }, access, []).map((w) => w.kind)).toEqual(['unlit'])
  })
})

describe('travel modes', () => {
  it('routes through every stop in order with the right free server', () => {
    const url = osrmUrl('car', [[-71.1, 42.1], [-71.2, 42.2], [-71.3, 42.3]])
    expect(url).toContain('/routed-car/route/v1/driving/-71.100000,42.100000;-71.200000,42.200000;-71.300000,42.300000?')
    expect(osrmUrl('bike', [[0, 0], [1, 1]])).toContain('/routed-bike/')
    expect(osrmUrl('walk', [[0, 0], [1, 1]])).toContain('/routed-foot/')
  })
  it('only warns about steps and sidewalk reports on foot', () => {
    const route = { geometry: [[0, 0], [0.001, 0]] as [number, number][], distanceMeters: 100, durationSeconds: 60, stepFreeVerified: false }
    const report = [{ id: 'r', type: 'blocked-sidewalk' as const, note: '', coords: [0.0005, 0] as [number, number], createdAt: Date.now() }]
    expect(findWarnings(route, { ...wheelchair, travelMode: 'car' }, null, report)).toEqual([])
    expect(findWarnings(route, { ...wheelchair, travelMode: 'walk' }, null, report).map((w) => w.kind)).toEqual(['report'])
    expect(findWarnings(route, wheelchair, null, report).map((w) => w.kind)).toEqual(['not-verified', 'report'])
  })
})

describe('turn-by-turn steps', () => {
  it('writes plain-English OSRM instructions and marks stops', () => {
    const at: [number, number] = [0, 0]
    const steps = osrmSteps([
      { steps: [
        { distance: 120, name: 'Main Street', maneuver: { type: 'depart', location: at } },
        { distance: 300, name: 'Oak Avenue', maneuver: { type: 'turn', modifier: 'left', location: at } },
        { distance: 0, name: '', maneuver: { type: 'arrive', location: at } },
      ] },
      { steps: [
        { distance: 50, name: '', maneuver: { type: 'depart', location: at } },
        { distance: 80, name: 'Elm Road', maneuver: { type: 'roundabout', exit: 2, location: at } },
        { distance: 60, name: 'Pine Lane', maneuver: { type: 'turn', modifier: 'slight right', location: at } },
        { distance: 0, name: '', maneuver: { type: 'arrive', location: at } },
      ] },
    ])
    expect(steps.map((s) => s.text)).toEqual([
      'Head out on Main Street',
      'Turn left onto Oak Avenue',
      'Arrive at stop 1',
      'Head out',
      'At the roundabout, take the 2nd exit onto Elm Road',
      'Bear right onto Pine Lane',
      'Arrive at your destination',
    ])
    expect(steps[1].icon).toBe('↰')
  })
  it('asks OSRM for steps', () => {
    expect(osrmUrl('walk', [[0, 0], [1, 1]])).toContain('steps=true')
  })
})
