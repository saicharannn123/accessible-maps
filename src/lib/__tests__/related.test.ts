import { describe, expect, it } from 'vitest'
import {
  adminAreaQuery, containerSpots, coreName, groupFromText, insideQuery, kindFromOsmTag, kindFromText, linksQuery, mergeSpots,
  nearbySpots, osmQuery, parseLinks, parseOsmRows, wantsFor, type RelatedSpot,
} from '../related'
import type { LngLat } from '../types'

const NANDA_DEVI: LngLat = [79.9706, 30.3757]
const v = (value: string) => ({ value })

describe('what kind of place', () => {
  it('reads OSM tags', () => {
    expect(kindFromOsmTag('natural=peak')).toBe('mountain')
    expect(kindFromOsmTag('boundary=national_park')).toBe('park')
    expect(kindFromOsmTag('place=city')).toBe('city')
    expect(kindFromOsmTag('amenity=cafe')).toBeNull()
  })
  it('reads descriptions', () => {
    expect(kindFromText('National park')).toBe('park')
    expect(kindFromText('Mountain')).toBe('mountain')
    expect(kindFromText('Capital city')).toBe('city')
  })
  it('groups related items by their class name', () => {
    expect(groupFromText('national park')).toBe('park')
    expect(groupFromText('glacier')).toBe('water')
    expect(groupFromText('mountain range')).toBe('mountain')
    expect(groupFromText('museum')).toBe('museum')
  })
  it('keeps the specific words of a name', () => {
    expect(coreName('Nanda Devi National Park')).toBe('nanda devi')
    expect(coreName('Mount Rainier')).toBe('rainier')
  })
})

describe('queries', () => {
  it('asks Wikidata for city landmarks only for cities', () => {
    expect(linksQuery('Q90', true)).toContain('wdt:P131 wd:Q90')
    expect(linksQuery('Q213262')).not.toContain('P131')
    expect(linksQuery('Q213262')).toContain('wd:Q213262 wdt:P3018 ?r')
  })
  it('asks OSM around the place with centroids', () => {
    const q = osmQuery(wantsFor('mountain'), NANDA_DEVI, 40_000)
    expect(q).toContain('"trailhead"')
    expect(q).toContain('geof:centroid')
    expect(q).not.toContain('hasCentroid')
  })
  it('looks in the districts around the place, nearest first', () => {
    const q = adminAreaQuery('node/299492171', wantsFor('mountain'), NANDA_DEVI)
    expect(q).toContain('ogc:sfContains <https://www.openstreetmap.org/node/299492171>')
    expect(q).toContain('?lvl >= 5 && ?lvl <= 8')
    expect(q).not.toContain('sfIntersects')
    expect(q).not.toContain('VALUES ?a')
    expect(adminAreaQuery('relation/71525', wantsFor('city'), [2.35, 48.86])).toContain('VALUES ?a { <https://www.openstreetmap.org/relation/71525> }')
    expect(q).toContain('ORDER BY ASC(geof:distance(?c, "POINT(79.97060 30.37570)"')
  })
  it('asks what is inside an area', () => {
    expect(insideQuery(['way/126758723'], wantsFor('park'))).toContain('VALUES ?a { <https://www.openstreetmap.org/way/126758723> }')
  })
})

