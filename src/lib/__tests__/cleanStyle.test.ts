import { describe, expect, it } from 'vitest'
import type { StyleSpecification } from 'maplibre-gl'
import { cleanStyle } from '../cleanStyle'

const base = {
  version: 8,
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000' } },
    { id: 'natural_earth', type: 'raster', source: 'ne' },
    { id: 'water', type: 'fill', source: 'v', 'source-layer': 'water', paint: { 'fill-color': '#000' } },
    { id: 'road_motorway_casing', type: 'line', source: 'v', 'source-layer': 'transportation', paint: { 'line-color': '#000', 'line-width': 3 } },
    { id: 'road_minor', type: 'line', source: 'v', 'source-layer': 'transportation', paint: { 'line-color': '#000' } },
    { id: 'label_other', type: 'symbol', source: 'v', 'source-layer': 'place', layout: { 'text-field': '{name}' } },
  ],
} as unknown as StyleSpecification

describe('cleanStyle', () => {
  it('restyles without touching the input', () => {
    const out = cleanStyle(base)
    const byId = Object.fromEntries(out.layers.map((l) => [l.id, l as unknown as { paint?: Record<string, unknown>; layout?: Record<string, unknown> }]))
    expect(byId.background.paint?.['background-color']).toBe('#f3f3f0')
    expect(byId.natural_earth.layout?.visibility).toBe('none')
    expect(byId.water.paint?.['fill-color']).toBe('#a8d5f2')
    expect(byId.road_motorway_casing.paint).toEqual({ 'line-color': '#dd9f3c', 'line-width': 3 })
    expect(byId.road_minor.paint?.['line-color']).toBe('#ffffff')
    expect(byId.label_other.layout?.['text-transform']).toBe('uppercase')
    expect(byId.label_other.layout?.['text-field']).toBe('{name}')
    expect((base.layers[0] as unknown as { paint: Record<string, string> }).paint['background-color']).toBe('#000')
  })
})
