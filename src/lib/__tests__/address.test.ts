import { afterEach, describe, expect, it, vi } from 'vitest'
import { cityStatePostal, mergeSameAddresses, postalQuery, searchBarText } from '../address'
import { photonPlace } from '../search'
import { reverseGeocode, searchAll } from '../geocode'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const LIVINGSTON: [number, number] = [-74.315, 40.796]
afterEach(() => { vi.unstubAllGlobals() })

const house = (c: [number, number], props: Record<string, unknown>) => ({ geometry: { coordinates: c }, properties: props })
const mill = (c: [number, number], extra: Record<string, unknown> = {}) => house(c, {
  housenumber: '276', street: 'Mill Road', city: 'Livingston', state: 'New Jersey', postcode: '07039', countrycode: 'US', county: 'Essex County', ...extra,
})

describe('postal codes in addresses', () => {
  it('writes town, state and code the local way', () => {
    expect(cityStatePostal({ city: 'Livingston', state: 'New Jersey', postcode: '07039', country: 'US' })).toBe('Livingston, NJ 07039')
    expect(cityStatePostal({ city: 'Mumbai', state: 'Maharashtra', postcode: '400001', country: 'IN' })).toBe('Mumbai, Maharashtra 400001')
    expect(cityStatePostal({ city: 'Livingston', state: 'New Jersey', country: 'US' })).toBe('Livingston, NJ')
  })

  it('shows the code in suggestions and the search bar, and leaves it out when unknown', () => {
    const p = photonPlace(mill([-74.3, 40.8]), undefined)
    expect(p).toMatchObject({ name: '276 Mill Road', postcode: '07039', area: 'Livingston, NJ 07039' })
    expect(p.detail).toBe('Livingston, NJ 07039')
    expect(searchBarText(p)).toBe('276 Mill Road, Livingston, NJ 07039')
    const noCode = photonPlace(mill([-74.3, 40.8], { postcode: undefined }), undefined)
    expect(noCode.postcode).toBeUndefined()
    expect(searchBarText(noCode)).toBe('276 Mill Road, Livingston, NJ')
    const pin = photonPlace(house([72.83, 18.93], { name: 'CST', city: 'Mumbai', state: 'Maharashtra', postcode: '400 001', countrycode: 'IN' }), undefined)
    expect(pin.detail).toBe('Mumbai, Maharashtra 400001')
  })

  it('recognizes searches that are only a ZIP or PIN code', () => {
    expect(postalQuery('07039')).toBe('07039')
    expect(postalQuery('07039-1234')).toBe('07039-1234')
    expect(postalQuery('400 001')).toBe('400001')
    expect(postalQuery('PIN 560001')).toBe('560001')
    expect(postalQuery('zip code 10001')).toBe('10001')
    expect(postalQuery('276 Mill Road')).toBeNull()
    expect(postalQuery('Livingston')).toBeNull()
  })
})

describe('duplicate addresses', () => {
  it('merges the same address at the same spot (house point + building)', () => {
    const a = photonPlace(mill([-74.3301, 40.8101], { osm_type: 'N', osm_id: 1 }), LIVINGSTON)
    const b = photonPlace(mill([-74.3303, 40.8102], { osm_type: 'W', osm_id: 2 }), LIVINGSTON)
    expect(mergeSameAddresses([a, b])).toHaveLength(1)
  })

  it('keeps the same street number in different towns, and they read differently', () => {
    const a = photonPlace(mill([-74.33, 40.81]), LIVINGSTON)
    const b = photonPlace(mill([-74.58, 40.88], { city: 'Randolph', postcode: '07869', county: 'Morris County' }), LIVINGSTON)
    const out = mergeSameAddresses([a, b])
    expect(out).toHaveLength(2)
    expect(out[0].detail).toContain('07039')
    expect(out[1].detail).toContain('Randolph, NJ 07869')
  })

  it('tells apart same-name places that would otherwise read the same', () => {
    const a = photonPlace(mill([-74.33, 40.81], { city: undefined, postcode: undefined }), undefined)
    const b = photonPlace(mill([-74.9, 40.5], { city: undefined, postcode: undefined, county: 'Hunterdon County' }), undefined)
    const out = mergeSameAddresses([a, b])
    expect(out).toHaveLength(2)
    expect(out[0].detail).not.toBe(out[1].detail)
    expect(out[1].detail).toContain('Hunterdon County')
  })

  it('search returns one "276 Mill Road" when both sources found it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('photon')) return json({ features: [
        mill([-74.3301, 40.8101], { osm_type: 'N', osm_id: 1, postcode: undefined }),
        mill([-74.3303, 40.8102], { osm_type: 'W', osm_id: 2 }),
      ] })
      return json([])
    }))
    const r = await searchAll('276 Mill Road dup test', undefined, LIVINGSTON)
    const mills = r.places.filter((p) => p.name === '276 Mill Road')
    expect(mills).toHaveLength(1)
    expect(mills[0].postcode).toBe('07039')
  })
})

describe('search by postal code', () => {
  it('finds a ZIP code area near you first', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('nominatim')) return json([
        { lat: '43.6', lon: '1.4', display_name: '07039, France', type: 'postcode', address: { postcode: '07039', country_code: 'fr' } },
        { lat: '40.79', lon: '-74.32', display_name: '07039, Livingston, New Jersey, United States', type: 'postcode',
          address: { postcode: '07039', town: 'Livingston', state: 'New Jersey', country_code: 'us' } },
      ])
      return json({ features: [] })
    }))
    const r = await searchAll('07039', undefined, LIVINGSTON)
    expect(r.places[0]).toMatchObject({ name: '07039', postcode: '07039', icon: '📮' })
    expect(r.places[0].far).toBeFalsy()
    expect(r.places[0].detail).toContain('ZIP code · Livingston, NJ')
    expect(r.places[1].far).toBe(true)
  })

  it('pieces a PIN code area together from addresses when Nominatim is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('nominatim')) return new Response('busy', { status: 503 })
      return json({ features: [
        house([72.83, 18.94], { name: 'A', city: 'Mumbai', state: 'Maharashtra', postcode: '400001', countrycode: 'IN' }),
        house([72.84, 18.93], { name: 'B', city: 'Mumbai', state: 'Maharashtra', postcode: '400001', countrycode: 'IN' }),
        house([72.9, 19.1], { name: 'C', city: 'Mumbai', state: 'Maharashtra', postcode: '400072', countrycode: 'IN' }),
      ] })
    }))
    const r = await searchAll('400001', undefined, [72.85, 18.95])
    expect(r.places).toHaveLength(1)
    expect(r.places[0]).toMatchObject({ name: '400001', country: 'IN' })
    expect(r.places[0].detail).toContain('PIN code · Mumbai, Maharashtra')
  })
})

describe('dropped pins', () => {
  it('include the postal code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ features: [mill([-74.33, 40.81])] })))
    const p = await reverseGeocode([-74.33, 40.81])
    expect(p).toMatchObject({ name: '276 Mill Road', postcode: '07039', detail: 'Livingston, NJ 07039' })
  })
})
