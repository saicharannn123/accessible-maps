import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MapView, type Layers } from './components/MapView'
import { SearchBox } from './components/SearchBox'
import { APP_NAME, ORS_KEY, PILOT_CITY, REPORT_LIFETIME_DAYS } from './config'
import { bboxOf, distanceMeters, formatDistance, formatDuration } from './lib/geo'
import { fetchAccessData, type AccessData } from './lib/overpass'
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

type LocStatus = 'asking' | 'found' | 'unavailable'
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
  const [myLocation, setMyLocation] = useState<LngLat | null>(null)
  const [locStatus, setLocStatus] = useState<LocStatus>('asking')
  const [mapCenter, setMapCenter] = useState<LngLat>(PILOT_CITY.center)
  const [nearby, setNearby] = useState<Nearby>({ category: null, radius: 1000, center: null, places: [], status: 'idle' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [accessibleOnly, setAccessibleOnly] = useState(false)
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

  const locate = useCallback((fly: boolean) => {
    if (!navigator.geolocation) { queueMicrotask(() => setLocStatus('unavailable')); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c: LngLat = [pos.coords.longitude, pos.coords.latitude]
        setMyLocation(c); setLocStatus('found')
        if (fly) setFlyTo(c)
      },
      () => setLocStatus('unavailable'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    )
  }, [])

  // "Near me" needs to know where you are, so ask once when the site opens.
  useEffect(() => { locate(true) }, [locate])

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

  const shownPlaces = useMemo(
    () => (accessibleOnly ? nearby.places.filter((p) => p.wheelchair === 'yes' || p.wheelchair === 'limited') : nearby.places),
    [nearby.places, accessibleOnly],
  )
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
    if (myLocation) setFrom(pinnedPlace(myLocation, 'My location'))
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

  const useMyLocation = () => {
    if (!navigator.geolocation) { setRouteError('Location is not available in this browser'); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c: LngLat = [pos.coords.longitude, pos.coords.latitude]
        setMyLocation(c); setLocStatus('found')
        setFrom(pinnedPlace(c, 'My location'))
      },
      () => setRouteError('Could not get your location. Search for a start point instead.'),
    )
  }

  const loadRouteAccess = useCallback(async (line: LngLat[]) => {
    const [w, s, e, n] = bboxOf(line)
    if (e - w > 0.08 || n - s > 0.08) return null // too large an area to check in one go
    const data = await fetchAccessData([w, s, e, n])
    setAccess(data) // show what we found along the route on the map too
    return data
  }, [])

  // A route belongs to one trip; changing the start, end or profile hides the old one.
  const tripKey = JSON.stringify([from?.coords, to?.coords, settings.profile, settings.maxInclinePercent])
  const route = routeState.key === tripKey ? routeState.route : null
  const routeError = routeState.key === tripKey ? routeState.error : null
  const setRouteError = (error: string) => setRouteState({ key: tripKey, route: null, error })

  const findRoute = async () => {
    if (!from || !to) return
    const key = tripKey
    setRouting(true); setRouteState({ key, route: null, error: null })
    try {
      setRouteState({ key, route: await planRoute(from.coords, to.coords, settings, loadRouteAccess, reports), error: null })
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

      <button type="button" className="locate-btn" aria-label="Show my location" title="Show my location" onClick={() => { setLocStatus('asking'); locate(true) }}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      </button>

      {tab === 'nearby' && movedAway && (
        <button type="button" className="search-area" onClick={() => searchNearby(nearby.category!, nearby.radius, mapCenter)}>
          Search this area
        </button>
      )}

      {(pickHint || detailNotice) && tab !== 'nearby' && <div className="toast" role="status">{pickHint ?? detailNotice}</div>}

      <aside className={`panel ${sheetOpen ? 'open' : 'closed'}`}>
        <button type="button" className="sheet-handle" onClick={() => setSheetOpen((o) => !o)} aria-label={sheetOpen ? 'Hide panel' : 'Show panel'} />
        <div className="panel-scroll" ref={panelScroll}>
        <header>
          <h1><span className="logo" aria-hidden="true">📍</span> {APP_NAME}</h1>
          <p className="sub">Find places near you, with step-free walking directions</p>
        </header>

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
            <p className="muted small loc-line">
              {locStatus === 'found' && myLocation ? '📍 Showing places near your location'
                : locStatus === 'asking' ? 'Finding your location…'
                : <>Location is off, so places near the map center are shown. <button type="button" className="link" onClick={() => { setLocStatus('asking'); locate(true) }}>Try again</button></>}
            </p>
            <div className="cat-grid" role="group" aria-label="Categories">
              {CATEGORIES.map((c) => (
                <button key={c.id} type="button" aria-pressed={nearby.category === c.id}
                  className={nearby.category === c.id ? 'active' : ''} style={{ '--cat': c.color } as CSSProperties}
                  onClick={() => pickCategory(c.id)}>
                  <span className="cat-icon" aria-hidden="true">{c.icon}</span>{c.label}
                </button>
              ))}
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
                  <input type="checkbox" checked={accessibleOnly} onChange={(e) => setAccessibleOnly(e.target.checked)} />
                  ♿ Accessible only
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
                {selected.openingHours && <p><strong>Hours:</strong> {selected.openingHours}</p>}
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
                  Nothing found within {formatDistance(nearby.radius)}.{' '}
                  {nearby.radius < RADII[RADII.length - 1] && (
                    <button type="button" className="link" onClick={() => searchNearby(nearby.category!, RADII[RADII.indexOf(nearby.radius) + 1] ?? 5000, nearby.center ?? searchCenter)}>Search wider</button>
                  )}
                </p>
              ) : (
                <>
                  <p className="muted small">{shownPlaces.length} {shownPlaces.length === 1 ? 'place' : 'places'}, nearest first</p>
                  <ul className="results">
                    {shownPlaces.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => { setSelectedId(p.id); appMoving.current = true; setFlyTo(p.coords) }}>
                          <span className="res-icon" style={{ background: CATEGORY_BY_ID[p.category]?.color }} aria-hidden="true">{CATEGORY_BY_ID[p.category]?.icon}</span>
                          <span className="res-text">
                            <strong>{p.name}</strong>
                            <span>{p.kind}{p.address ? ` · ${p.address}` : ''}</span>
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
            <SearchBox label="From" placeholder="Search a start point" value={from}
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

            <button type="button" className="primary" disabled={!from || !to || routing} onClick={findRoute}>
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
