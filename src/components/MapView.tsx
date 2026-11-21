import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap, StyleSpecification } from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre runs map work in a web worker; bundlers need to be told where its file lives.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { MAP_STYLES, PILOT_CITY, type MapStyleId } from '../config'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { cleanStyle } from '../lib/cleanStyle'
import { renameExpression } from '../lib/placeNames'
import { dashedFilter, NE_BORDERS_URL, solidFilter, type WorldviewCode } from '../lib/worldview'
import { bboxOf, distanceMeters } from '../lib/geo'
import type { AccessData } from '../lib/overpass'
import { CATEGORIES, CATEGORY_BY_ID, type NearbyPlace } from '../lib/places'
import { REPORT_LABELS } from '../lib/types'
import type { LngLat, Report, RouteResult } from '../lib/types'
import { timeAgo } from '../lib/reports'

export interface Layers {
  restrooms: boolean
  lighting: boolean
  reports: boolean
  obstacles: boolean
}

interface Props {
  access: AccessData | null
  reports: Report[]
  route: RouteResult | null
  from: LngLat | null
  to: LngLat | null
  /** Stops along the way, in order. */
  stops: LngLat[]
  layers: Layers
  flyTo: LngLat | null
  places: NearbyPlace[]
  selectedPlaceId: string | null
  myLocation: LngLat | null
  myAccuracy: number | null
  /** Keep the camera centered on myLocation as it moves. */
  follow: boolean
  /** The visitor dragged or zoomed the map themselves. */
  onUserMove: () => void
  /** Show country borders as this country officially sees them; null = as on the ground (OpenStreetMap). */
  worldview: WorldviewCode | null
  /** Whose place names to show (e.g. US: "Gulf of America"); null = neutral. */
  nameView: string | null
  mapStyle: MapStyleId
  /** Units for the scale bar. */
  units: 'km' | 'mi'
  /** Points the camera should frame, e.g. a list of nearby results. */
  fitTo: { points: LngLat[]; key: number } | null
  onPlaceClick: (id: string) => void
  onMapClick: (p: LngLat) => void
  /** Right-click, or a long press on touch screens: show the "directions to here" menu. */
  onMapContext: (p: LngLat, screen: { x: number; y: number }) => void
  /** A trip pin was dragged: role is 'from', 'to' or the stop's index. */
  onPinDrag: (role: 'from' | 'to' | number, p: LngLat) => void
  onViewChange: (bbox: [number, number, number, number], zoom: number) => void
}

type FC = FeatureCollection
maplibregl.setWorkerUrl(workerUrl)

const empty: FC = { type: 'FeatureCollection', features: [] }
const point = (c: LngLat, props: Record<string, unknown> = {}): Feature => ({
  type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c },
})
const line = (c: LngLat[], props: Record<string, unknown> = {}): Feature => ({
  type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: c },
})

const LAYER_GROUPS: Record<keyof Layers, string[]> = {
  restrooms: ['restrooms'],
  lighting: ['lit', 'unlit'],
  reports: ['reports'],
  obstacles: ['obstacles'],
}

