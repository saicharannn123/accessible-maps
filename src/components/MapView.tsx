import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre runs map work in a web worker; bundlers need to be told where its file lives.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { MAP_STYLE_URL, PILOT_CITY } from '../config'
import { bboxOf } from '../lib/geo'
import type { AccessData } from '../lib/overpass'
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
  layers: Layers
  flyTo: LngLat | null
  onMapClick: (p: LngLat) => void
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
  const { access, reports, route, from, to, layers, flyTo, onMapClick, onViewChange } = props
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const [ready, setReady] = useState(false)
  const clickRef = useRef(onMapClick)
  const viewRef = useRef(onViewChange)
  useEffect(() => {
    clickRef.current = onMapClick
    viewRef.current = onViewChange
  })

  useEffect(() => {
    if (!container.current) return
    const map = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE_URL,
      center: PILOT_CITY.center,
      zoom: PILOT_CITY.zoom,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right')

    const emitView = () => {
      const b = map.getBounds()
      viewRef.current([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom())
    }

    map.on('load', () => {
      for (const id of ['route', 'restrooms', 'lighting', 'reports', 'obstacles', 'warnings', 'endpoints']) {
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
          'circle-color': ['match', ['get', 'role'], 'from', '#15803d', '#1a5fd6'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 3,
        } })

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
      for (const id of ['restrooms', 'reports']) {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = '' })
      }
      setReady(true)
      emitView()
    })

    map.on('click', (e) => {
      const hits = map.getLayer('restrooms') ? map.queryRenderedFeatures(e.point, { layers: ['restrooms', 'reports'] }) : []
      if (hits.length === 0) clickRef.current([e.lngLat.lng, e.lngLat.lat])
    })
    map.on('moveend', emitView)

    return () => { map.remove(); mapRef.current = null }
  }, [])

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

  useEffect(() => {
    if (!ready) return
    const f: Feature[] = []
    if (from) f.push(point(from, { role: 'from' }))
    if (to) f.push(point(to, { role: 'to' }))
    setData('endpoints', { type: 'FeatureCollection', features: f })
  }, [from, to, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    for (const [group, ids] of Object.entries(LAYER_GROUPS)) {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', layers[group as keyof Layers] ? 'visible' : 'none')
    }
  }, [layers, ready])

  useEffect(() => {
    if (flyTo) mapRef.current?.flyTo({ center: flyTo, zoom: Math.max(mapRef.current.getZoom(), 16) })
  }, [flyTo])

  return <div ref={container} className="map" aria-label="Map" />
}
