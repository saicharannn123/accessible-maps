import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerCache, fetchJson, nominatimPlaces, osmNearbyQuery, osmPlaces } from '../sources'
import { searchAll, SearchOfflineError } from '../geocode'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const TEWKSBURY: [number, number] = [-71.234, 42.61]

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchJson', () => {
  it('retries a busy server, then succeeds', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ ok: 1 }))
    vi.stubGlobal('fetch', fetch)
    expect(await fetchJson('https://a.test/x', {}, { tries: 2 })).toEqual({ ok: 1 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("doesn't retry a plain 'no'", async () => {
    const fetch = vi.fn().mockResolvedValue(json({}, 400))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchJson('https://a.test/x', {}, { tries: 3 })).rejects.toThrow('400')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('backup sources', () => {
  it('reads Nominatim rows', () => {
    const [p] = nominatimPlaces([{
      lat: '42.6', lon: '-71.2', name: 'Bay State Badminton', display_name: 'Bay State Badminton, Main St, Tewksbury',
      address: { house_number: '5', road: 'Main St', town: 'Tewksbury', state: 'Massachusetts' },
    }], undefined)
    expect(p).toEqual({ name: 'Bay State Badminton', detail: '5 Main St, Tewksbury, Massachusetts', coords: [-71.2, 42.6] })
  })

  it('asks OSM for a sport inside a box around you', () => {
    const q = osmNearbyQuery({ sport: 'badminton' }, TEWKSBURY)
    expect(q).toContain('Key:sport')
    expect(q).toContain('"badminton"')
    expect(q).toContain('geof:latitude(?wkt) >= 42.3600')
  })

  it('sorts OSM places nearest first', () => {
    const v = (value: string) => ({ value })
    const rows = [
      { o: v('w/1'), name: v('Far Club'), c: v('POINT(-71.0 42.7)'), street: undefined, num: undefined, city: undefined },
      { o: v('w/2'), name: v('Near Club'), c: v('POINT(-71.23 42.61)'), street: v('Main St'), num: v('5'), city: v('Tewksbury') },
    ]
    const ps = osmPlaces(rows, TEWKSBURY, '🏸')
    expect(ps.map((p) => p.name)).toEqual(['Near Club', 'Far Club'])
    expect(ps[0].detail).toContain('5 Main St, Tewksbury')
  })

  it('caches answers and keeps stale ones for emergencies', () => {
    const c = new AnswerCache<number>(-1)
    c.set('a', 1)
    expect(c.get('a')).toBeUndefined()
    expect(c.stale('a')).toBe(1)
  })
})

describe('search never dead-ends', () => {
  it('falls back to Nominatim when Photon is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('photon')) return json({}, 503)
      if (url.includes('nominatim')) return json([{ lat: '42.61', lon: '-71.23', name: 'Fallback Hall', display_name: 'Fallback Hall' }])
      return json({}, 503)
    }))
    const r = await searchAll('fallback hall test', undefined, TEWKSBURY)
    expect(r.places[0]?.name).toBe('Fallback Hall')
  })

  it('says offline only when every source fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(searchAll('nothing works here', undefined, TEWKSBURY)).rejects.toBeInstanceOf(SearchOfflineError)
  })
})