/** Keep the route clear of the side panel (desktop) or bottom sheet (phone). */
function routePadding() {
  if (window.innerWidth <= 720) {
    return { top: 110, bottom: Math.round(window.innerHeight * 0.62) + 20, left: 40, right: 40 }
  }
  return { top: 80, bottom: 60, left: 430, right: 80 }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export function MapView(props: Props) {
  const { access, reports, route, from, to, stops, layers, flyTo, places, selectedPlaceId, myLocation, myAccuracy, follow, fitTo, onPlaceClick, onMapClick, onMapContext, onPinDrag, onViewChange, onUserMove, worldview, nameView, mapStyle, units } = props
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const [ready, setReady] = useState(false)
  const clickRef = useRef(onMapClick)
  const viewRef = useRef(onViewChange)
  const placeClickRef = useRef(onPlaceClick)
  const userMoveRef = useRef(onUserMove)
  const contextRef = useRef(onMapContext)
  const pinDragRef = useRef(onPinDrag)
  useEffect(() => {
    contextRef.current = onMapContext
    pinDragRef.current = onPinDrag
    userMoveRef.current = onUserMove
    placeClickRef.current = onPlaceClick
    clickRef.current = onMapClick
    viewRef.current = onViewChange
  })

  useEffect(() => {
    const el = container.current
    if (!el) return
    let created: MlMap | null = null
    let cancelled = false
    loadBaseStyle(mapStyle).then((style) => {
      if (!cancelled) setup(new maplibregl.Map({ container: el, style, center: PILOT_CITY.center, zoom: PILOT_CITY.zoom }))
    })
    return () => { cancelled = true; created?.remove(); mapRef.current = null }

    function setup(map: MlMap) {
      created = map
      mapRef.current = map
      // Category pins are drawn on demand, so they survive switching the map look.
      map.on('styleimagemissing', (e) => addCategoryIcon(map, e.id))
      map.addControl(new maplibregl.NavigationControl(), 'top-right')
      const scale = new maplibregl.ScaleControl({ unit: unitsRef.current === 'mi' ? 'imperial' : 'metric' })
      scaleRef.current = scale
      map.addControl(scale, 'bottom-right')

      const emitView = () => {
        const b = map.getBounds()
        viewRef.current([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom())
      }

      map.on('load', () => {
        for (const id of ['route', 'restrooms', 'lighting', 'reports', 'obstacles', 'warnings', 'endpoints', 'places', 'me']) {
          map.addSource(id, { type: 'geojson', data: empty })
        }
        map.addLayer({ id: 'lit', type: 'line', source: 'lighting', filter: ['==', ['get', 'lit'], true],
          paint: { 'line-color': '#f5c518', 'line-width': 4, 'line-opacity': 0.7 } })
        map.addLayer({ id: 'unlit', type: 'line', source: 'lighting', filter: ['==', ['get', 'lit'], false],
          paint: { 'line-color': '#3b3b58', 'line-width': 4, 'line-opacity': 0.7, 'line-dasharray': [1, 1] } })
        map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 10 } })
        map.addLayer({ id: 'route', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#1a5fd6', 'line-width': 6 } })
        map.addLayer({ id: 'obstacles', type: 'circle', source: 'obstacles',
          paint: { 'circle-radius': 4, 'circle-color': '#b45309', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } })
        map.addLayer({ id: 'restrooms', type: 'circle', source: 'restrooms',
          paint: {
            'circle-radius': 8,
            'circle-color': ['match', ['get', 'wheelchair'], 'yes', '#15803d', 'limited', '#ca8a04', 'no', '#7c3aed', '#6b7280'],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
          } })
        map.addLayer({ id: 'reports', type: 'circle', source: 'reports',
          paint: { 'circle-radius': 9, 'circle-color': '#dc2626', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
        map.addLayer({ id: 'warnings', type: 'circle', source: 'warnings',
          paint: { 'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ea580c', 'circle-stroke-width': 3 } })
        map.addLayer({ id: 'endpoints', type: 'circle', source: 'endpoints',
          paint: {
            'circle-radius': 9,
            'circle-color': ['match', ['get', 'role'], 'from', '#15803d', 'stop', '#f59e0b', '#1a5fd6'],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 3,
          } })

        map.addLayer({ id: 'places-selected', type: 'circle', source: 'places', filter: ['==', ['get', 'selected'], true],
          paint: { 'circle-radius': 16, 'circle-color': ['get', 'color'], 'circle-opacity': 0.22 } })
        map.addLayer({ id: 'places', type: 'symbol', source: 'places',
          layout: {
            'icon-image': ['concat', 'cat-', ['get', 'category']],
            'icon-size': ['case', ['==', ['get', 'selected'], true], 1.1, 0.8],
            'icon-anchor': 'bottom',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-sort-key': ['case', ['==', ['get', 'selected'], true], 1, 0],
          } })
        // Accuracy halo: meters turned into pixels for the current zoom (2^zoom doubles each level).
        map.addLayer({ id: 'me-halo', type: 'circle', source: 'me',
          paint: {
            'circle-radius': ['interpolate', ['exponential', 2], ['zoom'],
              0, ['max', 14, ['/', ['get', 'acc'], 78271.5]],
              22, ['max', 14, ['/', ['get', 'acc'], 0.0187]]],
            'circle-color': '#1a73e8', 'circle-opacity': 0.15,
            'circle-stroke-color': '#1a73e8', 'circle-stroke-opacity': 0.3, 'circle-stroke-width': 1,
          } })
        map.addLayer({ id: 'me', type: 'circle', source: 'me',
          paint: { 'circle-radius': 7, 'circle-color': '#1a73e8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } })

        map.on('click', 'places', (e) => {
          const id = e.features?.[0]?.properties?.id
          if (id) placeClickRef.current(String(id))
        })

        map.on('click', 'restrooms', (e) => {
          const p = e.features?.[0]?.properties
          if (!p) return
          const accessText = { yes: 'Wheelchair accessible', limited: 'Partly accessible', no: 'Not wheelchair accessible', unknown: 'Accessibility unknown' }[p.wheelchair as string]
          new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
            `<strong>${escapeHtml(p.name)}</strong><br>${accessText}<br>` +
            `${p.fee === 'free' ? 'Free' : p.fee === 'paid' ? 'Paid' : 'Fee unknown'}` +
            `${p.changingTable ? ' · Changing table' : ''}` +
            `${p.openingHours ? `<br>Hours: ${escapeHtml(p.openingHours)}` : ''}`,
          ).addTo(map)
        })
        map.on('click', 'reports', (e) => {
          const p = e.features?.[0]?.properties
          if (!p) return
          new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
            `<strong>${escapeHtml(p.label)}</strong><br>${escapeHtml(p.ago)}${p.note ? `<br>"${escapeHtml(p.note)}"` : ''}`,
          ).addTo(map)
        })
        for (const id of ['restrooms', 'reports', 'places']) {
          map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', id, () => { map.getCanvas().style.cursor = '' })
        }
        setReady(true)
        emitView()
      })

      map.on('click', (e) => {
        const hits = map.getLayer('places') ? map.queryRenderedFeatures(e.point, { layers: ['restrooms', 'reports', 'places'] }) : []
        if (hits.length === 0) clickRef.current([e.lngLat.lng, e.lngLat.lat])
      })
      map.on('contextmenu', (e) => {
        e.preventDefault()
        contextRef.current([e.lngLat.lng, e.lngLat.lat], e.point)
      })
      // Long press on touch screens (MapLibre only reports right-clicks as contextmenu).
      let pressTimer: number | undefined
      let pressStart: { x: number; y: number } | null = null
      map.on('touchstart', (e) => {
        if (e.originalEvent.touches.length !== 1) return
        pressStart = e.point
        const at: LngLat = [e.lngLat.lng, e.lngLat.lat]
        const pt = e.point
        pressTimer = window.setTimeout(() => { pressStart = null; contextRef.current(at, pt) }, 550)
      })
      map.on('touchmove', (e) => {
        if (pressStart && Math.hypot(e.point.x - pressStart.x, e.point.y - pressStart.y) > 8) { window.clearTimeout(pressTimer); pressStart = null }
      })
      map.on('touchend', () => { window.clearTimeout(pressTimer); pressStart = null })
      map.on('touchcancel', () => { window.clearTimeout(pressTimer); pressStart = null })
      map.on('movestart', () => { window.clearTimeout(pressTimer); pressStart = null })

      map.on('moveend', emitView)
      // Only real drags/zooms by the visitor carry an originalEvent; our own camera moves don't.
      map.on('dragstart', (e) => { if (e.originalEvent) userMoveRef.current() })
    }
    // The map is created once; style and borders are changed in place by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Country borders. Base styles draw OpenStreetMap's borders (boundary_2 / boundary_disputed).
  // For a country's worldview we hide those and draw Natural Earth's lines as that country sees them.
  const worldviewRef = useRef(worldview)
  useEffect(() => {
    worldviewRef.current = worldview
    const map = mapRef.current
    if (ready && map) applyBorders(map, worldview)
  }, [worldview, ready])

  const unitsRef = useRef(units)
  const scaleRef = useRef<maplibregl.ScaleControl | null>(null)
  useEffect(() => {
    unitsRef.current = units
    scaleRef.current?.setUnit(units === 'mi' ? 'imperial' : 'metric')
  }, [units])

  const nameViewRef = useRef(nameView)
  useEffect(() => {
    nameViewRef.current = nameView
    const map = mapRef.current
    if (ready && map) applyNames(map, nameView)
  }, [nameView, ready])

  // Switch the base map look, carrying our own layers (places, route, borders...) across.
  const styleRef = useRef(mapStyle)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || styleRef.current === mapStyle) return
    styleRef.current = mapStyle
    const look = mapStyle
    map.setStyle(MAP_STYLES[look].url, {
      transformStyle: (prev, next) => carryOverAppLayers(prev, look === 'clean' ? safeClean(next) : next),
    })
    map.once('style.load', () => {
      ORIGINAL_TEXT.delete(map) // new style, new labels
      applyBorders(map, worldviewRef.current)
      applyNames(map, nameViewRef.current)
    })
  }, [mapStyle, ready])

  const setData = (id: string, data: FC) => {
    const src = mapRef.current?.getSource(id) as GeoJSONSource | undefined
    src?.setData(data)
  }

  useEffect(() => {
    if (!ready) return
    setData('restrooms', { type: 'FeatureCollection', features: (access?.restrooms ?? []).map((r) => point(r.coords, { ...r })) })
    setData('lighting', { type: 'FeatureCollection', features: (access?.lighting ?? []).map((w) => line(w.line, { lit: w.lit })) })
    setData('obstacles', { type: 'FeatureCollection', features: (access?.obstacles ?? []).filter((o) => o.kind !== 'elevator').map((o) => point(o.coords, { kind: o.kind })) })
  }, [access, ready])

  useEffect(() => {
    if (!ready) return
    setData('reports', {
      type: 'FeatureCollection',
      features: reports.map((r) => point(r.coords, { label: REPORT_LABELS[r.type], note: r.note, ago: timeAgo(r.createdAt) })),
    })
  }, [reports, ready])

  useEffect(() => {
    if (!ready) return
    setData('route', route ? { type: 'FeatureCollection', features: [line(route.geometry)] } : empty)
    setData('warnings', {
      type: 'FeatureCollection',
      features: (route?.warnings ?? []).filter((w) => w.coords).map((w) => point(w.coords!)),
    })
    if (route && route.geometry.length > 1) {
      const [w, s, e, n] = bboxOf(route.geometry, 0)
      // Work out the camera with padding, then move without it, so the padding doesn't stick
      // to the map (sticky padding shifts later zooms and can leave parts of the map unpainted).
      const map = mapRef.current
      const cam = map?.cameraForBounds([[w, s], [e, n]], { padding: routePadding(), maxZoom: 17 })
      if (map && cam) map.easeTo({ center: cam.center, zoom: cam.zoom, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } })
    }
  }, [route, ready])

  // Trip pins: start, numbered stops and destination, each draggable to fine-tune the spot.
  const pinMarkers = useRef<maplibregl.Marker[]>([])
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    for (const m of pinMarkers.current) m.remove()
    const pins: { role: 'from' | 'to' | number; at: LngLat }[] = [
      ...(from ? [{ role: 'from' as const, at: from }] : []),
      ...stops.map((at, i) => ({ role: i, at })),
      ...(to ? [{ role: 'to' as const, at: to }] : []),
    ]
    pinMarkers.current = pins.map(({ role, at }) => {
      const el = document.createElement('div')
      el.className = `trip-pin ${role === 'from' ? 'start' : role === 'to' ? 'end' : 'stop'}`
      if (typeof role === 'number') el.textContent = String(role + 1)
      // A drawn pin, not a rotated box: rotating the marker element would also rotate MapLibre's
      // positioning transform and throw the pin off the map.
      if (role === 'to') el.innerHTML = '<svg width="28" height="38" viewBox="0 0 28 38" aria-hidden="true"><path d="M14 37s12-13.2 12-22.5A12 12 0 0 0 2 14.5C2 23.8 14 37 14 37z" fill="#dc2626" stroke="#fff" stroke-width="2"/><circle cx="14" cy="14.5" r="4.5" fill="#fff"/></svg>'
      el.title = role === 'from' ? 'Start (drag to move)' : role === 'to' ? 'Destination (drag to move)' : `Stop ${role + 1} (drag to move)`
      const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: role === 'to' ? 'bottom' : 'center' })
        .setLngLat(at)
        .addTo(map)
      marker.on('dragend', () => {
        const p = marker.getLngLat()
        pinDragRef.current(role, [p.lng, p.lat])
      })
      return marker
    })
  }, [from, to, stops, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    for (const [group, ids] of Object.entries(LAYER_GROUPS)) {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', layers[group as keyof Layers] ? 'visible' : 'none')
    }
  }, [layers, ready])

  useEffect(() => {
    if (!ready) return
    setData('places', {
      type: 'FeatureCollection',
      features: places.map((p) => point(p.coords, {
        id: p.id, category: p.category, color: CATEGORY_BY_ID[p.category]?.color ?? '#1a5fd6', selected: p.id === selectedPlaceId,
      })),
    })
  }, [places, selectedPlaceId, ready])

  useEffect(() => {
    if (!ready) return
    setData('me', myLocation ? { type: 'FeatureCollection', features: [point(myLocation, { acc: myAccuracy ?? 0 })] } : empty)
  }, [myLocation, myAccuracy, ready])

  // Follow the visitor. The first fix jumps straight there (a long animated flight across the
  // country leaves half-loaded tiles behind). After that, only glide when they've really moved,
  // and never interrupt a camera move that's already running: GPS sends small updates every
  // second, and restarting the animation each time stopped tiles from ever finishing loading.
  const lastFollowed = useRef<LngLat | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !myLocation || !follow) return
    const last = lastFollowed.current
    if (!last || distanceMeters(last, myLocation) > 2000) {
      lastFollowed.current = myLocation
      map.jumpTo({ center: myLocation, zoom: Math.max(map.getZoom(), 15) })
      return
    }
    if (map.isMoving() || distanceMeters(last, myLocation) < 8) return
    lastFollowed.current = myLocation
    map.easeTo({ center: myLocation, duration: 500 })
  }, [myLocation, follow, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !fitTo || fitTo.points.length === 0) return
    if (fitTo.points.length === 1) {
      map.easeTo({ center: fitTo.points[0], zoom: 15 })
      return
    }
    const [w, s, e, n] = bboxOf(fitTo.points, 0)
    const cam = map.cameraForBounds([[w, s], [e, n]], { padding: routePadding(), maxZoom: 17 })
    if (cam) map.easeTo({ center: cam.center, zoom: cam.zoom, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } })
  }, [fitTo, ready])

  useEffect(() => {
    if (!flyTo) return
    // On phones the bottom sheet covers the lower part of the map, so aim above it.
    const offset: [number, number] = window.innerWidth <= 720 ? [0, -Math.round(window.innerHeight * 0.28)] : [196, 0]
    mapRef.current?.flyTo({ center: flyTo, zoom: Math.max(mapRef.current.getZoom(), 15), offset })
  }, [flyTo])

  return <div ref={container} className="map" aria-label="Map" />
}

