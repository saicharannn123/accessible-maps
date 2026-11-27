import type { ExpressionSpecification, LayerSpecification, StyleSpecification, SymbolLayerSpecification } from 'maplibre-gl'

/**
 * Big names for the zoomed-out globe: continents and oceans.
 *
 * The OpenMapTiles data behind every map look already carries the continents (OpenStreetMap
 * place=continent points), but none of the published styles draws them, so Antarctica, Africa,
 * Asia… never got a label. We draw them from that same data, in English, so spelling and
 * placement follow OpenStreetMap. Oceans come from the tiles' water names too, but those only
 * have the North/South Atlantic and Pacific; the Indian, Southern and Arctic Oceans are added
 * here as open-water points inside each ocean's limits (IHO "Limits of Oceans and Seas"; the
 * Southern Ocean is south of 60° S, so it gets a ring of spots and shows the one nearest the middle of the view).
 *
 * These layers go last in the base style so they win when names would overlap; MapLibre's globe
 * keeps them upright, anchored to their spot, and hides the ones on the far side.
 */

export const CONTINENT_LAYER = 'bm-label-continent'
export const OCEAN_LAYER = 'bm-label-ocean'
export const OCEAN_SOURCE = 'bm-oceans'

/** Continents as OpenStreetMap tags them. Australia is left out: its country label already says it. */
export const CONTINENTS = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'South America'] as const

/** Oceans the tiles don't name, as [name, lng, lat]. */
export const EXTRA_OCEANS: [string, number, number][] = [
  ['Indian Ocean', 80, -25],
  ['Arctic Ocean', 0, 88],
  // The Southern Ocean circles Antarctica, so it has spots all round; only one shows at a time.
  ...[-150, -90, -30, 30, 90, 150].map((lng): [string, number, number] => ['Southern Ocean', lng, -62]),
]

const RAD = Math.PI / 180

/** Which Southern Ocean spot to show: the one closest to the middle of the view. */
export function nearestSouthernOcean(lng: number, lat: number): number {
  let best = -1, bestCos = -2
  EXTRA_OCEANS.forEach(([name, plng, plat], i) => {
    if (name !== 'Southern Ocean') return
    const c = Math.sin(lat * RAD) * Math.sin(plat * RAD) + Math.cos(lat * RAD) * Math.cos(plat * RAD) * Math.cos((lng - plng) * RAD)
    if (c > bestCos) { bestCos = c; best = i }
  })
  return best
}

/** Filter for the ocean layer that shows every ocean once. */
export function oceanFilter(southernIndex: number): ExpressionSpecification {
  return ['any', ['!=', ['get', 'name'], 'Southern Ocean'], ['==', ['get', 'i'], southernIndex]]
}

const englishName: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']]

function findLayer(style: StyleSpecification, ids: string[]): SymbolLayerSpecification | undefined {
  for (const id of ids) {
    const l = style.layers.find((x) => x.id === id)
    if (l && l.type === 'symbol') return l
  }
  return style.layers.find((x): x is SymbolLayerSpecification => x.type === 'symbol' && x['source-layer'] === 'place')
}

function vectorSource(style: StyleSpecification): string | null {
  const place = style.layers.find((l) => 'source-layer' in l && l['source-layer'] === 'place')
  return place && 'source' in place ? place.source : null
}

/** Add the continent and ocean labels to a base style (once). */
export function withWorldLabels(style: StyleSpecification): StyleSpecification {
  if (style.layers.some((l) => l.id === CONTINENT_LAYER)) return style
  const src = vectorSource(style)
  if (!src) return style
  const country = findLayer(style, ['label_country_1', 'place-country-1', 'country_label'])
  const water = style.layers.find((l): l is SymbolLayerSpecification => l.type === 'symbol' && l['source-layer'] === 'water_name')
  const textColor = (country?.paint?.['text-color'] as string | undefined) ?? '#2b2350'
  const halo = {
    'text-halo-color': (country?.paint?.['text-halo-color'] as string | undefined) ?? 'rgba(255,255,255,0.96)',
    'text-halo-width': 1.6,
    'text-halo-blur': 0.3,
  }
  const boldFont = country?.layout?.['text-font'] ?? ['Noto Sans Bold']
  const italicFont = water?.layout?.['text-font'] ?? ['Noto Sans Italic']

  const oceans: LayerSpecification = {
    id: OCEAN_LAYER, type: 'symbol', source: OCEAN_SOURCE, maxzoom: 6,
    filter: oceanFilter(nearestSouthernOcean(0, 0)),
    layout: {
      'text-field': englishName,
      'text-font': italicFont,
      'text-size': ['interpolate', ['linear'], ['zoom'], 0, 11, 3, 13, 6, 15],
      'text-letter-spacing': 0.2,
      'text-max-width': 6,
      'text-padding': 6,
    },
    paint: {
      'text-color': (water?.paint?.['text-color'] as string | undefined) ?? '#1f6f8b',
      ...halo,
    },
  }
  const continents: LayerSpecification = {
    id: CONTINENT_LAYER, type: 'symbol', source: src, 'source-layer': 'place', maxzoom: 3.5,
    filter: ['all', ['==', ['get', 'class'], 'continent'], ['in', englishName, ['literal', [...CONTINENTS]]]],
    layout: {
      'text-field': englishName,
      'text-font': boldFont,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.18,
      'text-size': ['interpolate', ['linear'], ['zoom'], 0, 11, 2, 14, 3.5, 16],
      'text-max-width': 8,
      'text-padding': 8,
    },
    // Fades out as the countries take over.
    paint: { 'text-color': textColor, ...halo, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 2.8, 1, 3.5, 0] },
  }
  return {
    ...style,
    sources: {
      ...style.sources,
      [OCEAN_SOURCE]: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: EXTRA_OCEANS.map(([name, lng, lat], i) => ({
            type: 'Feature', properties: { name, 'name:en': name, name_en: name, class: 'ocean', i },
            geometry: { type: 'Point', coordinates: [lng, lat] },
          })),
        },
      },
    },
    // Last in the base style = placed first, so these beat country and city names when they collide.
    layers: [...style.layers, oceans, continents],
  }
}
