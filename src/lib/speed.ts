import { useEffect, useState } from 'react'
import { distanceMeters, type DistanceUnits } from './geo'
import { bearingDeg } from './navigation'
import type { LngLat } from './types'

// Your speed while driving, worked out only from location readings that are recent and accurate
// enough to trust. Anything less shows "—" instead of a made-up number.

/** One reading from the device's location service. */
export interface LocationFix {
  lng: number
  lat: number
  /** Accuracy radius in meters. */
  accuracy: number
  /** Ground speed in m/s, when the device reports it. */
  speed: number | null
  /** Direction of travel in degrees (0 = north), when the device reports it. */
  heading: number | null
  /** When the reading was taken (ms since 1970). */
  at: number
}

/** Older than this and the reading no longer says how fast you're going now. */
export const MAX_FIX_AGE_MS = 5000
/** A wider accuracy circle than this is too rough for speed (or for picking your road). */
export const MAX_ACCURACY_M = 30
/** Faster than this (about 400 km/h) is a glitch, not a car. */
const MAX_PLAUSIBLE_MPS = 110
/** Below this you're standing still; GPS wobble reads as a little speed even when parked. */
export const STOPPED_MPS = 1.5

export type SpeedReason = 'ok' | 'no-fix' | 'stale' | 'inaccurate'
export interface SpeedReading { mps: number | null; reason: SpeedReason }

const posOf = (f: LocationFix): LngLat => [f.lng, f.lat]

/**
 * Current speed from the recent readings (oldest first). Uses the device's own speed when it gives
 * one, otherwise distance over time between two good readings a second or more apart.
 */
export function currentSpeed(fixes: readonly LocationFix[], now: number): SpeedReading {
  const last = fixes[fixes.length - 1]
  if (!last) return { mps: null, reason: 'no-fix' }
  if (now - last.at > MAX_FIX_AGE_MS) return { mps: null, reason: 'stale' }
  if (!(last.accuracy <= MAX_ACCURACY_M)) return { mps: null, reason: 'inaccurate' }
  if (last.speed != null && Number.isFinite(last.speed) && last.speed >= 0) {
    if (last.speed > MAX_PLAUSIBLE_MPS) return { mps: null, reason: 'inaccurate' }
    return { mps: last.speed < 0.3 ? 0 : last.speed, reason: 'ok' }
  }
  // No speed from the device (common on laptops): measure it. Take the oldest good reading from
  // the last 4 seconds, so the jitter of single readings averages out.
  const prev = fixes.find((f) => f !== last && f.accuracy <= MAX_ACCURACY_M && last.at - f.at >= 1000 && last.at - f.at <= 4000)
  if (!prev) return { mps: null, reason: 'no-fix' }
  const d = distanceMeters(posOf(prev), posOf(last))
  const mps = d / ((last.at - prev.at) / 1000)
  if (mps > MAX_PLAUSIBLE_MPS) return { mps: null, reason: 'inaccurate' }
  return { mps: mps < 0.3 ? 0 : mps, reason: 'ok' }
}

/** True when a fresh, accurate reading says you're standing still. */
export function isStopped(fixes: readonly LocationFix[], now: number): boolean {
  const r = currentSpeed(fixes, now)
  return r.mps != null && r.mps < STOPPED_MPS
}

/**
 * Which way you're moving, in degrees (0 = north): the device's heading while moving, or the
 * bearing between your last readings once you've gone far enough for it to mean something.
 * Null when you're stopped or it can't be told.
 */
export function travelHeading(fixes: readonly LocationFix[], now: number): number | null {
  const last = fixes[fixes.length - 1]
  if (!last || now - last.at > MAX_FIX_AGE_MS || last.accuracy > MAX_ACCURACY_M) return null
  const speed = currentSpeed(fixes, now).mps
  if (last.heading != null && Number.isFinite(last.heading) && speed != null && speed >= 2) return ((last.heading % 360) + 360) % 360
  for (let i = fixes.length - 2; i >= 0; i--) {
    const f = fixes[i]
    if (f.accuracy > MAX_ACCURACY_M || last.at - f.at > 15_000) continue
    const d = distanceMeters(posOf(f), posOf(last))
    // Far enough that the two accuracy circles can't flip the direction.
    if (d >= Math.max(12, (f.accuracy + last.accuracy) * 0.8)) return bearingDeg(posOf(f), posOf(last))
  }
  return null
}

/** Speed in the units chosen in Settings: mph with miles, km/h with kilometers. */
export function speedIn(mps: number, units: DistanceUnits): number {
  return units === 'mi' ? mps * 2.236936 : mps * 3.6
}
export const speedUnitLabel = (units: DistanceUnits) => (units === 'mi' ? 'mph' : 'km/h')

/** Keeps the readings from the last 15 seconds, oldest first, and re-renders every second so a
 * reading that stops arriving goes stale on screen. */
export function useFixHistory(fix: LocationFix | null, active = true): { fixes: LocationFix[]; now: number } {
  const [fixes, setFixes] = useState<LocationFix[]>([])
  const [seen, setSeen] = useState<LocationFix | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // A new reading joins the history right away (React's "adjust state when a prop changes").
  if (fix && fix !== seen) {
    setSeen(fix)
    setFixes((h) => (h.length && h[h.length - 1].at >= fix.at ? h : [...h.filter((f) => fix.at - f.at <= 15_000), fix]))
    if (fix.at > now) setNow(fix.at)
  }
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return { fixes, now }
}
