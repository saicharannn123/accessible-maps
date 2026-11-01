import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type Layers } from './components/MapView'
import { SearchBox } from './components/SearchBox'
import { ORS_KEY, PILOT_CITY, REPORT_LIFETIME_DAYS } from './config'
import { bboxOf, distanceMeters, formatDistance, formatDuration } from './lib/geo'
import { fetchAccessData, type AccessData } from './lib/overpass'
import { loadReports, saveReports, timeAgo } from './lib/reports'
import { planRoute } from './lib/routing'
import { loadSettings, saveSettings } from './lib/settings'
import { PROFILE_LABELS, REPORT_LABELS } from './lib/types'
import type { LngLat, MobilityProfile, Place, Report, ReportType, RouteResult, Settings } from './lib/types'

type Tab = 'route' | 'report' | 'settings'
type Pick = 'from' | 'to' | 'report' | null

const MIN_DETAIL_ZOOM = 14

function pinnedPlace(c: LngLat, name = 'Dropped pin'): Place {
  return { name, detail: `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`, coords: c }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('route')
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

  const onViewChange = useCallback((bbox: [number, number, number, number], zoom: number) => {
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
      (pos) => setFrom(pinnedPlace([pos.coords.longitude, pos.coords.latitude], 'My location')),
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
        onMapClick={onMapClick}
        onViewChange={onViewChange}
      />

      <div className="layer-toggles" role="group" aria-label="Map layers">
        {(['restrooms', 'lighting', 'obstacles', 'reports'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={layers[k]} className={layers[k] ? 'on' : ''}
            onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}>
            {{ restrooms: 'Restrooms', lighting: 'Lighting', obstacles: 'Steps & curbs', reports: 'Reports' }[k]}
          </button>
        ))}
      </div>

      {(pickHint || detailNotice) && <div className="toast" role="status">{pickHint ?? detailNotice}</div>}

      <aside className={`panel ${sheetOpen ? 'open' : 'closed'}`}>
        <button type="button" className="sheet-handle" onClick={() => setSheetOpen((o) => !o)} aria-label={sheetOpen ? 'Hide panel' : 'Show panel'} />
        <div className="panel-scroll">
        <header>
          <h1>Accessible Maps</h1>
          <p className="sub">Step-free walking in {PILOT_CITY.name}</p>
        </header>

        <nav className="tabs" role="tablist">
          {(['route', 'report', 'settings'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setPick(null) }}>
              {{ route: 'Route', report: 'Report a problem', settings: 'Profile' }[t]}
            </button>
          ))}
        </nav>

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

        <footer className="legend">
          <span><i className="dot" style={{ background: '#15803d' }} /> Accessible restroom</span>
          <span><i className="dot" style={{ background: '#dc2626' }} /> Reported problem</span>
          <span><i className="dot" style={{ background: '#b45309' }} /> Steps or high curb</span>
          <span><i className="dot" style={{ background: '#7c3aed' }} /> Restroom, not accessible</span>
          <span className="credit">Map data © OpenStreetMap contributors</span>
        </footer>
        </div>
      </aside>
    </div>
  )
}