const BASE_BORDER_LAYERS = ['boundary_2', 'boundary_disputed']
const WV_SOURCE = 'ne-borders'
const WV_LAYERS = ['wv-dashed', 'wv-solid']

function firstSymbolLayerId(map: MlMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id
}

function applyBorders(map: MlMap, worldview: WorldviewCode | null) {
  for (const id of BASE_BORDER_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', worldview ? 'none' : 'visible')
  }
  if (!worldview) {
    for (const id of WV_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none')
    return
  }
  if (!map.getSource(WV_SOURCE)) map.addSource(WV_SOURCE, { type: 'geojson', data: NE_BORDERS_URL, attribution: 'Borders: Natural Earth' })
  const width: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 2, 0.8, 5, 1.4, 10, 2.4, 14, 3]
  const color = 'hsl(250, 8%, 42%)'
  const before = firstSymbolLayerId(map) // keep place names on top of the lines
  if (!map.getLayer('wv-dashed')) {
    map.addLayer({ id: 'wv-dashed', type: 'line', source: WV_SOURCE,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width, 'line-dasharray': [2, 2] } }, before)
  }
  if (!map.getLayer('wv-solid')) {
    map.addLayer({ id: 'wv-solid', type: 'line', source: WV_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': width } }, before)
  }
  map.setFilter('wv-dashed', dashedFilter(worldview) as never)
  map.setFilter('wv-solid', solidFilter(worldview) as never)
  for (const id of WV_LAYERS) map.setLayoutProperty(id, 'visibility', 'visible')
}

// Each label layer's own text expression, kept so the name view can be changed again later.
const ORIGINAL_TEXT = new WeakMap<MlMap, Map<string, unknown>>()

/** Show renamed places (see placeNames.ts) the way this country's view names them. */
function applyNames(map: MlMap, nameView: string | null) {
  let originals = ORIGINAL_TEXT.get(map)
  if (!originals) {
    originals = new Map()
    for (const l of map.getStyle().layers) {
      const field = l.type === 'symbol' ? l.layout?.['text-field'] : undefined
      // Only map labels that read a name; skip road numbers and our own layers.
      if (field && JSON.stringify(field).includes('"name')) originals.set(l.id, field)
    }
    ORIGINAL_TEXT.set(map, originals)
  }
  for (const [id, field] of originals) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'text-field', renameExpression(field, nameView) as never)
  }
}

