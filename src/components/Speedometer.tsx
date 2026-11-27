import { useEffect, useState } from 'react'
import type { DistanceUnits } from '../lib/geo'
import { limitIn, loadRoadsAround, matchRoad, pointAhead, roadsNear, type RoadMatch } from '../lib/roads'
import { currentSpeed, speedIn, speedUnitLabel, travelHeading, useFixHistory, type LocationFix } from '../lib/speed'
import type { LocationStatus } from '../lib/useLiveLocation'

interface Props {
  fix: LocationFix | null
  status: LocationStatus
  units: DistanceUnits
}

/**
 * Driving speed, with the posted limit beside it when OpenStreetMap has one for the road and
 * direction you're on. Shows "—" whenever the location reading is too old or too rough to trust.
 */
export default function Speedometer({ fix, status, units }: Props) {
  const { fixes, now } = useFixHistory(fix)
  const reading = status === 'live' ? currentSpeed(fixes, now) : { mps: null, reason: 'no-fix' as const }
  const heading = reading.mps != null ? travelHeading(fixes, now) : null
  const last = fixes[fixes.length - 1]

  // Load the roads around you (and ahead, so the next stretch is ready before you reach it).
  const [roadsVersion, setRoadsVersion] = useState(0)
  const here = last && reading.mps != null ? ([last.lng, last.lat] as [number, number]) : null
  const cellKey = here ? `${Math.floor(here[0] / 0.01)}:${Math.floor(here[1] / 0.01)}` : null
  useEffect(() => {
    if (!here) return
    const spots = [here, ...(heading != null ? [pointAhead(here, heading, 500)] : [])]
    for (const p of spots) loadRoadsAround(p).then(() => setRoadsVersion((v) => v + 1), () => {})
    // Only when you enter a new cell; the cache makes repeat calls free anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellKey, heading != null && Math.round(heading / 45)])

  // Hold on to the last match for a few seconds: at a junction the road can't be told for a
  // moment, and the limit shouldn't blink off and on.
  const [held, setHeld] = useState<{ match: RoadMatch; at: number } | null>(null)
  const fresh = here && last ? matchRoad(roadsNear(here), here, heading, last.accuracy) : null
  useEffect(() => {
    if (fresh) setHeld({ match: fresh, at: now })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh?.road.id, fresh?.direction, roadsVersion, now])
  const match = reading.mps == null ? null : fresh ?? (held && now - held.at < 4000 ? held.match : null)

  const speed = reading.mps != null ? Math.round(speedIn(reading.mps, units)) : null
  const limit = match?.limit ? limitIn(match.limit, units) : null
  const over = speed != null && limit != null && speed > limit
  const unit = speedUnitLabel(units)
  const why = status === 'denied' ? 'Location blocked' : status !== 'live' ? 'No location' : reading.reason === 'inaccurate' ? 'Weak GPS' : reading.reason === 'stale' ? 'No recent GPS' : reading.reason !== 'ok' ? 'Waiting for GPS' : null

  const label = speed == null ? `Speed unavailable${why ? `: ${why}` : ''}`
    : `Speed ${speed} ${unit}${limit != null ? `, limit ${limit} ${unit}${over ? ', over the limit' : ''}` : ''}`

  return (
    <div className={`speedo${over ? ' over' : ''}`} role="group" aria-label={label} data-testid="speedometer">
      <div className="speedo-now" aria-hidden="true">
        <strong className="speedo-value">{speed ?? '—'}</strong>
        <span className="speedo-unit">{speed == null && why ? why : unit}</span>
      </div>
      {limit != null && (
        <div className={`speedo-limit ${units === 'mi' ? 'us' : 'round'}`} aria-hidden="true"
          title={`Posted limit from OpenStreetMap${match?.road.name ? ` for ${match.road.name}` : ''}`}>
          {units === 'mi' && <span className="speedo-limit-cap">LIMIT</span>}
          <strong>{limit}</strong>
        </div>
      )}
      {/* Said once when it changes, not every second. */}
      <span className="speedo-over" role="status" aria-live="polite">
        {over && <><span aria-hidden="true">▲</span> Over limit</>}
      </span>
    </div>
  )
}
