import { describe, expect, it } from 'vitest'
import type { StyleSpecification } from 'maplibre-gl'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { cleanStyle, signatureStyle } from '../cleanStyle'

const base = {
  version: 8,
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000' } },
    { id: 'natural_earth', type: 'raster', source: 'ne' },
    { id: 'water', type: 'fill', source: 'v', 'source-layer': 'water', paint: { 'fill-color': '#000' } },
    { id: 'road_motorway_casing', type: 'line', source: 'v', 'source-layer': 'transportation', paint: { 'line-color': '#000', 'line-width': 3 } },
    { id: 'road_minor', type: 'line', source: 'v', 'source-layer': 'transportation', paint: { 'line-color': '#000' } },
    { id: 'waterway_river', type: 'line', source: 'v', 'source-layer': 'waterway' },
    { id: 'waterway_line_label', type: 'symbol', source: 'v', 'source-layer': 'waterway' },
    { id: 'road_path_pedestrian', type: 'line', source: 'v', 'source-layer': 'transportation', paint: { 'line-color': '#000' } },
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
    expect(byId.waterway_river.paint?.['line-color']).toBe('#a8d5f2')
    // Symbol layers only take text/icon paint properties; a line-color there breaks the whole map.
    expect(byId.waterway_line_label.paint?.['line-color']).toBeUndefined()
    expect(validateStyleMin({ ...out, sources: { v: { type: 'vector', url: 'x' }, ne: { type: 'raster', url: 'y' } } })).toEqual([])
    expect(byId.label_other.layout?.['text-transform']).toBe('uppercase')
    expect(byId.label_other.layout?.['text-field']).toBe('{name}')
    expect((base.layers[0] as unknown as { paint: Record<string, string> }).paint['background-color']).toBe('#000')
  })
})

describe('signatureStyle', () => {
  it('uses its own palette and highlights walkways', () => {
    const out = signatureStyle(base)
    const byId = Object.fromEntries(out.layers.map((l) => [l.id, l as unknown as { paint?: Record<string, unknown> }]))
    expect(byId.background.paint?.['background-color']).toBe('#f4f1fb')
    expect(byId.road_motorway_casing.paint?.['line-color']).toBe('#7a5cf0')
    expect(byId.road_path_pedestrian.paint?.['line-color']).toBe('#14b8a6')
    expect(byId.road_path_pedestrian.paint?.['line-dasharray']).toEqual([1.5, 1])
    expect(validateStyleMin({ ...out, sources: { v: { type: 'vector', url: 'x' }, ne: { type: 'raster', url: 'y' } } })).toEqual([])
  })
})
