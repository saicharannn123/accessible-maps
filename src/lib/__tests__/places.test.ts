import { describe, expect, it } from 'vitest'
import { CATEGORIES, CATEGORY_BY_ID, buildNearbyQuery, parseNearby } from '../places'
import type { LngLat } from '../types'

const center: LngLat = [-122.3321, 47.6062]

describe('nearby places', () => {
  it('has the everyday categories people use most', () => {
    for (const id of ['restaurants', 'coffee', 'malls', 'shops', 'groceries', 'gas', 'pharmacy', 'atm', 'hotels', 'parking', 'hospitals']) {
      expect(CATEGORY_BY_ID[id]).toBeDefined()
    }
    expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(CATEGORIES.length)
  })

  it('builds an around query in lat,lng order and only asks for named restaurants', () => {
    const q = buildNearbyQuery(CATEGORY_BY_ID.restaurants, center, 1000)
    expect(q).toContain('nwr["amenity"="restaurant"]["name"](around:1000,47.606200,-122.332100);')
    expect(q).toContain('out center tags')
    expect(buildNearbyQuery(CATEGORY_BY_ID.parking, center, 500)).not.toContain('["name"]')
  })

  it('parses places nearest first, with details and wheelchair access', () => {
    const places = parseNearby([
      { type: 'node', id: 1, lat: 47.62, lon: -122.3321, tags: { amenity: 'restaurant', name: 'Far Diner' } },
      { type: 'way', id: 2, center: { lat: 47.6065, lon: -122.3321 }, tags: {
        amenity: 'restaurant', name: 'Near Bistro', cuisine: 'italian;pizza', wheelchair: 'yes',
        'addr:housenumber': '12', 'addr:street': 'Pike St', opening_hours: 'Mo-Su 11:00-22:00', phone: '+1 206 555 0100',
      } },
      { type: 'node', id: 3, lat: 47.6065, lon: -122.3321, tags: { amenity: 'restaurant', name: 'Near Bistro' } }, // duplicate
      { type: 'node', id: 4, lat: 47.607, lon: -122.3321, tags: { amenity: 'restaurant' } }, // unnamed
    ], CATEGORY_BY_ID.restaurants, center)
    expect(places.map((p) => p.name)).toEqual(['Near Bistro', 'Far Diner'])
    expect(places[0]).toMatchObject({ kind: 'Italian restaurant', address: '12 Pike St', wheelchair: 'yes', phone: '+1 206 555 0100' })
    expect(places[0].distance).toBeLessThan(50)
    expect(places[1].wheelchair).toBe('unknown')
  })

  it('names unnamed parking and skips private lots', () => {
    const places = parseNearby([
      { type: 'way', id: 1, center: { lat: 47.6063, lon: -122.3321 }, tags: { amenity: 'parking' } },
      { type: 'way', id: 2, center: { lat: 47.6064, lon: -122.3321 }, tags: { amenity: 'parking', access: 'private' } },
      { type: 'node', id: 3, lat: 47.6066, lon: -122.3321, tags: { amenity: 'atm', operator: 'Chase' } },
    ], CATEGORY_BY_ID.parking, center)
    expect(places.map((p) => p.name)).toEqual(['Parking', 'Chase'])
  })
})
