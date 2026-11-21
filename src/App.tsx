import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MapView, type Layers } from './components/MapView'
import { SearchBox } from './components/SearchBox'
import { APP_NAME, ORS_KEY, PILOT_CITY, REPORT_LIFETIME_DAYS } from './config'
import { bboxOf, distanceMeters, formatDistance, formatDuration } from './lib/geo'
import { fetchAccessData, type AccessData } from './lib/overpass'
import { openStatus } from './lib/hours'
import { locationHelp, useLiveLocation } from './lib/useLiveLocation'
import { CATEGORIES, CATEGORY_BY_ID, fetchNearby, type NearbyPlace } from './lib/places'
import { loadReports, saveReports, timeAgo } from './lib/reports'
import { planRoute } from './lib/routing'
import { loadSettings, saveSettings } from './lib/settings'
import { PROFILE_LABELS, REPORT_LABELS } from './lib/types'
import type { LngLat, MobilityProfile, Place, Report, ReportType, RouteResult, Settings } from './lib/types'

type Tab = 'nearby' | 'route' | 'report' | 'settings'
type Pick = 'from' | 'to' | 'report' | null

const MIN_DETAIL_ZOOM = 14
const RADII = [500, 1000, 2000, 5000]

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
}

function pinnedPlace(c: LngLat, name = 'Dropped pin'): Place {
  return { name, detail: `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`, coords: c }
}

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
  const [viewBase, setViewBase] = useState<LngLat | null>(null)
  const appMoving = useRef(false)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [reports, setReports] = useState<Report[]>(() => loadReports())
  const [access, setAccess] = useState<AccessData | null>(null)
  const [detailNotice, setDetailNotice] = useState<string | null>(null)
  const [layers, setLayers] = useState<Layers>({ restrooms: true, lighting: false, reports: true, obstacles: true })
  const [from, setFrom] = useState<Place | null>(null)
  const [to, setTo] = useState<Place | null>(null)
  const [pick, setPick] = useState<Pick>(null)
  const [routeState, setRouteState] = useState<{ key: string; route: RouteResult | null; error: string | null }>({ key: '', route: null, error: null })
  const [routing, setRouting] = useState(false)
  const [flyTo, setFlyTo] = useState<LngLat | null>(null)
  const [draft, setDraft] = useState<{ coords: LngLat | null; type: ReportType; note: string }>({ coords: null, type: 'broken-elevator', note: '' })
  const [sheetOpen, setSheetOpen] = useState(true)
  const viewCtrl = useRef<AbortController | null>(null)
  const viewTimer = useRef<number | undefined>(undefined)

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => saveReports(reports), [reports])

  const setProfile = (profile: MobilityProfile) => {
    setSettings((s) => ({ ...s, profile }))
    // Night walking is all about lighting, so show that layer automatically.
    if (profile === 'night') setLayers((l) => ({ ...l, lighting: true }))
  }

  const locateMe = () => {
    setFollow(true)
    if (myLocation) setFlyTo([...myLocation] as LngLat)
    if (loc.status !== 'live') loc.start()
  }

  const searchNearby = useCallback((category: string, radius: number, center: LngLat) => {
    const cat = CATEGORY_BY_ID[category]
    nearbyCtrl.current?.abort()
    const ctrl = new AbortController()
    nearbyCtrl.current = ctrl
    setSelectedId(null)
    setNearby({ category, radius, center, places: [], status: 'loading' })
    fetchNearby(cat, center, radius, ctrl.signal)
      .then((places) => {
        setNearby({ category, radius, center, places, status: 'done' })
        if (places.length) appMoving.current = true
        if (places.length) setFitTo({ points: [center, ...places.slice(0, 15).map((p) => p.coords)], key: Date.now() })
      })
      .catch((e) => { if (e.name !== 'AbortError') setNearby((n) => ({ ...n, status: 'error' })) })
  }, [])

  const searchCenter = myLocation ?? mapCenter
  const pickCategory = (id: string) => {
    if (nearby.category === id) { // tapping the active category again clears it
      nearbyCtrl.current?.abort()
      setNearby((n) => ({ ...n, category: null, places: [], status: 'idle' }))
      setSelectedId(null)
      return
    }
    searchNearby(id, nearby.radius, searchCenter)
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
  const movedAway = nearby.status === 'done' && nearby.category != null && !selected &&
    distanceMeters(viewBase ?? nearby.center ?? mapCenter, mapCenter) > Math.max(400, nearby.radius * 0.6)

  const selectPlace = useCallback((id: string) => {
    setSelectedId(id)
    setTab('nearby')
    setSheetOpen(true)
  }, [])

  // Bring the place card into view when a place is picked from the list or the map.
  useEffect(() => { if (selectedId) panelScroll.current?.scrollTo({ top: 0 }) }, [selectedId])

  const directionsTo = (p: NearbyPlace) => {
    setTo({ name: p.name, detail: p.address ?? p.kind, coords: p.coords })
    setFrom(null) // start from wherever you are
    if (loc.status !== 'live') loc.start()
    setTab('route')
  }

  const onViewChange = useCallback((bbox: [number, number, number, number], zoom: number) => {
    const c: LngLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
    setMapCenter(c)
    if (appMoving.current) { appMoving.current = false; setViewBase(c) }
    window.clearTimeout(viewTimer.current)
    viewCtrl.current?.abort()
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

  const onMapClick = useCallback((c: LngLat) => {
    if (pick === 'from') setFrom(pinnedPlace(c))
    else if (pick === 'to') setTo(pinnedPlace(c))
    else if (pick === 'report' || tab === 'report') setDraft((d) => ({ ...d, coords: c }))
    else return
    setPick(null)
  }, [pick, tab])

  // With no start chosen, Directions start from wherever you are right now.
  const useMyLocation = () => {
    setFrom(null)
    if (loc.status !== 'live') loc.start()
  }
  const fromPlace: Place | null = from ?? (myLocation ? pinnedPlace(myLocation, 'My location') : null)

  const loadRouteAccess = useCallback(async (line: LngLat[]) => {
    const [w, s, e, n] = bboxOf(line)
    if (e - w > 0.08 || n - s > 0.08) return null // too large an area to check in one go
    const data = await fetchAccessData([w, s, e, n])
    setAccess(data) // show what we found along the route on the map too
    return data
  }, [])

  // A route belongs to one trip; changing the start, end or profile hides the old one.
  const tripKey = JSON.stringify([from ? from.coords : myLocation ? 'me' : null, to?.coords, settings.profile, settings.maxInclinePercent])
  const route = routeState.key === tripKey ? routeState.route : null
  const routeError = routeState.key === tripKey ? routeState.error : null

  const findRoute = async () => {
    if (!fromPlace || !to) return
    const key = tripKey
    setRouting(true); setRouteState({ key, route: null, error: null })
    try {
      setRouteState({ key, route: await planRoute(fromPlace.coords, to.coords, settings, loadRouteAccess, reports), error: null })
    } catch (e) {
      setRouteState({ key, route: null, error: e instanceof Error ? e.message : 'Routing failed' })
    } finally {
      setRouting(false)
    }
  }


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

  const pickHint = pick === 'from' ? 'Tap the map to set your start' : pick === 'to' ? 'Tap the map to set your destination' : null

  return (
    <div className="app">
      <MapView
        access={access}
        reports={reports}
        route={route}
        from={from?.coords ?? null}
        to={to?.coords ?? null}
        layers={layers}
        flyTo={flyTo}
        places={tab === 'nearby' ? shownPlaces : selected ? [selected] : []}
        selectedPlaceId={selectedId}
        myLocation={myLocation}
        myAccuracy={loc.accuracy}
        follow={follow && loc.status === 'live'}
        onUserMove={() => setFollow(false)}
        fitTo={fitTo}
        onPlaceClick={selectPlace}
        onMapClick={onMapClick}
        onViewChange={onViewChange}
      />

      {tab !== 'nearby' && <div className="layer-toggles" role="group" aria-label="Map layers">
        {(['restrooms', 'lighting', 'obstacles', 'reports'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={layers[k]} className={layers[k] ? 'on' : ''}
            onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}>
            {{ restrooms: 'Restrooms', lighting: 'Lighting', obstacles: 'Steps & curbs', reports: 'Reports' }[k]}
          </button>
        ))}
      </div>}

      <button type="button" className="locate-btn" aria-label="Show my location" title="Show my location" onClick={locateMe}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      </button>

      {tab === 'nearby' && movedAway && (
        <button type="button" className="search-area" onClick={() => searchNearby(nearby.category!, nearby.radius, mapCenter)}>
          Search this area
        </button>
      )}

      {(pickHint || detailNotice) && tab !== 'nearby' && <div className="toast" role="status">{pickHint ?? detailNotice}</div>}

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

      <aside className={`panel ${sheetOpen ? 'open' : 'closed'}`}>
        <button type="button" className="sheet-handle" onClick={() => setSheetOpen((o) => !o)} aria-label={sheetOpen ? 'Hide panel' : 'Show panel'} />
        <div className="panel-scroll" ref={panelScroll}>
        <header>
          <h1><span className="logo" aria-hidden="true">📍</span> {APP_NAME}</h1>
          <p className="sub">Find places near you, with step-free walking directions</p>
        </header>

        <LocationNotice status={loc.status} onRetry={loc.start} />

        <nav className="tabs" role="tablist">
          {(['nearby', 'route', 'report', 'settings'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setPick(null) }}>
              {{ nearby: 'Near me', route: 'Directions', report: 'Report', settings: 'Profile' }[t]}
            </button>
          ))}
        </nav>

        {tab === 'nearby' && (
          <section>
            {!selected && <>
            <SearchBox label="" placeholder="Search a place, address or city" value={null}
              near={searchCenter}
              onSelect={(p) => {
                if (!p) return
                appMoving.current = true
                setFlyTo(p.coords)
                // A specific address becomes the new "near" point for the categories.
                if (nearby.category) searchNearby(nearby.category, nearby.radius, p.coords)
              }} />
            <p className="muted small loc-line">
              {loc.status === 'live' ? '📍 Showing places near your live location'
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
                  <select value={nearby.radius} onChange={(e) => searchNearby(nearby.category!, Number(e.target.value), nearby.center ?? searchCenter)}>
                    {RADII.map((r) => <option key={r} value={r}>Within {formatDistance(r)}</option>)}
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
              <div className="place-card detail">
                <button type="button" className="back link" onClick={() => setSelectedId(null)}>← All results</button>
                <h2>{selected.name}</h2>
                <p className="muted">{CATEGORY_BY_ID[selected.category]?.icon} {selected.kind} · {formatDistance(selected.distance)} away</p>
                {selected.address && <p>{selected.address}</p>}
                <OpenLine status={statusById.get(selected.id) ?? null} />
                {selected.openingHours && <p className="muted small">Hours: {selected.openingHours}</p>}
                <p className={`wc wc-${selected.wheelchair}`}>{WHEELCHAIR_TEXT[selected.wheelchair]}</p>
                <div className="actions">
                  <button type="button" className="primary" onClick={() => directionsTo(selected)}>Directions</button>
                  {selected.phone && <a className="secondary" href={`tel:${selected.phone.replace(/[^+\d]/g, '')}`}>Call</a>}
                  {selected.website && <a className="secondary" href={selected.website} target="_blank" rel="noreferrer">Website</a>}
                </div>
                <a className="small" href={`https://www.openstreetmap.org/${selected.id}`} target="_blank" rel="noreferrer">Fix or add details on OpenStreetMap</a>
              </div>
            )}

            {!selected && nearby.status === 'idle' && <p className="muted">Pick a category to see what's nearby.</p>}
            {!selected && nearby.status === 'loading' && <p className="muted" role="status">Looking for {CATEGORY_BY_ID[nearby.category!].label.toLowerCase()} nearby…</p>}
            {!selected && nearby.status === 'error' && (
              <p className="error" role="alert">Couldn't load places right now. <button type="button" className="link" onClick={() => searchNearby(nearby.category!, nearby.radius, nearby.center ?? searchCenter)}>Try again</button></p>
            )}
            {!selected && nearby.status === 'done' && (
              shownPlaces.length === 0 ? (
                <p className="muted">
                  {openOnly && nearby.places.length > 0 ? 'Nothing open right now that lists its hours. ' : `Nothing found within ${formatDistance(nearby.radius)}. `}
                  {nearby.radius < RADII[RADII.length - 1] && (
                    <button type="button" className="link" onClick={() => searchNearby(nearby.category!, RADII[RADII.indexOf(nearby.radius) + 1] ?? 5000, nearby.center ?? searchCenter)}>Search wider</button>
                  )}
                </p>
              ) : (
                <>
                  <p className="muted small">{shownPlaces.length} {shownPlaces.length === 1 ? 'place' : 'places'}, nearest first{!openOnly && openCount > 0 ? ` · ${openCount} open now` : ''}</p>
                  <ul className="results">
                    {shownPlaces.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => { setSelectedId(p.id); appMoving.current = true; setFlyTo(p.coords) }}>
                          <span className="res-icon" style={{ background: CATEGORY_BY_ID[p.category]?.color }} aria-hidden="true">{CATEGORY_BY_ID[p.category]?.icon}</span>
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
          </section>
        )}

        {tab === 'route' && (
          <section>
            <SearchBox label="From" placeholder={loc.status === 'asking' ? 'Finding your location…' : 'Search a start point'} value={fromPlace}
              onSelect={(p) => { setFrom(p); if (p) setFlyTo(p.coords) }}
              extraOptions={[{ label: 'Use my location', onPick: useMyLocation }, { label: 'Pick on map', onPick: () => setPick('from') }]} />
            <SearchBox label="To" placeholder="Search a destination" value={to}
              onSelect={(p) => { setTo(p); if (p) setFlyTo(p.coords) }}
              extraOptions={[{ label: 'Pick on map', onPick: () => setPick('to') }]} />

            <div className="profile-row">
              <span>Route for</span>
              <select value={settings.profile} onChange={(e) => setProfile(e.target.value as MobilityProfile)}>
                {Object.entries(PROFILE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>

            <button type="button" className="primary" disabled={!fromPlace || !to || routing} onClick={findRoute}>
              {routing ? 'Finding a route…' : 'Find step-free route'}
            </button>
            {routeError && <p className="error" role="alert">{routeError}</p>}

            {route && (
              <div className="route-summary">
                <p className="big">{formatDuration(route.durationSeconds)} · {formatDistance(route.distanceMeters)}</p>
                <p className={route.stepFreeVerified ? 'ok' : 'warn'}>
                  {route.stepFreeVerified ? 'Avoids steps' : 'Not verified step-free'}
                </p>
                {route.warnings.length === 0 ? (
                  <p className="ok">No problems reported along this route.</p>
                ) : (
                  <ul className="warnings">
                    {route.warnings.map((w, i) => (
                      <li key={i} className={`w-${w.kind}`}>
                        {w.coords ? <button type="button" onClick={() => setFlyTo(w.coords!)}>{w.message}</button> : w.message}
                      </li>
                    ))}
                  </ul>
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
                    ? <button type="button" className="link" onClick={() => setFlyTo(destInfo.restroom!.r.coords)}>{destInfo.restroom.r.name}, {formatDistance(destInfo.restroom.d)} away</button>
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
                      <button type="button" className="link" onClick={() => setFlyTo(r.coords)}>{REPORT_LABELS[r.type]}</button>
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

        {tab === 'nearby' ? (
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
