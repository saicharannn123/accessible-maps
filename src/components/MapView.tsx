import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap, StyleSpecification } from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre runs map work in a web worker; bundlers need to be told where its file lives.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { MAP_STYLES, PILOT_CITY, type MapStyleId } from '../config'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { cleanStyle, signatureStyle } from '../lib/cleanStyle'
import { SIGNAL_MIN_ZOOM, type Signal } from '../lib/signals'
import type { FamousPlace } from '../lib/famous'
import { GROUP_LOOK, type RelatedSpot } from '../lib/related'
import { renameExpression } from '../lib/placeNames'
import { dashedFilter, NE_BORDERS_URL, solidFilter, type WorldviewCode } from '../lib/worldview'
import { bboxOf, distanceMeters } from '../lib/geo'
import type { AccessData } from '../lib/overpass'
import { CATEGORIES, CATEGORY_BY_ID, type NearbyPlace } from '../lib/places'
import { REPORT_LABELS } from '../lib/types'
import type { LngLat, Report, RouteResult } from '../lib/types'
import { timeAgo } from '../lib/reports'
import { markerHtml, ROTATES, type DrawnMarker } from '../lib/marker'
import { bearingDeg } from '../lib/navigation'
import { registerOwnTiles, withOwnTiles } from '../lib/ownTiles'
import { attachGlobeSpin } from '../lib/globeSpin'
import { OCEAN_LAYER, nearestSouthernOcean, oceanFilter, withWorldLabels } from '../lib/worldLabels'

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
  /** Move the camera here; keepZoom leaves the zoom as it is (e.g. after tapping the map). */
  flyTo: { at: LngLat; keepZoom?: boolean; zoom?: number } | null
  /** Traffic lights and pedestrian crossing lights, shown when zoomed in. */
  signals: Signal[]
  /** Well-known places for the country or region in view. */
  famous: FamousPlace[]
  onFamousClick: (p: FamousPlace) => void
  /** A plain red pin: the place picked in search, or where a report goes. */
  markPin: LngLat | null
  /** Name shown under the pin when it is the selected place; the pin is then drawn highlighted. */
  markLabel?: string | null
  /** Spots related to the selected place, drawn with their own icons. */
  related?: RelatedSpot[]
  /** The related spot picked in the list or on the map, drawn larger with a halo. */
  activeRelatedId?: string | null
  onRelatedClick?: (id: string) => void
  /** A place is selected: fade the other pins (famous places, category results) so its related spots stand out. */
  dimOthers?: boolean
  /** Tapping the map drops a pin, so show a crosshair cursor. */
  pickMode: boolean
  places: NearbyPlace[]
  selectedPlaceId: string | null
  myLocation: LngLat | null
  myAccuracy: number | null
  /** Keep the camera centered on myLocation as it moves. */
  follow: boolean
  /** Turn-by-turn mode: close-up camera that points the way you're heading. */
  navigating?: boolean
  /** Direction of the route ahead while navigating, in degrees. */
  navBearing?: number
  /** How to draw your own position. */
  marker?: DrawnMarker
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
  /** Pins from the open map in My Maps. */
  myPins?: MyPin[]
  /** The My Maps pin that's highlighted. */
  myPinFocus?: string | null
  onMyPinClick?: (id: string) => void
  /** A custom pin was dragged to a new spot. */
  onMyPinDrag?: (id: string, p: LngLat) => void
}

export interface MyPin {
  id: string
  coords: LngLat
  color: string
  title: string
  icon?: string
  /** Your own pins can be dragged; saved places stay where the map data has them. */
  draggable: boolean
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
  // Phones: the sheet and the dock cover the bottom. Wider screens: the panel sits on the right.
  if (window.innerWidth <= 720) {
    return { top: 110, bottom: Math.round(window.innerHeight * 0.62) + 90, left: 40, right: 40 }
  }
  return { top: 90, bottom: 110, left: 80, right: 440 }
}

/** How long the marker takes to glide from one GPS fix to the next (phones report about once a second). */
const GLIDE_MS = 1000

/**
 * Move the position marker smoothly to a new fix and turn it the short way round, so a car or
 * arrow drives along instead of jumping. Big jumps (a first fix, a GPS glitch) snap straight there.
 */
