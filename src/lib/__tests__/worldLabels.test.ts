import { describe, expect, it } from 'vitest'
import type { StyleSpecification } from 'maplibre-gl'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { CONTINENT_LAYER, EXTRA_OCEANS, OCEAN_LAYER, nearestSouthernOcean, withWorldLabels } from '../worldLabels'

const base: StyleSpecification = {
  version: 8,
  glyphs: 'https://example.com/{fontstack}/{range}.pbf',
  sources: { openmaptiles: { type: 'vector', url: 'https://example.com/tiles' } },
  layers: [
    { id: 'bg', type: 'background' },
    { id: 'water_name_point_label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'water_name', layout: { 'text-field': '{name}', 'text-font': ['Noto Sans Italic'] }, paint: { 'text-color': '#1f6f8b' } },
    { id: 'label_country_1', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': '{name}', 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': '#2b2350' } },
  ],
}

describe('world labels', () => {
  it('adds continents and missing oceans on top of the base labels, as a valid style', () => {
    const s = withWorldLabels(base)
    expect(s.layers.map((l) => l.id).slice(-2)).toEqual([OCEAN_LAYER, CONTINENT_LAYER])
    expect(validateStyleMin(s)).toEqual([])
    expect(withWorldLabels(s).layers.length).toBe(s.layers.length) // only once
  })

  it('includes Antarctica and the Southern, Indian and Arctic Oceans', () => {
    const s = withWorldLabels(base)
    expect(JSON.stringify(s.layers.find((l) => l.id === CONTINENT_LAYER))).toContain('Antarctica')
    const names = new Set(EXTRA_OCEANS.map(([n]) => n))
    expect([...names].sort()).toEqual(['Arctic Ocean', 'Indian Ocean', 'Southern Ocean'])
    // Southern Ocean points sit south of 60° S, but north of the Antarctic coast.
    for (const [n, , lat] of EXTRA_OCEANS) if (n === 'Southern Ocean') expect(lat < -60 && lat > -65).toBe(true)
  })

  it('leaves a style without map data alone', () => {
    const plain: StyleSpecification = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background' }] }
    expect(withWorldLabels(plain)).toBe(plain)
  })
})

describe('Southern Ocean label', () => {
  it('shows the spot on the side of Antarctica in view', () => {
    const i = nearestSouthernOcean(-70, -40) // looking at South America
    expect(EXTRA_OCEANS[i]).toEqual(['Southern Ocean', -90, -62])
    const j = nearestSouthernOcean(140, -45) // looking at Australia
    expect(EXTRA_OCEANS[j]).toEqual(['Southern Ocean', 150, -62])
    expect(EXTRA_OCEANS[nearestSouthernOcean(179, -60)][1]).toBe(150)
    expect(EXTRA_OCEANS[nearestSouthernOcean(-179, -60)][1]).toBe(-150) // across the date line
  })
})