const APP_SOURCES = ['route', 'restrooms', 'lighting', 'reports', 'obstacles', 'warnings', 'endpoints', 'places', 'me', WV_SOURCE]

/** Keep our sources and layers when the base style changes: borders under labels, the rest on top. */
function carryOverAppLayers(prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
  if (!prev) return next
  const sources = { ...next.sources }
  for (const id of APP_SOURCES) if (prev.sources[id]) sources[id] = prev.sources[id]
  const ours = prev.layers.filter((l) => 'source' in l && APP_SOURCES.includes(l.source as string))
  const borders = ours.filter((l) => WV_LAYERS.includes(l.id))
  const rest = ours.filter((l) => !WV_LAYERS.includes(l.id))
  const firstSymbol = next.layers.findIndex((l) => l.type === 'symbol')
  const layers = firstSymbol < 0
    ? [...next.layers, ...borders, ...rest]
    : [...next.layers.slice(0, firstSymbol), ...borders, ...next.layers.slice(firstSymbol), ...rest]
  return { ...next, sources, layers }
}

/** The style to open with: a URL, or for our own Clean look the restyled style JSON. */
async function loadBaseStyle(look: MapStyleId): Promise<string | StyleSpecification> {
  const url = MAP_STYLES[look].url
  if (look !== 'clean') return url
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    const style = cleanStyle(await res.json())
    // Never let a restyle mistake blank the whole map: fall back to the plain style.
    const errors = validateStyleMin(style)
    if (errors.length) throw new Error(errors[0].message)
    return style
  } catch {
    return url // still show a map if the restyle can't be prepared
  }
}

function safeClean(style: StyleSpecification): StyleSpecification {
  const styled = cleanStyle(style)
  return validateStyleMin(styled).length ? style : styled
}

/** A map pin in the category's color with its icon, drawn at 2x for sharp screens. */
function addCategoryIcon(map: MlMap, id: string) {
  if (!id.startsWith('cat-') || map.hasImage(id)) return
  const cat = CATEGORIES.find((c) => `cat-${c.id}` === id)
  const w = 72, h = 88, r = 32, cx = w / 2, cy = r + 4
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.shadowColor = 'rgba(0,0,0,0.3)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 2
  ctx.beginPath()
  ctx.arc(cx, cy, r, Math.PI * 0.8, Math.PI * 2.2)
  ctx.lineTo(cx, h - 3)
  ctx.closePath()
  ctx.fillStyle = cat?.color ?? '#1a5fd6'
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = 4
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(cx, cy, r - 8, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.font = '30px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(cat?.icon ?? '📍', cx, cy + 2)
  map.addImage(id, ctx.getImageData(0, 0, w, h), { pixelRatio: 2 })
}