function glideMarker(m: maplibregl.Marker, to: LngLat, toRot: number, state: { current: { raf: number } }) {
  cancelAnimationFrame(state.current.raf)
  const fromLL = m.getLngLat()
  const from: LngLat = [fromLL.lng, fromLL.lat]
  const fromRot = m.getRotation()
  const turn = ((toRot - fromRot + 540) % 360) - 180
  if (distanceMeters(from, to) > 300 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    m.setLngLat(to); m.setRotation(toRot); return
  }
  const start = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / GLIDE_MS)
    // Rotation eases quickly at first so turns feel responsive; position moves at a steady speed
    // to match the camera, which follows linearly over the same time.
    const r = 1 - (1 - t) * (1 - t)
    m.setLngLat([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t])
    m.setRotation(fromRot + turn * r)
    if (t < 1) state.current.raf = requestAnimationFrame(step)
  }
  state.current.raf = requestAnimationFrame(step)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export function MapView(props: Props) {
  const { related = [], activeRelatedId = null, onRelatedClick, dimOthers = false, markLabel = null } = props
  const { access, reports, route, from, to, stops, layers, flyTo, markPin, pickMode, signals, famous, onFamousClick, places, selectedPlaceId, myLocation, myAccuracy, follow, navigating = false, navBearing = 0, marker = 'dot', fitTo, onPlaceClick, onMapClick, onMapContext, onPinDrag, onViewChange, onUserMove, worldview, nameView, mapStyle, units, myPins, myPinFocus = null } = props
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const [ready, setReady] = useState(false)
  const clickRef = useRef(onMapClick)
  const viewRef = useRef(onViewChange)
  const placeClickRef = useRef(onPlaceClick)
  const userMoveRef = useRef(onUserMove)
  const contextRef = useRef(onMapContext)
  const pinDragRef = useRef(onPinDrag)
  const famousClickRef = useRef(onFamousClick)
  const famousRef = useRef(famous)
  const myPinClickRef = useRef(props.onMyPinClick)
  const myPinDragRef = useRef(props.onMyPinDrag)
  const relatedClickRef = useRef(onRelatedClick)
  useEffect(() => {
    myPinClickRef.current = props.onMyPinClick
    myPinDragRef.current = props.onMyPinDrag
    relatedClickRef.current = onRelatedClick
    contextRef.current = onMapContext
    pinDragRef.current = onPinDrag
    famousClickRef.current = onFamousClick
    famousRef.current = famous
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
    registerOwnTiles()
    loadBaseStyle(mapStyle).then((style) => {
      if (!cancelled) setup(new maplibregl.Map({
        container: el, style, center: PILOT_CITY.center, zoom: PILOT_CITY.zoom, maxZoom: 20,
        // The data credit lives behind the small ⓘ button; tapping it shows the full line.
        attributionControl: { compact: true, customAttribution: 'BM Locator' },
        // Smooth zooming: keep loading tiles mid-zoom (no blank patches), keep more nearby zoom
        // levels cached, fade labels in quickly, and cap the pixel ratio so big screens stay fast.
        cancelPendingTileRequestsWhileZooming: false,
        maxTileCacheZoomLevels: 8,
        fadeDuration: 120,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      }))
    })
    let detachSpin: (() => void) | null = null
    return () => { cancelled = true; detachSpin?.(); created?.remove(); mapRef.current = null }

    function setup(map: MlMap) {
      created = map
      mapRef.current = map
      // Category pins are drawn on demand, so they survive switching the map look.
      map.on('styleimagemissing', (e) => { addCategoryIcon(map, e.id); addSignalIcon(map, e.id); addFamousIcon(map, e.id); addRelatedIcon(map, e.id) })
      // Zoomed out, the map is a round 3D globe floating in violet space; zooming in flattens it
      // to the normal street map. Re-applied on every style load so switching looks keeps it.
      map.on('style.load', () => applyGlobe(map))
      map.addControl(new maplibregl.NavigationControl(), 'top-right')
      // MapLibre opens the compact credit once at start; fold it back to the ⓘ button.
      const foldCredit = () => map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show')
      map.once('load', foldCredit)
      map.once('idle', foldCredit)
      const scale = new maplibregl.ScaleControl({ unit: unitsRef.current === 'mi' ? 'imperial' : 'metric' })
      scaleRef.current = scale
      map.addControl(scale, 'bottom-right')

      const emitView = () => {
        const b = map.getBounds()
        viewRef.current([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom())
      }

      map.on('load', () => {
        for (const id of ['route', 'restrooms', 'lighting', 'reports', 'obstacles', 'warnings', 'endpoints', 'signals', 'famous', 'related', 'places', 'me']) {
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
          paint: { 'line-color': '#5b3df5', 'line-width': 6 } })
        map.addLayer({ id: 'obstacles', type: 'circle', source: 'obstacles',
          paint: { 'circle-radius': 4, 'circle-color': '#b45309', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } })
        map.addLayer({ id: 'restrooms', type: 'circle', source: 'restrooms',
          paint: {
            'circle-radius': 8,
            'circle-color': ['match', ['get', 'wheelchair'], 'yes', '#15803d', 'limited', '#ca8a04', 'no', '#7c3aed', '#6b7280'],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
          } })
        map.addLayer({ id: 'reports', type: 'symbol', source: 'reports',
          layout: { 'icon-image': 'pin-report', 'icon-size': 0.8, 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
        map.addLayer({ id: 'warnings', type: 'circle', source: 'warnings',
          paint: { 'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ea580c', 'circle-stroke-width': 3 } })
        map.addLayer({ id: 'endpoints', type: 'circle', source: 'endpoints',
          paint: {
            'circle-radius': 9,
            'circle-color': ['match', ['get', 'role'], 'from', '#15803d', 'stop', '#f59e0b', '#1a5fd6'],
            'circle-stroke-color': '#fff', 'circle-stroke-width': 3,
          } })

        // Traffic lights sit on the road; they only appear once you're zoomed in to street level.
        map.addLayer({ id: 'signals', type: 'symbol', source: 'signals', minzoom: SIGNAL_MIN_ZOOM,
          layout: {
            'icon-image': ['match', ['get', 'kind'], 'crossing', 'sig-crossing', 'sig-traffic'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.45, 17, 0.7, 19, 0.95],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
          paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.4, 1] } })
        // Famous places: best known first, so they win when labels collide.
        map.addLayer({ id: 'famous', type: 'symbol', source: 'famous',
          layout: {
            'icon-image': ['concat', 'fam-', ['get', 'icon']],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.85, 8, 1, 12, 1.1],
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 10, 13],
            'text-anchor': 'top',
            'text-offset': [0, 1.2],
            'text-max-width': 9,
            'text-optional': true,
            'symbol-sort-key': ['-', 0, ['get', 'fame']],
          },
          paint: { 'text-color': '#2b2350', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 } })
        // Spots related to the selected place: one icon and color per kind (mountain, park, trail,
        // visitor facility…). Direct links and the active spot carry their name.
        map.addLayer({ id: 'related-halo', type: 'circle', source: 'related', filter: ['==', ['get', 'active'], true],
          paint: { 'circle-radius': 24, 'circle-color': ['get', 'color'], 'circle-opacity': 0.25, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2 } })
        map.addLayer({ id: 'related', type: 'symbol', source: 'related',
          layout: {
            'icon-image': ['concat', 'rel-', ['get', 'group']],
            'icon-size': ['case', ['==', ['get', 'active'], true], 1.25, ['==', ['get', 'direct'], true], 1, 0.85],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'text-field': ['case', ['any', ['==', ['get', 'active'], true], ['==', ['get', 'direct'], true]], ['get', 'name'], ''],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['case', ['==', ['get', 'active'], true], 14, 12],
            'text-anchor': 'top',
            'text-offset': [0, 1.3],
            'text-max-width': 9,
            'text-optional': true,
            'symbol-sort-key': ['case', ['==', ['get', 'active'], true], 0, ['==', ['get', 'direct'], true], 1, 2],
          },
          paint: { 'text-color': '#2b2350', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 } })
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
        // The position itself is an HTML marker (see below), so it can be a dot, an arrow, a walker…

        map.on('click', 'places', (e) => {
          const id = e.features?.[0]?.properties?.id
          if (id) placeClickRef.current(String(id))
        })

        map.on('click', 'related', (e) => {
          const id = e.features?.[0]?.properties?.id
          if (id) relatedClickRef.current?.(String(id))
        })

        map.on('click', 'famous', (e) => {
          const id = e.features?.[0]?.properties?.id
          const p = famousRef.current.find((f) => f.id === id)
          if (p) famousClickRef.current(p)
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
        for (const id of ['restrooms', 'reports', 'places', 'famous', 'related']) {
          map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', id, () => { map.getCanvas().style.cursor = pickModeRef.current ? 'crosshair' : '' })
        }
        setReady(true)
        emitView()
      })

      map.on('click', (e) => {
        const hits = map.getLayer('places') ? map.queryRenderedFeatures(e.point, { layers: ['restrooms', 'reports', 'places', 'famous', 'related'] }) : []
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
      // One Southern Ocean name, on the side of Antarctica you're looking at.
      const placeOceans = () => {
        if (!map.getLayer(OCEAN_LAYER)) return
        const c = map.getCenter()
        map.setFilter(OCEAN_LAYER, oceanFilter(nearestSouthernOcean(c.lng, c.lat)))
      }
      map.on('moveend', placeOceans)
      map.on('style.load', placeOceans)
      // Only real drags/zooms by the visitor carry an originalEvent; our own camera moves don't.
      map.on('dragstart', (e) => { if (e.originalEvent) userMoveRef.current() })
      // Zooming or turning the map yourself also means you're exploring: live location stops
      // pulling the map back until you tap the locate button.
      for (const ev of ['zoomstart', 'rotatestart', 'pitchstart'] as const) {
        map.on(ev, (e) => { if (e.originalEvent && !navigatingRef.current) userMoveRef.current() })
      }
      // Zoomed out, grab the globe and spin it any way you like, over the poles too.
      map.once('load', () => { detachSpin = attachGlobeSpin(map, () => userMoveRef.current()) })
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
      transformStyle: (prev, next) => carryOverAppLayers(prev, withOwnTiles(withWorldLabels(safeRestyle(look, next)))),
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
    // While navigating the camera follows you; a reroute mustn't yank it out to the whole trip.
    if (route && route.geometry.length > 1 && !navigatingRef.current) {
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
  const pinKeys = useRef<Set<string>>(new Set())
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    for (const m of pinMarkers.current) m.remove()
    // Only pins that are new or moved get the drop animation; the rest stay still.
    const before = pinKeys.current
    pinKeys.current = new Set()
    const pins: { role: 'from' | 'to' | number; at: LngLat }[] = [
      ...(from ? [{ role: 'from' as const, at: from }] : []),
      ...stops.map((at, i) => ({ role: i, at })),
      ...(to ? [{ role: 'to' as const, at: to }] : []),
    ]
    pinMarkers.current = pins.map(({ role, at }) => {
      const el = document.createElement('div')
      el.className = `trip-pin ${role === 'from' ? 'start' : role === 'to' ? 'end' : 'stop'}`
      // A drawn pin, not a rotated box: rotating the marker element would also rotate MapLibre's
      // positioning transform and throw the pin off the map.
      const key = `${role}@${at[0]},${at[1]}`
      pinKeys.current.add(key)
      if (!before.has(key)) el.classList.add('drop')
      el.innerHTML = role === 'from' ? pinSvg('#16a34a') : role === 'to' ? PIN_SVG : pinSvg('#f59e0b', String(role + 1))
      el.title = role === 'from' ? 'Start (drag to move)' : role === 'to' ? 'Destination (drag to move)' : `Stop ${role + 1} (drag to move)`
      const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' })
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
    setData('signals', { type: 'FeatureCollection', features: signals.map((g) => point(g.coords, { kind: g.kind })) })
  }, [signals, ready])

  useEffect(() => {
    if (!ready) return
    setData('famous', { type: 'FeatureCollection', features: famous.map((f) => point(f.coords, { id: f.id, name: f.name, icon: f.icon, fame: f.fame })) })
  }, [famous, ready])

  useEffect(() => {
    if (!ready) return
    setData('related', {
      type: 'FeatureCollection',
      features: related.map((r) => point(r.coords, {
        id: r.id, name: r.name, group: r.group, color: GROUP_LOOK[r.group].color, direct: r.direct, active: r.id === activeRelatedId,
      })),
    })
  }, [related, activeRelatedId, ready])

  // While a place is selected, other pins fade so its related spots stand out.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    const apply = () => {
      const o = dimOthers ? 0.3 : 1
      for (const id of ['famous', 'places']) {
        if (!map.getLayer(id)) continue
        map.setPaintProperty(id, 'icon-opacity', o)
        if (id === 'famous') map.setPaintProperty(id, 'text-opacity', o)
      }
    }
    apply()
    map.on('style.load', apply)
    return () => { map.off('style.load', apply) }
  }, [dimOthers, ready])

  useEffect(() => {
    if (!ready) return
    setData('me', myLocation ? { type: 'FeatureCollection', features: [point(myLocation, { acc: myAccuracy ?? 0 })] } : empty)
  }, [myLocation, myAccuracy, ready])

  // Which way you're heading: the route's direction while navigating, otherwise worked out from
  // how you've moved (ignoring GPS jitter of a few meters).
  const headingFrom = useRef<LngLat | null>(null)
  const [movedHeading, setMovedHeading] = useState<number | null>(null)
  useEffect(() => {
    if (!myLocation) return
    const last = headingFrom.current
    if (!last) { headingFrom.current = myLocation; return }
    if (distanceMeters(last, myLocation) < 5) return
    headingFrom.current = myLocation
    setMovedHeading(bearingDeg(last, myLocation))
  }, [myLocation])
  const heading = navigating ? navBearing : movedHeading

  // Your position marker. Arrow-like markers turn with the map so they point the real direction.
  const meMarker = useRef<maplibregl.Marker | null>(null)
  const glide = useRef({ raf: 0 })
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    if (!myLocation) { meMarker.current?.remove(); meMarker.current = null; return }
    if (!meMarker.current) {
      const el = document.createElement('div')
      el.className = 'me-marker'
      el.setAttribute('aria-label', 'Your location')
      meMarker.current = new maplibregl.Marker({ element: el, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'viewport' })
        .setLngLat(myLocation).addTo(map)
    }
    const m = meMarker.current
    const el = m.getElement()
    if (el.dataset.style !== marker) {
      el.dataset.style = marker
      el.innerHTML = markerHtml(marker)
      // Upright markers stay upright; turning ones follow the map's compass so they point the real way.
      m.setRotationAlignment(ROTATES[marker] ? 'map' : 'viewport')
    }
    el.classList.toggle('no-heading', ROTATES[marker] && heading == null)
    glideMarker(m, myLocation, ROTATES[marker] ? heading ?? 0 : 0, glide)
  }, [myLocation, marker, heading, ready])
  useEffect(() => () => { meMarker.current?.remove(); cancelAnimationFrame(glide.current.raf) }, [])

  // Follow the visitor. The first fix jumps straight there (a long animated flight across the
  // country leaves half-loaded tiles behind). After that, only glide when they've really moved,
  // and never interrupt a camera move that's already running: GPS sends small updates every
  // second, and restarting the animation each time stopped tiles from ever finishing loading.
  const lastFollowed = useRef<LngLat | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !myLocation || !follow) return
    if (navigating) {
      // Close up, turned the way you're going, with you in the lower part of the screen so
      // more of the road ahead shows above the direction banner.
      lastFollowed.current = myLocation
      const driving = marker === 'car'
      map.easeTo({ center: myLocation, zoom: driving ? 16.8 : 17.5, bearing: navBearing, pitch: driving ? 58 : 45, duration: GLIDE_MS, easing: (t) => t,
        offset: [0, Math.round(map.getContainer().clientHeight * 0.18)] })
      return
    }
    const last = lastFollowed.current
    if (!last || distanceMeters(last, myLocation) > 2000) {
      lastFollowed.current = myLocation
      map.jumpTo({ center: myLocation, zoom: Math.max(map.getZoom(), 15) })
      return
    }
    if (map.isMoving() || distanceMeters(last, myLocation) < 8) return
    lastFollowed.current = myLocation
    map.easeTo({ center: myLocation, duration: 500 })
  }, [myLocation, follow, ready, navigating, navBearing, marker])

  // Leaving navigation: flatten the map and point it north again.
  const navigatingRef = useRef(navigating)
  useEffect(() => {
    const was = navigatingRef.current
    navigatingRef.current = navigating
    const map = mapRef.current
    if (was && !navigating && map) map.easeTo({ bearing: 0, pitch: 0, duration: 600 })
  }, [navigating])

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
    const map = mapRef.current
    if (!flyTo || !map) return
    // On phones the bottom sheet covers the lower part of the map, so aim above it.
    const offset: [number, number] = window.innerWidth <= 720 ? [0, -Math.round(window.innerHeight * 0.3)] : [-200, -30]
    if (flyTo.keepZoom) map.easeTo({ center: flyTo.at, offset, duration: 600 })
    else map.flyTo({ center: flyTo.at, zoom: flyTo.zoom ?? Math.max(map.getZoom(), 15), offset })
  }, [flyTo])

  const pickModeRef = useRef(pickMode)
  useEffect(() => {
    pickModeRef.current = pickMode
    const canvas = mapRef.current?.getCanvas()
    if (canvas) canvas.style.cursor = pickMode ? 'crosshair' : ''
  }, [pickMode, ready])

  // The search / report pin.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !markPin) return
    const el = document.createElement('div')
    el.className = `trip-pin end mark-pin${markLabel ? ' selected-pin' : ''}`
    el.innerHTML = markLabel ? `<span class="pin-pulse" aria-hidden="true"></span>${SELECTED_PIN_SVG}<span class="pin-label">${escapeHtml(markLabel)}</span>` : PIN_SVG
    if (markLabel) el.setAttribute('aria-label', `Selected: ${markLabel}`)
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(markPin).addTo(map)
    return () => { marker.remove() }
  }, [markPin, markLabel, ready])

  // My Maps pins: colored, labeled, the highlighted one on top. Custom pins can be dragged.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !myPins?.length) return
    const markers = myPins.map((p) => {
      const el = document.createElement('div')
      el.className = `my-pin${p.id === myPinFocus ? ' focus' : ''}${p.draggable ? ' drag' : ''}`
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', p.title)
      el.innerHTML = pinSvg(p.color)
      if (p.icon) {
        const ic = document.createElement('span')
        ic.className = 'my-pin-icon'
        ic.textContent = p.icon
        el.appendChild(ic)
      }
      const tag = document.createElement('span')
      tag.className = 'my-pin-label'
      tag.textContent = p.title
      el.appendChild(tag)
      let dragged = false
      el.addEventListener('click', (e) => { e.stopPropagation(); if (!dragged) myPinClickRef.current?.(p.id); dragged = false })
      const m = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: p.draggable }).setLngLat(p.coords).addTo(map)
      if (p.id === myPinFocus) el.style.zIndex = '3'
      m.on('dragstart', () => { dragged = true })
      m.on('dragend', () => { const ll = m.getLngLat(); myPinDragRef.current?.(p.id, [ll.lng, ll.lat]); setTimeout(() => { dragged = false }, 0) })
      return m
    })
    return () => { markers.forEach((m) => m.remove()) }
  }, [myPins, myPinFocus, ready])

  return <div ref={container} className="map" aria-label="Map" />
}

