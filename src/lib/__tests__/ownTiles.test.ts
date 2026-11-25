import { describe, expect, it } from 'vitest'
import type { StyleSpecification } from 'maplibre-gl'
import { tileBounds, tileInside, withOwnTiles, type Coverage } from '../ownTiles'

const nj: Coverage = { bounds: [-75.6, 38.9, -73.9, 41.4], minZoom: 0, maxZoom: 14 }

describe('own map tiles', () => {
  it('works out tile corners', () => {
    expect(tileBounds(0, 0, 0)[0]).toBe(-180)
    expect(tileBounds(0, 0, 0)[2]).toBe(180)
    expect(tileBounds(1, 1, 0)[1]).toBeCloseTo(0)
  })

  it('serves only tiles fully inside our coverage', () => {
    // Livingston, NJ at zoom 14 is inside; the whole-world tile and Paris are not.
    const x = Math.floor(((-74.315 + 180) / 360) * 2 ** 14)
    const lat = (40.796 * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * 2 ** 14)
    expect(tileInside(14, x, y, nj)).toBe(true)
    expect(tileInside(0, 0, 0, nj)).toBe(false)
    expect(tileInside(14, 8296, 5636, nj)).toBe(false)
    expect(tileInside(14, x, y, null)).toBe(false)
  })

  it('points the OpenMapTiles source at our tiles with an OSM credit', () => {
    const style = {
      version: 8,
      sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
      layers: [],
    } as StyleSpecification
    const out = withOwnTiles(style)
    const src = out.sources.openmaptiles as { tiles: string[]; attribution: string }
    expect(src.tiles[0]).toBe('bmtiles://{z}/{x}/{y}?fallback=https%3A%2F%2Ftiles.openfreemap.org%2Fplanet')
    expect(src.attribution).toContain('© OpenStreetMap contributors')
    expect(withOwnTiles(out)).toBe(out)
  })
})
