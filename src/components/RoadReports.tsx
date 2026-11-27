import { useState, type CSSProperties } from 'react'
import { formatDistance, distanceMeters } from '../lib/geo'
import { agoText, deviceId, expiresAt, ROAD_REPORT_IDS, ROAD_REPORT_TYPES, type RoadReport, type RoadReportType } from '../lib/roadReports'
import type { RoadReportsApi } from '../lib/useRoadReports'
import type { LngLat } from '../lib/types'

const STOP_FIRST = 'Available when you’re stopped.'

/** "User-submitted · posted 12 min ago · confirmed 3 min ago" */
export function ReportMeta({ r, now = Date.now() }: { r: RoadReport; now?: number }) {
  const confirmed = r.lastConfirmedAt > r.createdAt + 30_000
  const left = Math.max(0, Math.round((expiresAt(r) - now) / 60000))
  return (
    <span className="rr-meta">
      <span className="rr-badge">User-submitted</span> Posted {agoText(r.createdAt, now)}
      {confirmed ? ` · last confirmed ${agoText(r.lastConfirmedAt, now)}` : ''}
      {r.confirmations > 1 ? ` · ${r.confirmations} drivers` : ''}
      <span className="rr-expiry"> · clears in {left < 60 ? `${left} min` : `${Math.round(left / 60)} h`} unless confirmed</span>
    </span>
  )
}

/** "Still there" and "Not there anymore": only while stopped. */
export function VoteButtons({ r, api, moving, compact = false }: { r: RoadReport; api: RoadReportsApi; moving: boolean; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const mine = r.reporter === deviceId()
  const voted = api.myVote(r.id)
  const go = async (v: 'yes' | 'no') => {
    setBusy(true)
    const err = await api.vote(r, v)
    setBusy(false)
    setMsg(err ?? (v === 'yes' ? 'Thanks, confirmed.' : 'Thanks. It’s hidden for you and will clear once others agree.'))
  }
  return (
    <div className={`rr-votes${compact ? ' compact' : ''}`}>
      {!mine && (
        <button type="button" className="rr-yes" disabled={moving || busy || voted === 'yes'} onClick={() => go('yes')}>
          {voted === 'yes' ? '✓ Confirmed' : '✓ Still there'}
        </button>
      )}
      <button type="button" className="rr-no" disabled={moving || busy} onClick={() => go('no')}>
        {mine ? 'Remove my report' : '✕ Not there anymore'}
      </button>
      {moving ? <span className="rr-note">{STOP_FIRST}</span> : msg && <span className="rr-note" role="status">{msg}</span>}
    </div>
  )
}

/** One report: what, where, how fresh, and the vote buttons. */
export function ReportRow({ r, api, moving, here, onShow }: { r: RoadReport; api: RoadReportsApi; moving: boolean; here: LngLat | null; onShow?: () => void }) {
  const k = ROAD_REPORT_TYPES[r.type]
  return (
    <li className="rr-row">
      <span className="rr-icon" style={{ background: k.color }} aria-hidden="true">{k.icon}</span>
      <div className="rr-body">
        <button type="button" className="link rr-title" onClick={onShow}>
          {k.label}{r.road ? ` · ${r.road}` : ''}{here ? ` · ${formatDistance(distanceMeters(here, r.coords))} away` : ''}
        </button>
        <ReportMeta r={r} />
        <VoteButtons r={r} api={api} moving={moving} compact />
      </div>
    </li>
  )
}

interface FormProps {
  api: RoadReportsApi
  moving: boolean
  myLocation: LngLat | null
  /** A spot chosen on the map, if any. */
  spot: LngLat | null
  where: 'here' | 'map'
  onWhere: (w: 'here' | 'map') => void
  /** Direction of travel and road name to attach when reporting where you are. */
  heading: number | null
  road: string | null
  onSent?: (type: RoadReportType) => void
}

/** Big, thumb-sized buttons: pick where, then tap what you see. One tap sends. */
export function RoadReportForm({ api, moving, myLocation, spot, where, onWhere, heading, road, onSent }: FormProps) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const at = where === 'here' ? myLocation : spot
  const send = async (t: RoadReportType) => {
    if (!at) return
    setBusy(true); setMsg(null)
    const err = await api.send(t, at, where === 'here' ? { heading, road } : {})
    setBusy(false)
    setMsg(err ? { ok: false, text: err } : { ok: true, text: `${ROAD_REPORT_TYPES[t].label} reported. Thanks! Other drivers can see it now.` })
    if (!err) onSent?.(t)
  }
  return (
    <div className="rr-form">
      <div className="seg rr-where" role="radiogroup" aria-label="Where to report">
        <button type="button" role="radio" aria-checked={where === 'here'} className={where === 'here' ? 'active' : ''} onClick={() => onWhere('here')}>📍 My location</button>
        <button type="button" role="radio" aria-checked={where === 'map'} className={where === 'map' ? 'active' : ''} onClick={() => onWhere('map')}>🗺️ Pick on map</button>
      </div>
      <p className={`small ${at ? 'ok' : 'muted'}`}>
        {where === 'here'
          ? myLocation ? 'Reporting where you are now.' : 'Your location is off. Turn it on, or pick a spot on the map.'
          : spot ? 'Spot chosen. Tap the map again to move it.' : 'Tap the map where it is.'}
      </p>
      {moving && <p className="warn small" role="status">You’re moving. Reporting opens when you’re stopped, so you can keep your eyes on the road.</p>}
      <div className="rr-types">
        {ROAD_REPORT_IDS.map((t) => (
          <button key={t} type="button" disabled={!at || moving || busy} onClick={() => send(t)} style={{ '--rr': ROAD_REPORT_TYPES[t].color } as CSSProperties}>
            <span className="rr-type-icon" aria-hidden="true">{ROAD_REPORT_TYPES[t].icon}</span>
            <span>{ROAD_REPORT_TYPES[t].label}</span>
          </button>
        ))}
      </div>
      {msg && <p className={`small ${msg.ok ? 'ok' : 'warn'}`} role="status">{msg.text}</p>}
      <p className="muted small">Reports are user-submitted and public, with no names attached. They clear on their own (police after 1 hour, crashes 2, hazards 3, closures 12) unless other drivers confirm them.</p>
    </div>
  )
}