/** A teardrop map pin; with a label (a stop number) the label sits in the white center. */
function pinSvg(color: string, label?: string): string {
  const center = label
    ? `<circle cx="14" cy="14.5" r="7.5" fill="#fff"/><text x="14" y="18.5" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="11" fill="${color}">${label}</text>`
    : '<circle cx="14" cy="14.5" r="4.5" fill="#fff"/>'
  return `<svg width="28" height="38" viewBox="0 0 28 38" aria-hidden="true"><path d="M14 37s12-13.2 12-22.5A12 12 0 0 0 2 14.5C2 23.8 14 37 14 37z" fill="${color}" stroke="#fff" stroke-width="2"/>${center}</svg>`
}
const PIN_SVG = pinSvg('#dc2626')
/** The selected place: a bigger pin in the brand violet. */
const SELECTED_PIN_SVG = pinSvg('#5b3df5').replace('width="28" height="38"', 'width="38" height="51"')

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

const APP_SOURCES = ['route', 'restrooms', 'lighting', 'reports', 'obstacles', 'warnings', 'endpoints', 'signals', 'famous', 'related', 'places', 'me', WV_SOURCE]

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

// Our own looks are restyles of a base style; the others load as published.
const RESTYLES: Partial<Record<MapStyleId, (s: StyleSpecification) => StyleSpecification>> = { clean: cleanStyle, signature: signatureStyle }

