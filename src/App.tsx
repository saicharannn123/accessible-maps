import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { MapView, type Layers } from './components/MapView'
import { SearchBox } from './components/SearchBox'
import { MyMapsPanel } from './components/MyMaps'
import { SaveToMap } from './components/SaveToMap'
import { getMyMaps, itemTitle, savePlace, updateItem, updateMyMaps, useMyMaps, type MapItem } from './lib/myMaps'
import { RelatedPlaces, type SaveablePlace } from './components/RelatedPlaces'
import { anchorKey, WHEELCHAIR_LINE, kindFromOsmTag, kindFromText, loadRelated, spotPlace, type RelatedResult, type RelatedSpot } from './lib/related'
import { APP_NAME, MAP_STYLES, ORS_KEY, PILOT_CITY, REPORT_LIFETIME_DAYS, type MapStyleId } from './config'
import { browserNameView, browserWorldview, WORLDVIEWS, type WorldviewCode, type WorldviewSetting } from './lib/worldview'
import { bboxOf, browserUnits, distanceMeters, formatDistance, formatDuration, radiusChoices, setDistanceUnits, snapRadius } from './lib/geo'
import { fetchAccessData, type AccessData } from './lib/overpass'
import { openStatus } from './lib/hours'
import { locationHelp, useLiveLocation } from './lib/useLiveLocation'
import { CATEGORIES, CATEGORY_BY_ID, fetchNearby, type NearbyPlace } from './lib/places'
import { loadReports, saveReports, timeAgo } from './lib/reports'
import { loadSignals, SIGNAL_MIN_ZOOM, type Signal } from './lib/signals'
import { loadFamous, FAMOUS_MIN_ZOOM, FAMOUS_MAX_ZOOM, type FamousPlace } from './lib/famous'
import { addHistory, loadHistory, saveHistory, type HistoryEntry, type HistoryItem } from './lib/history'
import { planRoute } from './lib/routing'
import { navProgress, stepPositions } from './lib/navigation'
import { useSheetDrag, type SheetSnap } from './lib/useSheetDrag'
import { MARKER_STYLES, markerHtml, resolveMarker, type MarkerStyle } from './lib/marker'
import { reverseGeocode } from './lib/geocode'
import { loadSettings, saveSettings } from './lib/settings'
import { safeWebUrl, telHref } from './lib/safeUrl'
import { PROFILE_LABELS, REPORT_LABELS, TRAVEL_MODES } from './lib/types'
import type { LngLat, MobilityProfile, Place, Report, ReportType, RouteResult, Settings, TravelMode } from './lib/types'

type Tab = 'nearby' | 'route' | 'maps' | 'report' | 'settings'
type Pick = 'from' | 'to' | 'report' | 'my-pin' | `stop-${number}` | null
const MAX_STOPS = 5
const TAB_INFO: Record<Tab, { icon: string; label: string; title: string }> = {
  nearby: { icon: '🧭', label: 'Explore', title: "What's around you" },
  route: { icon: '🚶', label: 'Go', title: 'Plan your trip' },
  maps: { icon: '🗺️', label: 'My Maps', title: 'Your own maps' },
  report: { icon: '⚠️', label: 'Report', title: 'Flag a barrier' },
  settings: { icon: '⚙️', label: 'Settings', title: 'Make it yours' },
}

const MIN_DETAIL_ZOOM = 14
// Below this many results we automatically look further out, like big map apps do.
const MIN_RESULTS = 3

const WHEELCHAIR_TEXT: Record<NearbyPlace['wheelchair'], string> = {
  yes: '♿ Wheelchair accessible',
  limited: '♿ Partly accessible',
  no: 'Not wheelchair accessible',
  unknown: 'Wheelchair access unknown',
}

interface Nearby {
  category: string | null
  radius: number
  center: LngLat | null
  places: NearbyPlace[]
  status: 'idle' | 'loading' | 'done' | 'error'
  /** Set when nothing was close, so we looked further than asked. */
  widenedFrom?: number
}

function pinnedPlace(c: LngLat, name = 'Dropped pin'): Place {
  return { name, detail: `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`, coords: c }
}

/** How close to zoom when a place is selected: a whole mountain or park, a city, or a street corner. */
function zoomFor(p: Place): number {
  const kind = kindFromOsmTag(p.osmTag) ?? kindFromText(`${p.detail} ${p.icon === '⛰️' ? 'mountain' : ''}`)
  return kind === 'mountain' ? 11 : kind === 'park' ? 11 : kind === 'city' ? 12 : 15
}

/** The "Save to map" button from My Maps, on the selected place card and Related places rows. */
const saveSlot = (p: SaveablePlace): ReactNode => <SaveToMap place={p} />

