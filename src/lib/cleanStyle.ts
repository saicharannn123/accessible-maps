import type { StyleSpecification } from 'maplibre-gl'

// BM Locator's own "Clean" look, built on top of OpenFreeMap's Liberty style (free OpenStreetMap
// vector tiles). We keep Liberty's data layers, icons and road shields and only restyle them:
// light gray land, soft green parks and woods, clear blue water, white local roads with light
// casings, warm amber highways, flat buildings, and quiet, readable labels.

const C = {
  land: '#f3f3f0',
  residential: '#ecebe7',
  park: '#cfead5',
  wood: '#d6eedb',
  grass: '#dcf0de',
  wetland: '#d6ebe2',
  ice: '#f7fafc',
  sand: '#f3eedd',
  water: '#a8d5f2',
  waterLabel: '#3b7fb6',
  hospital: '#f9e1e1',
  school: '#f2ecdf',
  cemetery: '#dcebdc',
  building: '#e3e1dc',
  buildingLine: '#d6d3cd',
  minor: '#ffffff',
  minorCase: '#dcdfe3',
  secondary: '#ffffff',
  secondaryCase: '#cfd3d8',
  primary: '#fde7a8',
  primaryCase: '#e9c96c',
  motorway: '#f8c46a',
  motorwayCase: '#dd9f3c',
  path: '#c9cfc6',
  rail: '#c3c6cc',
  text: '#3c4043',
  textSoft: '#6b6f74',
  halo: 'rgba(255,255,255,0.95)',
}

type Layer = StyleSpecification['layers'][number]

function paint(layer: Layer, props: Record<string, unknown>) {
  layer.paint = { ...(layer.paint ?? {}), ...props } as Layer['paint']
}
function hide(layer: Layer) {
  layer.layout = { ...(layer.layout ?? {}), visibility: 'none' } as Layer['layout']
}

export function cleanStyle(style: StyleSpecification): StyleSpecification {
  const s: StyleSpecification = JSON.parse(JSON.stringify(style))
  for (const l of s.layers) {
    const id = l.id
    if (id === 'background') paint(l, { 'background-color': C.land })
    else if (id === 'natural_earth' || id === 'building-3d' || id === 'park_outline' || id === 'road_area_pattern') hide(l)
    else if (id === 'park') paint(l, { 'fill-color': C.park, 'fill-opacity': 1 })
    else if (id === 'landuse_residential') paint(l, { 'fill-color': C.residential, 'fill-opacity': 0.7 })
    else if (id === 'landcover_wood') paint(l, { 'fill-color': C.wood, 'fill-opacity': 1 })
    else if (id === 'landcover_grass' || id === 'landuse_pitch' || id === 'landuse_track') paint(l, { 'fill-color': C.grass, 'fill-opacity': 1 })
    else if (id === 'landcover_wetland') paint(l, { 'fill-color': C.wetland, 'fill-opacity': 1 })
    else if (id === 'landcover_ice') paint(l, { 'fill-color': C.ice, 'fill-opacity': 1 })
    else if (id === 'landcover_sand') paint(l, { 'fill-color': C.sand, 'fill-opacity': 1 })
    else if (id === 'landuse_hospital') paint(l, { 'fill-color': C.hospital })
    else if (id === 'landuse_school') paint(l, { 'fill-color': C.school })
    else if (id === 'landuse_cemetery') paint(l, { 'fill-color': C.cemetery })
    else if (id === 'water') paint(l, { 'fill-color': C.water })
    else if (id.startsWith('waterway')) paint(l, { 'line-color': C.water })
    else if (id === 'building') paint(l, { 'fill-color': C.building, 'fill-outline-color': C.buildingLine })
    else if (l.type === 'line' && /^(road|bridge|tunnel)_/.test(id)) {
      const casing = id.endsWith('_casing')
      let color: string | null = null
      if (/motorway/.test(id)) color = casing ? C.motorwayCase : C.motorway
      else if (/trunk_primary/.test(id)) color = casing ? C.primaryCase : C.primary
      else if (/secondary_tertiary/.test(id)) color = casing ? C.secondaryCase : C.secondary
      else if (/(minor|street|link|service_track)/.test(id)) color = casing ? C.minorCase : C.minor
      else if (/path_pedestrian/.test(id)) color = C.path
      else if (/rail/.test(id)) color = C.rail
      if (color) paint(l, { 'line-color': color })
    } else if (l.type === 'symbol') {
      const halo = { 'text-halo-color': C.halo, 'text-halo-width': 1.6, 'text-halo-blur': 0.3 }
      if (id.startsWith('water') ) paint(l, { 'text-color': C.waterLabel, ...halo })
      else if (id === 'label_other') {
        // Neighborhoods: small, spaced capitals, like a printed street atlas.
        paint(l, { 'text-color': C.textSoft, ...halo })
        l.layout = { ...(l.layout ?? {}), 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 } as Layer['layout']
      } else if (id.startsWith('label_') || id === 'airport') paint(l, { 'text-color': C.text, ...halo })
      else if (id.startsWith('highway-name')) paint(l, { 'text-color': C.textSoft, ...halo })
    }
  }
  return s
}