/** The style to open with: a URL, or for our own looks the restyled style JSON. */
async function loadBaseStyle(look: MapStyleId): Promise<string | StyleSpecification> {
  const url = MAP_STYLES[look].url
  const restyle = RESTYLES[look] ?? ((s: StyleSpecification) => s)
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    const raw = (await res.json()) as StyleSpecification
    // Never let a restyle mistake blank the whole map: fall back to the plain style.
    const styled = restyle(raw)
    const style = validateStyleMin(styled).length ? raw : styled
    return withOwnTiles(withWorldLabels(style))
  } catch {
    return url // still show a map if the style can't be prepared
  }
}

function applyGlobe(map: MlMap) {
  try {
    map.setProjection({ type: 'globe' })
    map.setSky({
      'sky-color': '#2a1f6b',
      'horizon-color': '#8f7dff',
      'fog-color': '#c9bfff',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.9,
      // A soft violet glow around the globe that fades away as you zoom in.
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    })
  } catch {
    // Older GPUs/browsers: stay on the flat map rather than failing.
  }
}

function safeRestyle(look: MapStyleId, style: StyleSpecification): StyleSpecification {
  const restyle = RESTYLES[look]
  if (!restyle) return style
  const styled = restyle(style)
  return validateStyleMin(styled).length ? style : styled
}