export default function App() {
  const [tab, setTab] = useState<Tab>('nearby')
  const loc = useLiveLocation()
  const myLocation = loc.position
  // Keep the map on the visitor while they move, until they pan away themselves.
  const [follow, setFollow] = useState(true)
  const [mapCenter, setMapCenter] = useState<LngLat>(PILOT_CITY.center)
  const [nearby, setNearby] = useState<Nearby>({ category: null, radius: 1000, center: null, places: [], status: 'idle' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [accessibleOnly, setAccessibleOnly] = useState(false)
  const [openOnly, setOpenOnly] = useState(false)
  const [moreCats, setMoreCats] = useState(false)
  const [now, setNow] = useState(() => new Date())
  // Keep "Open now" right while the page stays open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const [fitTo, setFitTo] = useState<{ points: LngLat[]; key: number } | null>(null)
  const nearbyCtrl = useRef<AbortController | null>(null)
  const panelScroll = useRef<HTMLDivElement>(null)
  // Where the map was after the app last moved it; "Search this area" shows once you pan away from it.
  // "Search this area" only appears after the visitor drags the map themselves.
  const [userPanned, setUserPanned] = useState(false)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  // Borders: ?borders=IN in the address forces a view (handy for testing), otherwise the setting.
  const [autoWorldview] = useState(browserWorldview)
  const [autoNameView] = useState(browserNameView)
  const [urlWorldview] = useState(() => {
    const v = new URLSearchParams(window.location.search).get('borders')?.toUpperCase()
    return v && v in WORLDVIEWS ? (v as WorldviewCode) : v === 'OSM' ? ('osm' as const) : null
  })
  const worldviewSetting: WorldviewSetting = urlWorldview ?? settings.worldview
  const worldview: WorldviewCode | null =
    worldviewSetting === 'osm' ? null : worldviewSetting === 'auto' ? autoWorldview : worldviewSetting
  // Place names follow the same choice; on Automatic, US and Mexico visitors also get their own names.
  const nameView: WorldviewCode | null =
    worldviewSetting === 'osm' ? null : worldviewSetting === 'auto' ? autoNameView : worldviewSetting

  const [reports, setReports] = useState<Report[]>(() => loadReports())
  const [access, setAccess] = useState<AccessData | null>(null)
  const [detailNotice, setDetailNotice] = useState<string | null>(null)
  const [layers, setLayers] = useState<Layers>({ restrooms: true, lighting: false, reports: true, obstacles: true })
  const [from, setFrom] = useState<Place | null>(null)
  const [to, setTo] = useState<Place | null>(null)
  // Stops between start and destination. Each has an id so its search box keeps its text.
  const [stops, setStops] = useState<{ id: number; place: Place | null }[]>([])
  const nextStopId = useRef(1)
  const stopsRef = useRef(stops)
  useEffect(() => { stopsRef.current = stops })
  const [pick, setPick] = useState<Pick>(null)
  // The Directions box a map tap fills: the one you last clicked into, else the destination.
  const [activeField, setActiveField] = useState<'from' | 'to' | `stop-${number}`>('to')
  const [mapMenu, setMapMenu] = useState<{ at: LngLat; x: number; y: number; name: string | null } | null>(null)
  const [routeState, setRouteState] = useState<{ key: string; route: RouteResult | null; error: string | null }>({ key: '', route: null, error: null })
  const [routing, setRouting] = useState(false)
  const [flyTo, setFlyTo] = useState<{ at: LngLat; keepZoom?: boolean; zoom?: number } | null>(null)
  // A fresh object every time, so picking the same place twice still moves the map.
  const fly = useCallback((at: LngLat, keepZoom = false, zoom?: number) => setFlyTo({ at: [...at] as LngLat, keepZoom, zoom }), [])
  // The place you picked from the search box on the Near me tab, shown as a red pin.
  const [searchPin, setSearchPin] = useState<Place | null>(null)
  // My Maps: the open map (its pins show on the map) and the highlighted item.
  const myMaps = useMyMaps()
  const [openMapId, setOpenMapId] = useState<string | null>(null)
  const [mapFocus, setMapFocus] = useState<string | null>(null)
  const openMap = myMaps.maps.find((m) => m.id === openMapId) ?? null
  const [draft, setDraft] = useState<{ coords: LngLat | null; type: ReportType; note: string }>({ coords: null, type: 'broken-elevator', note: '' })
  // Phone bottom sheet: peek (just the title), half, or full. Swipes move it between them.
  const [sheet, setSheet] = useState<SheetSnap>('half')
  const sheetOpen = sheet !== 'peek'
  const setSheetOpen = useCallback((open: boolean) => setSheet((s) => (open ? (s === 'peek' ? 'half' : s) : 'peek')), [])
  const panelRef = useRef<HTMLElement>(null)
  useSheetDrag(panelRef, panelScroll, sheet, setSheet)
  const viewCtrl = useRef<AbortController | null>(null)
  const [signals, setSignals] = useState<Signal[]>([])
  const signalCtrl = useRef<AbortController | null>(null)
  const signalTimer = useRef<number | undefined>(undefined)
  const [famous, setFamous] = useState<FamousPlace[]>([])
  const famousCtrl = useRef<AbortController | null>(null)
  const famousTimer = useRef<number | undefined>(undefined)
  const viewTimer = useRef<number | undefined>(undefined)

  const [autoUnits] = useState(browserUnits)
  const units = settings.units === 'auto' ? autoUnits : settings.units
  setDistanceUnits(units) // every distance below is shown in these units
  const radii = radiusChoices(units)

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => saveReports(reports), [reports])
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory)
  useEffect(() => saveHistory(history), [history])
  const remember = useCallback((entry: HistoryEntry) => setHistory((h) => addHistory(h, entry)), [])

  const setProfile = (profile: MobilityProfile) => {
    setSettings((s) => ({ ...s, profile }))
    // Night walking is all about lighting, so show that layer automatically.
    if (profile === 'night') setLayers((l) => ({ ...l, lighting: true }))
  }

  const locateMe = () => {
    setFollow(true)
    if (myLocation) fly(myLocation)
    if (loc.status !== 'live') loc.start()
  }

  const searchNearby = useCallback((category: string, wanted: number, center: LngLat) => {
    const cat = CATEGORY_BY_ID[category]
    const RADII = radiusChoices().map((c) => c.m)
    const radius = snapRadius(wanted)
    nearbyCtrl.current?.abort()
    const ctrl = new AbortController()
    nearbyCtrl.current = ctrl
    setSelectedId(null)
    setUserPanned(false)
    setNearby({ category, radius, center, places: [], status: 'loading' })
    const run = async () => {
      let r = radius
      let places = await fetchNearby(cat, center, r, ctrl.signal)
      // Nothing (or almost nothing) close by: keep looking further out instead of stopping.
      while (places.length < MIN_RESULTS && r < RADII[RADII.length - 1]) {
        r = RADII.find((x) => x > r) ?? RADII[RADII.length - 1]
        const wider = await fetchNearby(cat, center, r, ctrl.signal)
        if (wider.length >= places.length) places = wider
      }
      return { places, r }
    }
    run()
      .then(({ places, r }) => {
        setNearby({ category, radius: r, center, places, status: 'done', widenedFrom: r !== radius ? radius : undefined })
        if (places.length) setFollow(false) // show the results; the locate button brings you back
        if (places.length) setFitTo({ points: [center, ...places.slice(0, 15).map((p) => p.coords)], key: Date.now() })
      })
      .catch((e) => { if (e.name !== 'AbortError') setNearby((n) => ({ ...n, status: 'error' })) })
  }, [])

  const searchCenter = myLocation ?? mapCenter
  // While a place is selected, Explore's categories search around it instead of around you.
  const aroundCenter = searchPin?.coords ?? searchCenter
  const pickCategory = (id: string) => {
    if (nearby.category === id) { // tapping the active category again clears it
      nearbyCtrl.current?.abort()
      setNearby((n) => ({ ...n, category: null, places: [], status: 'idle' }))
      setSelectedId(null)
      return
    }
    searchNearby(id, nearby.radius, aroundCenter)
    remember({ kind: 'category', category: id })
  }

  // --- The selected place and what's related to it -------------------------------------------
  const nearbyNow = useRef(nearby)
  useEffect(() => { nearbyNow.current = nearby })
  /** Select a place: highlight and center its pin, show its card and related spots, and make it the center for categories. */
  const selectAnchor = useCallback((p: Place, addToRecent = true) => {
    if (addToRecent) remember({ kind: 'place', place: { name: p.name, detail: p.detail, coords: p.coords } })
    setSearchPin(p)
    setSelectedId(null)
    setTab('nearby')
    setSheetOpen(true)
    setFollow(false)
    fly(p.coords, false, zoomFor(p))
    panelScroll.current?.scrollTo({ top: 0 })
    const n = nearbyNow.current
    if (n.category) searchNearby(n.category, n.radius, p.coords)
  }, [remember, setSheetOpen, fly, searchNearby])

  // The answer for one selected place (by key); while the key doesn't match the selected place, it's loading.
  const [relatedAnswer, setRelatedAnswer] = useState<{ key: string; status: 'done' | 'error'; result: RelatedResult | null }>({ key: '', status: 'done', result: null })
  const [activeSpotId, setActiveSpot] = useState<string | null>(null)
  // Bumped when a pin is tapped on the map, so the list scrolls to its row.
  const [spotScroll, setSpotScroll] = useState(0)
  const [relatedTry, setRelatedTry] = useState(0)
  useEffect(() => {
    if (!searchPin) return
    const key = anchorKey(searchPin)
    const ctrl = new AbortController()
    const anchor = searchPin
    loadRelated(anchor, ctrl.signal)
      .then((result) => {
        setRelatedAnswer({ key, status: 'done', result })
        // Frame the place with its closest related spots around it, the place itself in the middle
        // (each spot is mirrored across it), clear of the panel.
        const near = result.spots.filter((x) => x.distance < Math.max(result.radius * 1.2, 5000)).sort((a, b) => a.distance - b.distance).slice(0, 8)
        if (near.length) {
          const c = anchor.coords
          setFitTo({ points: [c, ...near.flatMap((x) => [x.coords, [2 * c[0] - x.coords[0], 2 * c[1] - x.coords[1]] as LngLat])], key: Date.now() })
        }
      })
      .catch((e) => { if (e?.name !== 'AbortError') setRelatedAnswer({ key, status: 'error', result: null }) })
    return () => ctrl.abort()
  }, [searchPin, relatedTry])
  const related: { status: 'loading' | 'done' | 'error'; result: RelatedResult | null } =
    !searchPin ? { status: 'done', result: null }
      : relatedAnswer.key === anchorKey(searchPin) ? relatedAnswer : { status: 'loading', result: null }
  const relatedSpots = useMemo(() => related.result?.spots ?? [], [related.result])
  // A spot stays highlighted only while it belongs to the selected place's list.
  const activeSpot = activeSpotId && relatedSpots.some((x) => x.id === activeSpotId) ? activeSpotId : null

  const activateSpot = useCallback((s: RelatedSpot) => {
    setActiveSpot((cur) => (cur === s.id ? null : s.id))
    setFollow(false)
    fly(s.coords, true)
  }, [fly])
  const onRelatedPin = useCallback((id: string) => {
    setActiveSpot(id)
    setTab('nearby')
    setSheetOpen(true)
    setSpotScroll((k) => k + 1)
  }, [setSheetOpen])
  /** Back to your live location: drop the selected place and search categories around you again. */
  const nearMe = () => {
    setSearchPin(null)
    setFollow(true)
    if (myLocation) fly(myLocation, false, 15)
    if (loc.status !== 'live') loc.start()
    if (nearby.category) searchNearby(nearby.category, nearby.radius, myLocation ?? mapCenter)
  }

  const statusById = useMemo(
    () => new Map(nearby.places.map((p) => [p.id, openStatus(p.openingHours, now)])),
    [nearby.places, now],
  )
  const shownPlaces = useMemo(
    () => nearby.places.filter((p) =>
      (!accessibleOnly || p.wheelchair === 'yes' || p.wheelchair === 'limited') &&
      (!openOnly || statusById.get(p.id)?.open === true)),
    [nearby.places, accessibleOnly, openOnly, statusById],
  )
  const openCount = useMemo(() => [...statusById.values()].filter((s) => s?.open).length, [statusById])
  const selected = nearby.places.find((p) => p.id === selectedId) ?? null
  const movedAway = userPanned && nearby.status === 'done' && nearby.category != null && !selected &&
    distanceMeters(nearby.center ?? mapCenter, mapCenter) > Math.max(300, Math.min(nearby.radius, 2000) * 0.5)

  // Opening a place's card adds it to Recent.
  const placesRef = useRef<NearbyPlace[]>([])
  useEffect(() => { placesRef.current = nearby.places })
  const rememberPlace = useCallback((p: NearbyPlace | undefined) => {
    if (p) remember({ kind: 'place', place: { name: p.name, detail: p.address ?? p.kind, coords: p.coords } })
  }, [remember])
  const selectPlace = useCallback((id: string) => {
    rememberPlace(placesRef.current.find((p) => p.id === id))
    setSelectedId(id)
    setTab('nearby')
    setSheetOpen(true)
  }, [rememberPlace, setSheetOpen])

  // Bring the place card into view when a place is picked from the list or the map.
  useEffect(() => { if (selectedId) panelScroll.current?.scrollTo({ top: 0 }) }, [selectedId])

  const directionsTo = (p: NearbyPlace) => {
    setTo({ name: p.name, detail: p.address ?? p.kind, coords: p.coords })
    setFrom(null) // start from wherever you are
    if (loc.status !== 'live') loc.start()
    setTab('route')
  }

  // Accessibility details (restrooms, lighting, steps) come from Overpass, which is slow and
  // rate-limited, so only load them on the tabs that show them, not while browsing Near me.
  const tabRef = useRef(tab)
  const modeRef = useRef(settings.travelMode)
  const lastView = useRef<{ bbox: [number, number, number, number]; zoom: number } | null>(null)
  const onViewChange = useCallback((bbox: [number, number, number, number], zoom: number) => {
    const c: LngLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
    setMapCenter(c)
    lastView.current = { bbox, zoom }
    // Traffic lights at street level, on every tab.
    window.clearTimeout(signalTimer.current)
    signalCtrl.current?.abort()
    if (zoom >= SIGNAL_MIN_ZOOM) {
      signalTimer.current = window.setTimeout(() => {
        const ctrl = new AbortController()
        signalCtrl.current = ctrl
        loadSignals(bbox, ctrl.signal).then(setSignals).catch(() => {})
      }, 350)
    }
    // Famous places when looking at a country or region; hidden at street level.
    window.clearTimeout(famousTimer.current)
    famousCtrl.current?.abort()
    if (zoom >= FAMOUS_MIN_ZOOM && zoom < FAMOUS_MAX_ZOOM) {
      famousTimer.current = window.setTimeout(() => {
        const ctrl = new AbortController()
        famousCtrl.current = ctrl
        loadFamous(bbox, zoom, ctrl.signal).then(setFamous).catch(() => {})
      }, 450)
    } else {
      setFamous((f) => (f.length ? [] : f))
    }
    window.clearTimeout(viewTimer.current)
    viewCtrl.current?.abort()
    // Restrooms, steps and curbs only matter on foot, so skip them for driving and cycling directions.
    const onWheels = tabRef.current === 'route' && (modeRef.current === 'car' || modeRef.current === 'bike')
    if (tabRef.current === 'nearby' || tabRef.current === 'maps' || tabRef.current === 'settings' || onWheels) {
      setDetailNotice(null)
      return
    }
    if (zoom < MIN_DETAIL_ZOOM) {
      setDetailNotice('Zoom in to see restrooms, lighting and steps')
      return
    }
    viewTimer.current = window.setTimeout(() => {
      const ctrl = new AbortController()
      viewCtrl.current = ctrl
      setDetailNotice('Loading accessibility details…')
      fetchAccessData(bbox, ctrl.signal)
        .then((d) => { setAccess(d); setDetailNotice(null) })
        .catch((e) => { if (e.name !== 'AbortError') setDetailNotice('Could not load accessibility details. Try again in a moment.') })
    }, 500)
  }, [])

  useEffect(() => {
    tabRef.current = tab
    modeRef.current = settings.travelMode
    if (lastView.current) onViewChange(lastView.current.bbox, lastView.current.zoom)
  }, [tab, settings.travelMode, onViewChange])

  // Put a dropped pin into a trip box right away, then swap in the street address when it arrives.
  const dropPin = useCallback((field: 'from' | 'to' | `stop-${number}`, c: LngLat) => {
    const set = (p: Place) => {
      if (field === 'from') setFrom((cur) => (!cur || cur.coords === c ? p : cur))
      else if (field === 'to') setTo((cur) => (!cur || cur.coords === c ? p : cur))
      else {
        const id = Number(field.slice(5))
        setStops((ss) => ss.map((st) => (st.id === id && (!st.place || st.place.coords === c) ? { ...st, place: p } : st)))
      }
    }
    if (field === 'from') setFrom(pinnedPlace(c))
    else if (field === 'to') setTo(pinnedPlace(c))
    else setStops((ss) => ss.map((st) => (st.id === Number(field.slice(5)) ? { ...st, place: pinnedPlace(c) } : st)))
    reverseGeocode(c).then((p) => { if (p) set(p) }).catch(() => {})
  }, [])

  // My Maps: a tap drops your own pin into the open map; it takes the street name when that arrives.
  const openMapRef = useRef(openMapId)
  useEffect(() => { openMapRef.current = openMapId })
  const dropMyPin = useCallback((c: LngLat) => {
    // Into the open map, else your default map (a new one if you have none).
    const mapId = savePlace({ name: 'Dropped pin', coords: c, source: 'pin' }, openMapRef.current ?? undefined)
    setOpenMapId(mapId)
    const m = getMyMaps().maps.find((x) => x.id === mapId)
    const item = m?.items.find((i) => i.source === 'pin' && i.coords[0] === c[0] && i.coords[1] === c[1])
    if (!item) return
    setMapFocus(item.id)
    reverseGeocode(c).then((p) => {
      if (p) updateMyMaps((s) => updateItem(s, mapId, item.id, { name: p.name }))
    }).catch(() => {})
  }, [])

  const onMapClick = useCallback((c: LngLat) => {
    setMapMenu(null)
    if (pick === 'my-pin') { dropMyPin(c); setPick(null); return }
    if (pick === 'from' || pick === 'to' || pick?.startsWith('stop-')) dropPin(pick as 'from' | 'to' | `stop-${number}`, c)
    else if (pick === 'report' || tab === 'report') setDraft((d) => ({ ...d, coords: c }))
    else if (tab === 'route') {
      // Tap the map to fill the box you're in; the destination by default.
      dropPin(activeField, c)
      if (activeField !== 'to') setActiveField('to')
    } else return
    // Center on the new pin (keeping the zoom you chose) and bring the panel back.
    fly(c, true)
    if (pick) setSheetOpen(true)
    setPick(null)
  }, [pick, tab, activeField, dropPin, fly, setSheetOpen, dropMyPin])

  // "Pick on map": on phones, tuck the panel away so the whole map is free to tap.
  const startPick = (field: Exclude<Pick, null>) => {
    setPick(field)
    if (window.innerWidth <= 720) setSheetOpen(false)
  }

  const onMapContext = useCallback((c: LngLat, screen: { x: number; y: number }) => {
    setMapMenu({ at: c, x: screen.x, y: screen.y, name: null })
    reverseGeocode(c).then((p) => setMapMenu((m) => (m && m.at === c ? { ...m, name: p ? p.name : null } : m))).catch(() => {})
  }, [])

  const onPinDrag = useCallback((role: 'from' | 'to' | number, c: LngLat) => {
    if (role === 'from' || role === 'to') dropPin(role, c)
    else {
      const st = stopsRef.current.filter((x) => x.place)[role] // pins are drawn for filled stops only
      if (st) dropPin(`stop-${st.id}`, c)
    }
  }, [dropPin])

  // With no start chosen, Directions start from wherever you are right now.
  const useMyLocation = () => {
    setFrom(null)
    if (loc.status !== 'live') loc.start()
  }
  const fromPlace: Place | null = from ?? (myLocation ? pinnedPlace(myLocation, 'My location') : null)
  const stopPlaces = stops.flatMap((st) => (st.place ? [st.place] : []))

  const addStop = (place: Place | null = null) => {
    if (stops.length >= MAX_STOPS) return
    const id = nextStopId.current++
    setStops((ss) => [...ss, { id, place }])
    if (!place) setActiveField(`stop-${id}`)
  }

  // "Directions to here / from here / Add as stop" from the right-click or long-press menu.
  const fromMenu = (what: 'to' | 'from' | 'stop') => {
    if (!mapMenu) return
    const c = mapMenu.at
    const place: Place = mapMenu.name ? { name: mapMenu.name, detail: pinnedPlace(c).detail, coords: c } : pinnedPlace(c)
    setMapMenu(null)
    setTab('route')
    setSheetOpen(true)
    if (what === 'to') { setTo(place); if (!mapMenu.name) dropPin('to', c) }
    else if (what === 'from') { setFrom(place); if (!mapMenu.name) dropPin('from', c) }
    else if (!to) setTo(place)
    else addStop(place)
  }
  const setStop = (id: number, place: Place | null) => setStops((ss) => ss.map((st) => (st.id === id ? { ...st, place } : st)))
  const removeStop = (id: number) => setStops((ss) => ss.filter((st) => st.id !== id))
  // Reverse the whole trip. Starting from your live location means the trip now ends there.
  const swapTrip = () => {
    setFrom(to)
    setTo(fromPlace)
    setStops((ss) => [...ss].reverse())
  }
  const setTravelMode = (travelMode: TravelMode) => setSettings((s) => ({ ...s, travelMode }))

  const loadRouteAccess = useCallback(async (line: LngLat[]) => {
    const [w, s, e, n] = bboxOf(line)
    if (e - w > 0.08 || n - s > 0.08) return null // too large an area to check in one go
    const data = await fetchAccessData([w, s, e, n])
    setAccess(data) // show what we found along the route on the map too
    return data
  }, [])

  // A route belongs to one trip; changing the start, end or profile hides the old one.
  const tripKey = JSON.stringify([from ? from.coords : myLocation ? 'me' : null, stopPlaces.map((p) => p.coords), to?.coords,
    settings.travelMode, settings.profile, settings.maxInclinePercent])
  const route = routeState.key === tripKey ? routeState.route : null
  const routeError = routeState.key === tripKey ? routeState.error : null

  // Like Google Maps: once there's a start and a destination, show the route straight away,
  // and again whenever a pin, stop or travel mode changes.
  const autoKey = useRef('')
  const findRouteRef = useRef<() => void>(() => {})
  const tripReady = tab === 'route' && fromPlace != null && to != null
  useEffect(() => {
    if (!tripReady || autoKey.current === tripKey) return
    // Mark the trip as routed only when the request starts: a re-render in between (the dropped
    // pin getting its street name) cancels this timer and must not skip the route.
    const t = window.setTimeout(() => { autoKey.current = tripKey; findRouteRef.current() }, 300)
    return () => window.clearTimeout(t)
  }, [tripReady, tripKey])

  // Turn-by-turn mode; it ends by itself when you leave the Go tab or clear the destination.
  const [navOn, setNavOn] = useState(false)
  const navigating = navOn && tab === 'route' && to != null

  const findRoute = async () => {
    if (!fromPlace || !to) return
    const key = tripKey
    // A reroute mid-trip keeps showing the old line until the new one arrives.
    setRouting(true); setRouteState((rs) => ({ key, route: navigating && rs.key === key ? rs.route : null, error: null }))
    try {
      const points = [fromPlace.coords, ...stopPlaces.map((p) => p.coords), to.coords]
      setRouteState({ key, route: await planRoute(points, settings, loadRouteAccess, reports), error: null })
      if (!navigating) setSheetOpen(true)
      // Skip the moment before a dropped pin gets its street name; the named trip is saved next.
      if (to.name !== 'Dropped pin' && from?.name !== 'Dropped pin') remember({ kind: 'route', from, to, mode: settings.travelMode })
    } catch (e) {
      // Mid-trip, a failed reroute keeps the old route rather than leaving you with nothing.
      if (navigating) setRouteState((rs) => ({ ...rs, key, error: null }))
      else setRouteState({ key, route: null, error: e instanceof Error ? e.message : 'Routing failed' })
    } finally {
      setRouting(false)
    }
  }


  useEffect(() => { findRouteRef.current = () => { void findRoute() } })

  // Turn-by-turn navigation: follows your live location, moves to the next step as you pass each
  // turn, reroutes when you leave the route, and reads the next step aloud.
  const [voiceOn, setVoiceOn] = useState(true)
  const [markerMenu, setMarkerMenu] = useState(false)
  const setMarker = (marker: MarkerStyle) => setSettings((s) => ({ ...s, marker }))
  const markerChoices = (
    <div className="marker-grid" role="radiogroup" aria-label="Your location marker">
      {MARKER_STYLES.map((m) => {
        const shown = resolveMarker(m.id, navigating, settings.travelMode)
        const on = (settings.marker ?? 'auto') === m.id
        return (
          <button key={m.id} type="button" role="radio" aria-checked={on} className={on ? 'active' : ''} title={m.hint}
            onClick={() => { setMarker(m.id); setMarkerMenu(false) }}>
            {/* Static markup from lib/marker.ts, no user text. */}
            <span className="marker-preview" dangerouslySetInnerHTML={{ __html: markerHtml(shown) }} />
            <span>{m.label}</span>
          </button>
        )
      })}
    </div>
  )
  const stepAlong = useMemo(() => (route ? stepPositions(route) : []), [route])
  const nav = navigating && route && myLocation ? navProgress(route, myLocation, stepAlong) : null
  const say = useCallback((text: string) => {
    try {
      if (!voiceOn || !('speechSynthesis' in window)) return
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
    } catch { /* no voice on this device */ }
  }, [voiceOn])
  const startNav = () => {
    // Navigation always runs from where you are now.
    if (from) setFrom(null)
    if (loc.status !== 'live') loc.start()
    setNavOn(true); setFollow(true); setSheetOpen(false); setPick(null)
    // Speaking once from the tap unlocks the voice on iPhone for the rest of the trip.
    say('Starting route.')
  }
  const endNav = () => { setNavOn(false); setSheetOpen(true); try { window.speechSynthesis?.cancel() } catch { /* ignore */ } }
  // Announce each new step once, and arrival.
  const spoken = useRef('')
  const navStep = nav && route ? route.steps[nav.nextStep] : null
  useEffect(() => {
    if (!nav || !navStep) return
    const key = nav.arrived ? 'arrived' : `${tripKey}|${nav.nextStep}`
    if (spoken.current === key) return
    spoken.current = key
    say(nav.arrived ? 'You have arrived.' : `In ${formatDistance(nav.toNextMeters)}, ${navStep.text}`)
  })
  // Off the route by more than a street's width: plan again from here, at most every 12 seconds.
  const lastReroute = useRef(0)
  const offRoute = nav != null && !nav.arrived && nav.offRouteMeters > 40 && (loc.accuracy ?? 0) < 60
  useEffect(() => {
    if (!offRoute || routing || Date.now() - lastReroute.current < 12000) return
    lastReroute.current = Date.now()
    findRouteRef.current()
  }, [offRoute, routing, myLocation])
  // Keep the screen awake while navigating, where the browser allows it.
  useEffect(() => {
    if (!navigating) return
    let lock: { release: () => Promise<void> } | null = null
    const nav2 = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    nav2.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {})
    return () => { void lock?.release().catch(() => {}) }
  }, [navigating])

  // When a route comes in, bring its card into view: on phones it sits below the trip form,
  // under the fold of the bottom sheet, so it looked like no directions came back at all.
  const routeCard = useRef<HTMLDivElement>(null)
  const [showSteps, setShowSteps] = useState(true)
  useEffect(() => {
    if (!route) return
    const box = panelScroll.current, card = routeCard.current
    if (!box || !card) return
    const top = card.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
    box.scrollTo({ top, behavior: 'smooth' })
  }, [route])

  // Details for the chosen destination, from what is loaded on the map.
  const destInfo = useMemo(() => {
    if (!to) return null
    const restrooms = (access?.restrooms ?? [])
      .filter((r) => r.wheelchair === 'yes')
      .map((r) => ({ r, d: distanceMeters(to.coords, r.coords) }))
      .sort((a, b) => a.d - b.d)
    const nearbyReports = reports.filter((r) => distanceMeters(to.coords, r.coords) < 100)
    return { restroom: restrooms[0], nearbyReports }
  }, [to, access, reports])

  const submitReport = () => {
    if (!draft.coords) return
    setReports((rs) => [...rs, { id: crypto.randomUUID(), type: draft.type, note: draft.note.trim(), coords: draft.coords!, createdAt: Date.now() }])
    setDraft({ coords: null, type: draft.type, note: '' })
  }

  const pickHint = pick === 'from' ? 'Tap the map to set your start' : pick === 'to' ? 'Tap the map to set your destination'
    : pick?.startsWith('stop-') ? 'Tap the map to set this stop' : pick === 'my-pin' ? 'Tap the map to drop your pin' : null

  const openHistory = (h: HistoryItem) => {
    remember({ ...h })
    if (h.kind === 'place') {
      selectAnchor(h.place, false)
    } else if (h.kind === 'category') {
      if (nearby.category !== h.category) searchNearby(h.category, nearby.radius, aroundCenter)
    } else {
      setFrom(h.from); setTo(h.to); setStops([]); setTravelMode(h.mode)
      if (!h.from && loc.status !== 'live') loc.start()
      setTab('route')
    }
  }

  const myPins = useMemo(() => (tab === 'maps' && openMap && !navigating ? openMap.items.map((i) => ({
    id: i.id, coords: i.coords, color: i.color, title: itemTitle(i), icon: i.icon, draggable: i.source === 'pin',
  })) : []), [tab, openMap, navigating])
  const directionsToItem = (i: MapItem) => {
    setTo({ name: itemTitle(i), detail: i.kind ?? '', coords: i.coords }); setFrom(null)
    if (loc.status !== 'live') loc.start()
    setTab('route')
  }

  const routeStops = useMemo(() => stops.flatMap((st) => (st.place ? [st.place.coords] : [])), [stops])
  const mode = settings.travelMode
  const arrival = route ? new Date(now.getTime() + route.durationSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null

  return (
    <div className={`app${navigating ? ' navigating' : ''}`}>
      <MapView
        access={access}
        reports={reports}
        route={route}
        from={from?.coords ?? null}
        to={to?.coords ?? null}
        stops={routeStops}
        layers={layers}
        flyTo={flyTo}
        signals={signals}
        famous={searchPin && tab === 'nearby' ? famous.filter((f) => !relatedSpots.some((r) => r.wikidata === f.id) && f.id !== searchPin.wikidata) : famous}
        related={tab === 'nearby' ? relatedSpots : []}
        activeRelatedId={activeSpot}
        onRelatedClick={onRelatedPin}
        dimOthers={tab === 'nearby' && searchPin != null && !selected}
        markLabel={tab === 'nearby' && !selected && searchPin ? searchPin.name : null}
        onFamousClick={(f) => selectAnchor({ name: f.name, detail: f.kind, coords: f.coords, icon: f.icon, photo: f.photo, about: f.about, wiki: f.wiki, wikidata: f.id })}
        markPin={tab === 'nearby' && !selected ? searchPin?.coords ?? null : tab === 'report' ? draft.coords : null}
        pickMode={pick != null || tab === 'route' || tab === 'report'}
        places={tab === 'nearby' ? shownPlaces : selected ? [selected] : []}
        selectedPlaceId={selectedId}
        myLocation={myLocation}
        myAccuracy={loc.accuracy}
        worldview={worldview}
        nameView={nameView}
        units={units}
        mapStyle={settings.mapLook}
        follow={follow && loc.status === 'live'}
        navigating={navigating}
        navBearing={nav?.bearing ?? 0}
        marker={resolveMarker(settings.marker ?? 'auto', navigating, settings.travelMode)}
        onUserMove={() => { setFollow(false); setUserPanned(true) }}
        fitTo={fitTo}
        onPlaceClick={selectPlace}
        onMapClick={onMapClick}
        onMapContext={onMapContext}
        onPinDrag={onPinDrag}
        onViewChange={onViewChange}
        myPins={myPins}
        myPinFocus={tab === 'maps' ? mapFocus : null}
        onMyPinClick={(id) => { setMapFocus(id); setTab('maps'); setSheetOpen(true) }}
        onMyPinDrag={(id, c) => { if (openMapId) updateMyMaps((s) => updateItem(s, openMapId, id, { coords: c })) }}
      />

      <div className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">📍</span><span className="brand-name">{APP_NAME}</span><span className="brand-tag">step-free first</span></div>
        {tab !== 'nearby' && tab !== 'maps' && <div className="layer-toggles" role="group" aria-label="Map layers">
          {(['restrooms', 'lighting', 'obstacles', 'reports'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={layers[k]} className={layers[k] ? 'on' : ''}
              onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}>
              {{ restrooms: '🚻 Restrooms', lighting: '💡 Lighting', obstacles: '🪜 Steps & curbs', reports: '⚠️ Reports' }[k]}
            </button>
          ))}
        </div>}
      </div>

      {navigating && (
        <div className="nav-banner" role="status" aria-live="polite">
          {nav?.arrived ? (
            <><span className="nav-arrow" aria-hidden="true">⚑</span><div className="nav-text"><strong>You have arrived</strong><span>{to?.name}</span></div></>
          ) : nav && navStep ? (
            <><span className="nav-arrow" aria-hidden="true">{navStep.icon}</span>
              <div className="nav-text"><span className="nav-dist">{formatDistance(nav.toNextMeters)}</span><strong>{navStep.text}</strong>
                {route && route.steps[nav.nextStep + 1] && <span className="nav-then">Then: {route.steps[nav.nextStep + 1].text}</span>}</div></>
          ) : (
            <><span className="nav-arrow" aria-hidden="true">◎</span><div className="nav-text"><strong>{loc.status === 'denied' ? 'Location is blocked' : !myLocation ? 'Finding your location…' : 'Finding a route…'}</strong>
              {loc.status === 'denied' && <span>Allow location for this site in your browser settings.</span>}</div></>
          )}
          {offRoute && routing && <span className="nav-reroute">Rerouting…</span>}
        </div>
      )}

      {navigating && (
        <div className="nav-footer">
          <div className="nav-stats">
            <strong>{nav ? formatDuration((route!.durationSeconds * nav.remainingMeters) / Math.max(route!.distanceMeters, 1)) : '—'}</strong>
            <span>{nav ? `${formatDistance(nav.remainingMeters)} · arrive ${new Date(now.getTime() + (route!.durationSeconds * nav.remainingMeters * 1000) / Math.max(route!.distanceMeters, 1)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Getting ready'}</span>
          </div>
          {!follow && <button type="button" className="nav-btn" onClick={() => setFollow(true)}>Re-center</button>}
          <button type="button" className="nav-btn icon" aria-expanded={markerMenu} aria-label="Change your location marker" title="Change your location marker"
            onClick={() => setMarkerMenu((o) => !o)}>
            <span className="marker-preview small" dangerouslySetInnerHTML={{ __html: markerHtml(resolveMarker(settings.marker ?? 'auto', true, settings.travelMode)) }} />
          </button>
          <button type="button" className="nav-btn icon" aria-pressed={voiceOn} aria-label={voiceOn ? 'Mute voice' : 'Turn voice on'}
            onClick={() => { setVoiceOn((v) => !v); try { window.speechSynthesis?.cancel() } catch { /* ignore */ } }}>{voiceOn ? '🔊' : '🔇'}</button>
          <button type="button" className="nav-btn end" onClick={endNav}>{nav?.arrived ? 'Done' : 'End'}</button>
        </div>
      )}

      {navigating && markerMenu && (
        <div className="marker-sheet" role="dialog" aria-label="Your location marker">
          <div className="marker-sheet-head"><strong>Your marker</strong>
            <button type="button" className="icon-btn" aria-label="Close" onClick={() => setMarkerMenu(false)}>✕</button></div>
          {markerChoices}
        </div>
      )}

      <nav className="dock" role="tablist" aria-label="Sections">
        {(['nearby', 'route', 'maps', 'report', 'settings'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => {
            setTab(t); setPick(null); setSheetOpen(true)
            if (t !== 'route') setNavOn(false)
            // Directions start from where you are, so ask for location as soon as they're opened.
            if (t === 'route' && (loc.status === 'prompt' || loc.status === 'unavailable')) loc.start()
          }}>
            <span className="dock-icon" aria-hidden="true">{TAB_INFO[t].icon}</span>
            <span className="dock-label">{TAB_INFO[t].label}</span>
          </button>
        ))}
      </nav>

      <button type="button" className="locate-btn" aria-label="Show my location" title="Show my location" onClick={locateMe}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      </button>

      {tab === 'nearby' && movedAway && (
        <button type="button" className="search-area" onClick={() => searchNearby(nearby.category!, nearby.radius, mapCenter)}>
          Search this area
        </button>
      )}

      {(pickHint || detailNotice) && tab !== 'nearby' && <div className="toast" role="status">{pickHint ?? detailNotice}</div>}
      {mapMenu && (
        <div className="map-menu" role="menu" style={{ left: Math.min(mapMenu.x, window.innerWidth - 230), top: Math.min(mapMenu.y, window.innerHeight - 200) }}>
          <div className="map-menu-title">{mapMenu.name ?? pinnedPlace(mapMenu.at).detail}</div>
          <button type="button" role="menuitem" onClick={() => fromMenu('to')}>🚩 Directions to here</button>
          <button type="button" role="menuitem" onClick={() => fromMenu('from')}>🟢 Directions from here</button>
          <button type="button" role="menuitem" disabled={stops.length >= MAX_STOPS} onClick={() => fromMenu('stop')}>➕ {to ? 'Add as a stop' : 'Add to trip'}</button>
          <button type="button" role="menuitem" onClick={() => {
            const id = savePlace({ name: mapMenu.name ?? 'Dropped pin', coords: mapMenu.at, source: 'pin' }, openMapId ?? undefined)
            setMapMenu(null); setOpenMapId(id); setTab('maps'); setSheetOpen(true)
          }}>📌 Save to My Maps</button>
          <button type="button" role="menuitem" className="muted" onClick={() => setMapMenu(null)}>Close</button>
        </div>
      )}

      {loc.status === 'prompt' && (
        <div className="loc-modal-backdrop">
          <div className="loc-modal" role="dialog" aria-modal="true" aria-labelledby="loc-title">
            <div className="loc-modal-icon" aria-hidden="true">📍</div>
            <h2 id="loc-title">Turn on your location</h2>
            <p>{APP_NAME} uses your location to show restaurants, coffee, shops and more near you, keep the map following you as you walk, and start directions from where you are.</p>
            <p className="muted small">Your location stays in your browser. It isn't saved or shared.</p>
            <button type="button" className="primary" autoFocus onClick={loc.start}>Use my location</button>
            <button type="button" className="link center" onClick={loc.dismiss}>Not now</button>
          </div>
        </div>
      )}

      <aside ref={panelRef} className={`panel ${sheetOpen ? 'open' : 'closed'} sheet-${sheet}`}>
        <button type="button" className="sheet-handle" onClick={() => setSheet((s) => (s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek'))}
          aria-label={sheet === 'peek' ? 'Show panel' : sheet === 'half' ? 'Expand panel' : 'Hide panel'} />
        <div className="panel-scroll" ref={panelScroll}>
        <header className="panel-head">
          <span className="panel-kicker">{TAB_INFO[tab].icon} {TAB_INFO[tab].label}</span>
          <h1>{tab === 'nearby' && searchPin ? `Around ${searchPin.name}` : TAB_INFO[tab].title}</h1>
        </header>

        <LocationNotice status={loc.status} onRetry={loc.start} />

        {tab === 'nearby' && (
          <section>
            {!selected && <>
            <SearchBox label="" placeholder="Search a place, address or city" value={null}
              near={searchCenter}
              onSelect={(p) => {
                if (!p) return
                // The place becomes the selected place: its pin, its related spots, and the center for categories.
                selectAnchor(p)
              }} />
            {searchPin && (
              <div className="place-card pin-card selected-card">
                <button type="button" className="pin-close" aria-label="Clear the selected place" onClick={() => setSearchPin(null)}>✕</button>
                {safeWebUrl(searchPin.photo) && <img className="pin-photo" src={safeWebUrl(searchPin.photo)} alt="" loading="lazy"
                  onError={(e) => { e.currentTarget.style.display = 'none' }} />}
                <span className="selected-kicker">Selected place</span>
                <h2>{searchPin.icon ?? '📍'} {searchPin.name}</h2>
                {searchPin.detail && <p className="muted">{searchPin.detail}</p>}
                {searchPin.about && <p className="pin-about">{searchPin.about[0].toUpperCase() + searchPin.about.slice(1)}</p>}
                <p className="muted small">{searchPin.coords[1].toFixed(4)}, {searchPin.coords[0].toFixed(4)}
                  {safeWebUrl(searchPin.wiki) && <> · <a href={safeWebUrl(searchPin.wiki)} target="_blank" rel="noreferrer">Read more on Wikipedia</a></>}</p>
                {(() => {
                  const wc = related.status === 'done' && related.result ? related.result.wheelchair : 'unknown'
                  return <p className={`wc wc-${wc}`}>{wc === 'unknown' ? '♿ ' : ''}{WHEELCHAIR_LINE[wc]}</p>
                })()}
                <div className="actions">
                  <button type="button" className="primary" onClick={() => {
                    setTo(searchPin); setFrom(null); if (loc.status !== 'live') loc.start(); setTab('route')
                  }}>Directions</button>
                  <button type="button" className="secondary" onClick={() => { setFollow(false); fly(searchPin.coords, false, zoomFor(searchPin)) }}>Show on map</button>
                  {saveSlot?.({ name: searchPin.name, coords: searchPin.coords, kind: searchPin.detail, icon: searchPin.icon, source: 'search', osmId: searchPin.osm ?? (searchPin.wikidata ? `wd:${searchPin.wikidata}` : undefined) })}
                </div>
              </div>
            )}
            {searchPin && (
              <RelatedPlaces anchorName={searchPin.name} status={related.status} result={related.result}
                activeId={activeSpot} scrollKey={spotScroll}
                onActivate={activateSpot}
                onExplore={(sp) => selectAnchor(spotPlace(sp))}
                onDirections={(sp) => { setTo(spotPlace(sp)); setFrom(null); if (loc.status !== 'live') loc.start(); setTab('route') }}
                onRetry={() => { setRelatedAnswer({ key: '', status: 'done', result: null }); setRelatedTry((n) => n + 1) }}
                saveSlot={saveSlot} />
            )}
            <p className="muted small loc-line">
              {searchPin ? <>📍 Categories search around <strong>{searchPin.name}</strong>. <button type="button" className="chip loc near-me" onClick={nearMe}><span aria-hidden="true">◎</span> Near me</button></>
                : loc.status === 'live' ? '📍 Showing places near your live location'
                : loc.status === 'asking' || loc.status === 'checking' ? 'Finding your location…'
                : <>Location is off, so places near the map center are shown. <button type="button" className="link" onClick={loc.start}>Turn on location</button></>}
            </p>
            <div className="cat-grid" role="group" aria-label="Categories">
              {CATEGORIES.filter((c, i) => moreCats || i < 7 || c.id === nearby.category).map((c) => (
                <button key={c.id} type="button" aria-pressed={nearby.category === c.id}
                  className={nearby.category === c.id ? 'active' : ''} style={{ '--cat': c.color } as CSSProperties}
                  onClick={() => pickCategory(c.id)}>
                  <span className="cat-icon" aria-hidden="true">{c.icon}</span>{c.label}
                </button>
              ))}
              <button type="button" aria-expanded={moreCats} onClick={() => setMoreCats((m) => !m)}>
                <span className="cat-icon" aria-hidden="true">{moreCats ? '▴' : '⋯'}</span>{moreCats ? 'Less' : 'More'}
              </button>
            </div>

            {nearby.category && (
              <div className="filters">
                <label>
                  <span className="sr-only">Distance</span>
                  <select value={snapRadius(nearby.radius)} onChange={(e) => searchNearby(nearby.category!, Number(e.target.value), nearby.center ?? aroundCenter)}>
                    {radii.map((r) => <option key={r.m} value={r.m}>Within {r.label}</option>)}
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
                  Open now
                </label>
                <label className="check">
                  <input type="checkbox" checked={accessibleOnly} onChange={(e) => setAccessibleOnly(e.target.checked)} />
                  ♿ Accessible
                </label>
              </div>
            )}
            </>}

            {selected && (
              <div className="place-card detail" style={{ '--cat': CATEGORY_BY_ID[selected.category]?.color ?? '#5b3df5' } as CSSProperties}>
                <button type="button" className="back link" onClick={() => setSelectedId(null)}>← All results</button>
                <div className="place-hero">
                  <span className="place-hero-icon" aria-hidden="true">{CATEGORY_BY_ID[selected.category]?.icon}</span>
                  <div>
                    <h2>{selected.name}</h2>
                    <p className="muted">{selected.kind} · {formatDistance(selected.distance)} away</p>
                  </div>
                </div>
                {selected.address && <p>{selected.address}</p>}
                <OpenLine status={statusById.get(selected.id) ?? null} />
                {selected.openingHours && <p className="muted small">Hours: {selected.openingHours}</p>}
                <p className={`wc wc-${selected.wheelchair}`}>{WHEELCHAIR_TEXT[selected.wheelchair]}</p>
                <div className="actions">
                  <button type="button" className="primary" onClick={() => directionsTo(selected)}>Directions</button>
                  {selected.phone && telHref(selected.phone) && <a className="secondary" href={telHref(selected.phone)}>Call</a>}
                  {safeWebUrl(selected.website) && <a className="secondary" href={safeWebUrl(selected.website)} target="_blank" rel="noreferrer">Website</a>}
                  <SaveToMap place={{ name: selected.name, coords: selected.coords, kind: selected.kind, icon: CATEGORY_BY_ID[selected.category]?.icon, source: 'search', osmId: selected.id }} />
                </div>
                <button type="button" className="link small" onClick={() => selectAnchor({ name: selected.name, detail: selected.kind, coords: selected.coords, icon: CATEGORY_BY_ID[selected.category]?.icon, osm: selected.id })}>
                  See related places around {selected.name}
                </button>
                <a className="small" href={`https://www.openstreetmap.org/${selected.id}`} target="_blank" rel="noreferrer">Fix or add details on OpenStreetMap</a>
              </div>
            )}

            {!selected && nearby.status === 'idle' && <p className="muted">Pick a category to see what's nearby.</p>}
            {!selected && nearby.status === 'loading' && <p className="muted" role="status">Looking for {CATEGORY_BY_ID[nearby.category!].label.toLowerCase()} nearby…</p>}
            {!selected && nearby.status === 'error' && (
              <p className="error" role="alert">Couldn't load places right now. <button type="button" className="link" onClick={() => searchNearby(nearby.category!, nearby.radius, nearby.center ?? aroundCenter)}>Try again</button></p>
            )}
            {!selected && nearby.status === 'done' && (
              shownPlaces.length === 0 ? (
                <p className="muted">
                  {openOnly && nearby.places.length > 0 ? 'Nothing open right now that lists its hours. ' : `Nothing found within ${formatDistance(nearby.radius)}. `}
                  {nearby.radius < radii[radii.length - 1].m && (
                    <button type="button" className="link" onClick={() => searchNearby(nearby.category!, radii.find((r) => r.m > nearby.radius)?.m ?? nearby.radius, nearby.center ?? aroundCenter)}>Search wider</button>
                  )}
                </p>
              ) : (
                <>
                  {nearby.widenedFrom && <p className="muted small">Nothing within {formatDistance(nearby.widenedFrom)}, so we looked further out.</p>}
                  <p className="muted small">{shownPlaces.length} {shownPlaces.length === 1 ? 'place' : 'places'}, nearest first{!openOnly && openCount > 0 ? ` · ${openCount} open now` : ''}</p>
                  <ul className="results">
                    {shownPlaces.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => { rememberPlace(p); setSelectedId(p.id); setFollow(false); fly(p.coords) }}>
                          <span className="res-icon" style={{ '--cat': CATEGORY_BY_ID[p.category]?.color } as CSSProperties} aria-hidden="true">{CATEGORY_BY_ID[p.category]?.icon}</span>
                          <span className="res-text">
                            <strong>{p.name}</strong>
                            <span>{p.kind}{p.address ? ` · ${p.address}` : ''}</span>
                            <OpenLine status={statusById.get(p.id) ?? null} compact />
                            {p.wheelchair !== 'unknown' && <span className={`wc wc-${p.wheelchair}`}>{WHEELCHAIR_TEXT[p.wheelchair]}</span>}
                          </span>
                          <span className="res-dist">{formatDistance(p.distance)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )
            )}

            {!selected && (
              <div className="recent">
                <div className="recent-head">
                  <h2>Recent</h2>
                  {history.length > 0 && <button type="button" className="link" onClick={() => setHistory([])}>Clear all</button>}
                </div>
                {history.length === 0
                  ? <p className="muted small">Places you search for and trips you plan show up here.</p>
                  : (
                    <ul className="recent-list">
                      {history.map((h) => {
                        const look = historyLook(h)
                        return (
                          <li key={`${h.kind}-${h.at}`}>
                            <button type="button" className="recent-open" onClick={() => openHistory(h)}>
                              <span className="recent-icon" aria-hidden="true">{look.icon}</span>
                              <span className="res-text"><strong>{look.title}</strong><span>{look.sub ? `${look.sub} · ` : ''}{timeAgo(h.at, now.getTime())}</span></span>
                            </button>
                            <button type="button" className="recent-remove" aria-label={`Remove ${look.title} from Recent`}
                              onClick={() => setHistory((all) => all.filter((x) => x !== h))}>✕</button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </div>
            )}
          </section>
        )}

        {tab === 'route' && (
          <section>
            <div className="modes" role="radiogroup" aria-label="Travel mode">
              {(Object.keys(TRAVEL_MODES) as TravelMode[]).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'active' : ''}
                  onClick={() => setTravelMode(m)}>
                  <span aria-hidden="true">{TRAVEL_MODES[m].icon}</span>{TRAVEL_MODES[m].label}
                </button>
              ))}
            </div>

            <div className="trip">
              <ol className="trip-points">
                <li>
                  <span className="trip-dot start" aria-hidden="true" />
                  <SearchBox label="Start" hideLabel value={fromPlace} near={searchCenter} onFocus={() => setActiveField('from')}
                    placeholder={loc.status === 'asking' ? 'Finding your location…' : 'Choose a starting point'}
                    onSelect={(p) => { setFrom(p); if (p) fly(p.coords) }}
                    extraOptions={[{ label: 'Use my location', onPick: useMyLocation }, { label: 'Pick on map', onPick: () => startPick('from') }]} />
                </li>
                {stops.map((st, i) => (
                  <li key={st.id}>
                    <span className="trip-dot stop" aria-hidden="true">{i + 1}</span>
                    <SearchBox label={`Stop ${i + 1}`} hideLabel value={st.place} placeholder={`Add stop ${i + 1}`} onFocus={() => setActiveField(`stop-${st.id}`)}
                      near={fromPlace?.coords ?? searchCenter}
                      onSelect={(p) => { setStop(st.id, p); if (p) fly(p.coords) }}
                      extraOptions={[{ label: 'Pick on map', onPick: () => startPick(`stop-${st.id}`) }]} />
                    <button type="button" className="icon-btn" aria-label={`Remove stop ${i + 1}`} onClick={() => removeStop(st.id)}>✕</button>
                  </li>
                ))}
                <li>
                  <span className="trip-dot end" aria-hidden="true" />
                  <SearchBox label="Destination" hideLabel value={to} placeholder="Choose a destination or tap the map" onFocus={() => setActiveField('to')}
                    near={fromPlace?.coords ?? searchCenter}
                    onSelect={(p) => { setTo(p); if (p) fly(p.coords); else setNavOn(false) }}
                    extraOptions={[{ label: 'Pick on map', onPick: () => startPick('to') }]} />
                </li>
              </ol>
              <button type="button" className="icon-btn swap" aria-label="Swap start and destination" title="Swap start and destination"
                disabled={!fromPlace && !to} onClick={swapTrip}>⇅</button>
            </div>

            <div className="trip-actions">
              <button type="button" className="chip" disabled={stops.length >= MAX_STOPS} onClick={() => addStop()}>＋ Add stop</button>
              {(from !== null || loc.status !== 'live') && (
                <button type="button" className="chip loc" onClick={useMyLocation}>
                  <span aria-hidden="true">◎</span> {loc.status === 'asking' ? 'Finding your location…' : 'Use my live location'}
                </button>
              )}
            </div>
            {from === null && loc.status === 'live' && <p className="muted small">Starting from your live location.</p>}

            {mode === 'accessible' && (
              <div className="profile-row">
                <span>Route for</span>
                <select value={settings.profile} onChange={(e) => setProfile(e.target.value as MobilityProfile)}>
                  {Object.entries(PROFILE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            )}

            <button type="button" className="primary" disabled={!fromPlace || !to || routing} onClick={findRoute}>
              {routing ? 'Finding a route…' : mode === 'accessible' ? 'Find step-free route' : 'Get directions'}
            </button>
            {routeError && <p className="error" role="alert">{routeError}</p>}

            {route && (
              <div className="route-summary" ref={routeCard}>
                <div className="route-hero">
                  <span className="route-mode" aria-hidden="true">{TRAVEL_MODES[mode].icon}</span>
                  <div className="route-stats">
                    <p className="route-time">{formatDuration(route.durationSeconds)}</p>
                    <p className="route-meta">{formatDistance(route.distanceMeters)} · {TRAVEL_MODES[mode].label}{stopPlaces.length > 0 ? ` · ${stopPlaces.length} stop${stopPlaces.length > 1 ? 's' : ''}` : ''}</p>
                  </div>
                  <div className="route-eta"><span>Arrive</span><strong>{arrival}</strong></div>
                </div>
                <button type="button" className="primary start-nav" onClick={startNav}>
                  <span aria-hidden="true">➤</span> Start
                </button>
                {to && <p className="route-to"><span className="muted">To</span> <strong>{to.name}</strong>{to.detail ? <span className="muted">, {to.detail}</span> : null}</p>}
                {mode === 'accessible' && (
                  <p className={route.stepFreeVerified ? 'ok' : 'warn'}>
                    {route.stepFreeVerified ? 'Avoids steps' : 'Not verified step-free'}
                  </p>
                )}
                {route.warnings.length === 0 ? (
                  mode !== 'car' && mode !== 'bike' && <p className="ok">No problems reported along this route.</p>
                ) : (
                  <ul className="warnings">
                    {route.warnings.map((w, i) => (
                      <li key={i} className={`w-${w.kind}`}>
                        {w.coords ? <button type="button" onClick={() => fly(w.coords!)}>{w.message}</button> : w.message}
                      </li>
                    ))}
                  </ul>
                )}
                {route.steps.length > 0 && (
                  <div className="route-steps">
                    <button type="button" className="steps-toggle" aria-expanded={showSteps} onClick={() => setShowSteps((v) => !v)}>
                      <span>{showSteps ? 'Hide directions' : 'Show directions'}</span>
                      <span className="muted">{route.steps.length} steps {showSteps ? '▴' : '▾'}</span>
                    </button>
                    {showSteps && (
                      <ol>
                        {route.steps.map((st, i) => (
                          <li key={i}>
                            <button type="button" onClick={() => { setFollow(false); fly(st.coords) }}>
                              <span className="step-icon" aria-hidden="true">{st.icon}</span>
                              <span className="step-text">{st.text}</span>
                              {st.distanceMeters >= 1 && <span className="step-dist">{formatDistance(st.distanceMeters)}</span>}
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            )}

            {to && destInfo && (
              <div className="place-card">
                <h2>{to.name}</h2>
                {to.detail && <p className="muted">{to.detail}</p>}
                <p>
                  Nearest accessible restroom:{' '}
                  {destInfo.restroom
                    ? <button type="button" className="link" onClick={() => fly(destInfo.restroom!.r.coords)}>{destInfo.restroom.r.name}, {formatDistance(destInfo.restroom.d)} away</button>
                    : 'none found in the area shown on the map'}
                </p>
                {destInfo.nearbyReports.length > 0 && (
                  <ul className="warnings">
                    {destInfo.nearbyReports.map((r) => <li key={r.id} className="w-report">{REPORT_LABELS[r.type]} nearby, {timeAgo(r.createdAt)}</li>)}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        {tab === 'maps' && (
          <MyMapsPanel openId={openMapId} onOpen={setOpenMapId} focusId={mapFocus} onFocus={setMapFocus}
            dropping={pick === 'my-pin'} myLocation={myLocation}
            onDropPin={() => (pick === 'my-pin' ? setPick(null) : startPick('my-pin'))}
            onShow={(c) => { setFollow(false); fly(c) }}
            onFit={(pts) => { setFollow(false); setFitTo({ points: pts, key: Date.now() }) }}
            onDirections={directionsToItem} />
        )}

        {tab === 'report' && (
          <section>
            <p>Tap the map where the problem is, choose what's wrong, and send. Reports show for {REPORT_LIFETIME_DAYS} days.</p>
            <p className={draft.coords ? 'ok' : 'muted'}>{draft.coords ? 'Location set. Tap the map again to move it.' : 'No location yet. Tap the map.'}</p>
            <div className="chips" role="radiogroup" aria-label="Problem type">
              {Object.entries(REPORT_LABELS).map(([k, v]) => (
                <button key={k} type="button" role="radio" aria-checked={draft.type === k} className={draft.type === k ? 'active' : ''}
                  onClick={() => setDraft({ ...draft, type: k as ReportType })}>{v}</button>
              ))}
            </div>
            <label className="field">
              <span>Note (optional)</span>
              <input value={draft.note} maxLength={140} placeholder="e.g. East entrance elevator" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </label>
            <button type="button" className="primary" disabled={!draft.coords} onClick={submitReport}>Send report</button>
            <p className="muted small">Reports are saved in this browser for now. Sharing them with everyone comes next.</p>
            {reports.length > 0 && (
              <>
                <h2>Your recent reports</h2>
                <ul className="report-list">
                  {[...reports].reverse().map((r) => (
                    <li key={r.id}>
                      <button type="button" className="link" onClick={() => fly(r.coords)}>{REPORT_LABELS[r.type]}</button>
                      <span className="muted"> · {timeAgo(r.createdAt)}</span>
                      <button type="button" className="remove" aria-label="Remove report" onClick={() => setReports((rs) => rs.filter((x) => x.id !== r.id))}>×</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {tab === 'settings' && (
          <section>
            <div className="field">
              <span>Your location marker</span>
              {markerChoices}
            </div>
            <div className="field">
              <span>Map look</span>
              <div className="seg" role="radiogroup" aria-label="Map look">
                {(Object.keys(MAP_STYLES) as MapStyleId[]).map((id) => (
                  <button key={id} type="button" role="radio" aria-checked={settings.mapLook === id}
                    className={settings.mapLook === id ? 'active' : ''}
                    onClick={() => setSettings({ ...settings, mapLook: id, lookPicked: true })}>{MAP_STYLES[id].label}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Distances</span>
              <div className="seg" role="radiogroup" aria-label="Distance units">
                {([['auto', `Automatic (${autoUnits === 'mi' ? 'miles' : 'km'})`], ['mi', 'Miles'], ['km', 'Kilometers']] as const).map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={settings.units === id}
                    className={settings.units === id ? 'active' : ''}
                    onClick={() => setSettings({ ...settings, units: id })}>{label}</button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>Borders and place names</span>
              <select value={worldviewSetting} disabled={urlWorldview != null}
                onChange={(e) => setSettings({ ...settings, worldview: e.target.value as WorldviewSetting })}>
                <option value="auto">Automatic{autoNameView ? ` (as shown in ${WORLDVIEWS[autoNameView]})` : ' (as on the ground)'}</option>
                <option value="osm">As on the ground (OpenStreetMap)</option>
                {(Object.entries(WORLDVIEWS) as [WorldviewCode, string][])
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([code, name]) => <option key={code} value={code}>As shown in {name}</option>)}
              </select>
            </label>
            <p className="muted small">Some borders and names are disputed. Like Google Maps and Apple Maps, {APP_NAME} can show them the way a country officially does: for example, the Gulf of America in the United States and the Gulf of Mexico in Mexico. Automatic follows your region.</p>
            <label className="field">
              <span>Mobility profile</span>
              <select value={settings.profile} onChange={(e) => setProfile(e.target.value as MobilityProfile)}>
                {Object.entries(PROFILE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Steepest slope I can manage: {settings.maxInclinePercent}%</span>
              <input type="range" min={3} max={15} step={1} value={settings.maxInclinePercent}
                onChange={(e) => setSettings({ ...settings, maxInclinePercent: Number(e.target.value) })} />
            </label>
            <p className="muted small">Saved on this device. No account needed.</p>
            {!ORS_KEY && (
              <p className="warn small">Step-free routing is off: add a free OpenRouteService key (see README). Until then routes use plain walking directions with step warnings.</p>
            )}
          </section>
        )}

        {tab === 'nearby' || tab === 'maps' ? (
          <footer className="legend"><span className="credit">Places and map data © OpenStreetMap contributors</span></footer>
        ) : (
        <footer className="legend">
          <span><i className="dot" style={{ background: '#15803d' }} /> Accessible restroom</span>
          <span><i className="dot" style={{ background: '#dc2626' }} /> Reported problem</span>
          <span><i className="dot" style={{ background: '#b45309' }} /> Steps or high curb</span>
          <span><i className="dot" style={{ background: '#7c3aed' }} /> Restroom, not accessible</span>
          <span className="credit">Map data © OpenStreetMap contributors</span>
        </footer>
        )}
        </div>
      </aside>
    </div>
  )
}

function OpenLine({ status, compact = false }: { status: ReturnType<typeof openStatus>; compact?: boolean }) {
  if (!status) return compact ? null : <p className="muted small">Hours not listed</p>
  const Tag = compact ? 'span' : 'p'
  return (
    <Tag className="open-line">
      <b className={status.open ? 'is-open' : 'is-closed'}>{status.open ? 'Open' : 'Closed'}</b>
      {status.detail !== 'Closed' && <> · {status.detail}</>}
    </Tag>
  )
}

function LocationNotice({ status, onRetry }: { status: ReturnType<typeof useLiveLocation>['status']; onRetry: () => void }) {
  if (status === 'denied') {
    const help = locationHelp()
    return (
      <div className="loc-notice" role="alert">
        <strong>Location is blocked for this site</strong>
        <p>{help.browser}</p>
        {help.device && <p className="muted small">{help.device}</p>}
        <button type="button" className="link" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    )
  }
  if (status === 'unsupported') {
    return (
      <div className="loc-notice" role="alert">
        <strong>This browser can't share your location</strong>
        <p>Open this page in Chrome, Edge, Safari or Firefox to use your live location. In-app browsers often can't.</p>
      </div>
    )
  }
  if (status === 'unavailable') {
    return (
      <div className="loc-notice soft" role="status">
        <strong>Location is off</strong>
        <p>Turn it on to see places near you and start directions from where you are. Some built-in app browsers can't share location; if nothing happens, open this page in Chrome, Edge or Safari.</p>
        <button type="button" className="primary small-btn" onClick={onRetry}>Use my location</button>
      </div>
    )
  }
  return null
}

function historyLook(h: HistoryItem): { icon: string; title: string; sub: string } {
  if (h.kind === 'place') return { icon: '📍', title: h.place.name, sub: h.place.detail }
  if (h.kind === 'category') {
    const c = CATEGORY_BY_ID[h.category]
    return { icon: c?.icon ?? '🔎', title: `${c?.label ?? h.category} near you`, sub: '' }
  }
  return { icon: TRAVEL_MODES[h.mode]?.icon ?? '🧭', title: `${h.from?.name ?? 'My location'} → ${h.to.name}`, sub: TRAVEL_MODES[h.mode]?.label ?? '' }
}