describe('turning answers into spots', () => {
  it('reads Wikidata links with a reason, keeping the strongest link', () => {
    const rows = [
      { r: v('http://www.wikidata.org/entity/Q1648266'), rel: v('park'), name: v('Nanda Devi National Park'), c: v('Point(79.86 30.41)'), type: v('national park'), sl: v('30') },
      { r: v('http://www.wikidata.org/entity/Q1648266'), rel: v('onFeature'), name: v('Nanda Devi National Park'), c: v('Point(79.86 30.41)'), type: v('national park'), sl: v('30') },
      { r: v('http://www.wikidata.org/entity/Q5451'), rel: v('range'), name: v('Himalayas'), c: v('Point(84 29)'), type: v('mountain range'), sl: v('150') },
    ]
    const spots = parseLinks(rows, NANDA_DEVI, 'mountain')
    expect(spots.map((s) => s.name)).toEqual(['Nanda Devi National Park', 'Himalayas'])
    expect(spots[0]).toMatchObject({ group: 'park', direct: true, reason: 'National park this place is in', wheelchair: 'unknown' })
    expect(spots[1].group).toBe('mountain')
  })

  it('reads OSM rows and gives nearby spots a reason', () => {
    const wants = wantsFor('mountain')
    const hits = parseOsmRows([
      { o: v('https://www.openstreetmap.org/node/1'), want: v('7'), name: v('Nanda Devi base camp'), c: v('POINT(79.99 30.43)') },
      { o: v('https://www.openstreetmap.org/node/2'), want: v('1'), c: v('POINT(79.7 30.6)'), wheelchair: v('yes') },
      { o: v('https://www.openstreetmap.org/node/3'), want: v('11'), c: v('POINT(79.9 30.4)') }, // unnamed peak: skipped
    ])
    const spots = nearbySpots(hits, wants, { name: 'Nanda Devi', coords: NANDA_DEVI, kind: 'mountain' })
    expect(spots).toHaveLength(2)
    expect(spots[0]).toMatchObject({ name: 'Nanda Devi base camp', reason: 'Campsite for this mountain', direct: true })
    expect(spots[1]).toMatchObject({ name: 'Viewpoint', reason: 'Nearby viewpoint', direct: false, wheelchair: 'yes' })
  })

  it('says which park a peak is in', () => {
    const spots = containerSpots([
      { o: v('https://www.openstreetmap.org/way/126758723'), want: v('0'), name: v('Nanda Devi National Park'), c: v('POINT(79.86 30.41)'), wikidata: v('Q1648266') },
    ], { coords: NANDA_DEVI, kind: 'mountain' })
    expect(spots[0]).toMatchObject({ reason: 'National park this mountain is in', osm: 'way/126758723', group: 'park' })
  })
})

describe('merging', () => {
  const spot = (over: Partial<RelatedSpot>): RelatedSpot => ({
    id: 'x', name: 'X', coords: [80, 30.4], group: 'landmark', kind: 'Thing', reason: 'r', direct: false, distance: 1000, wheelchair: 'unknown', ...over,
  })
  const anchor = { name: 'Nanda Devi', coords: NANDA_DEVI, kind: 'mountain' as const, wikidata: 'Q213262', osm: 'node/299492171' }

  it('puts direct links first, drops the place itself and merges duplicates', () => {
    const out = mergeSpots(
      [spot({ id: 'way/1', osm: 'way/1', name: 'Nanda Devi National Park', group: 'park', direct: true, wikidata: 'Q1648266' }),
        spot({ id: 'wd:Q1648266', wikidata: 'Q1648266', name: 'Nanda Devi National Park', group: 'park', direct: true })],
      [spot({ id: 'node/299492171', osm: 'node/299492171', name: 'Nanda Devi', group: 'mountain' }),
        spot({ id: 'node/5', osm: 'node/5', name: 'Viewpoint', kind: 'Viewpoint', group: 'viewpoint', distance: 30_000, wheelchair: 'yes' }),
        spot({ id: 'node/6', osm: 'node/6', name: 'Changabang', group: 'mountain', distance: 12_000 })],
      anchor,
    )
    expect(out.map((s) => s.name)).toEqual(['Nanda Devi National Park', 'Viewpoint', 'Changabang'])
  })

  it('shows trailheads before peaks around a mountain', () => {
    const out = mergeSpots([], [
      spot({ id: 'a', name: 'Peak A', group: 'mountain', distance: 100 }),
      spot({ id: 'b', name: 'Trailhead B', group: 'trail', distance: 9000 }),
    ], anchor)
    expect(out.map((s) => s.name)).toEqual(['Trailhead B', 'Peak A'])
  })
})