/** A map pin in the category's color with its icon, drawn at 2x for sharp screens. */
function addCategoryIcon(map: MlMap, id: string) {
  if (map.hasImage(id)) return
  const cat = id === 'pin-report' ? { color: '#dc2626', icon: '⚠️' }
    : id.startsWith('cat-') ? CATEGORIES.find((c) => `cat-${c.id}` === id) : null
  if (!cat) return
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

/** A traffic light (red, amber, green) or a pedestrian crossing light, drawn at 2x. */
function addSignalIcon(map: MlMap, id: string) {
  if ((id !== 'sig-traffic' && id !== 'sig-crossing') || map.hasImage(id)) return
  const crossing = id === 'sig-crossing'
  const w = crossing ? 44 : 32, h = crossing ? 44 : 72
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#1f1b38'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.roundRect(2, 2, w - 4, h - 4, 9)
  ctx.fill()
  ctx.stroke()
  if (crossing) {
    ctx.font = '24px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('🚶', w / 2, h / 2 + 1)
  } else {
    for (const [i, c] of ['#ef4444', '#f59e0b', '#22c55e'].entries()) {
      ctx.beginPath()
      ctx.arc(w / 2, 15 + i * 21, 7.5, 0, Math.PI * 2)
      ctx.fillStyle = c
      ctx.fill()
    }
  }
  map.addImage(id, ctx.getImageData(0, 0, w, h), { pixelRatio: 2 })
}

/** A round white badge with the place's emoji, drawn at 2x. */
function addFamousIcon(map: MlMap, id: string) {
  if (!id.startsWith('fam-') || map.hasImage(id)) return
  const size = 56, r = 24, c = size / 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.shadowColor = 'rgba(43,35,80,0.35)'
  ctx.shadowBlur = 5
  ctx.shadowOffsetY = 2
  ctx.beginPath()
  ctx.arc(c, c, r, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = 3
  ctx.strokeStyle = '#5b3df5'
  ctx.stroke()
  ctx.font = '26px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(id.slice(4), c, c + 2)
  map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 })
}

/** Related-spot icons: a white disc ringed in the kind's color, with its emoji (⛰️ 🌲 🥾 ℹ️…). */
function addRelatedIcon(map: MlMap, id: string) {
  if (!id.startsWith('rel-') || map.hasImage(id)) return
  const look = GROUP_LOOK[id.slice(4) as keyof typeof GROUP_LOOK]
  if (!look) return
  const size = 64, r = 27, c = size / 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.shadowColor = 'rgba(43,35,80,0.35)'
  ctx.shadowBlur = 5
  ctx.shadowOffsetY = 2
  ctx.beginPath()
  ctx.arc(c, c, r, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = 5
  ctx.strokeStyle = look.color
  ctx.stroke()
  ctx.font = '28px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(look.icon, c, c + 2)
  map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 })
}
