import { useCallback, useEffect, useRef, useState } from 'react'
import type { LngLat } from './types'

/**
 * - checking:    working out whether the site already has permission
 * - prompt:      the visitor hasn't decided yet; we show our own "turn on location" card first
 * - asking:      the browser's permission prompt is showing, or we're waiting for the first fix
 * - live:        following the visitor's position
 * - denied:      the visitor or the browser blocked location for this site
 * - unavailable: allowed, but the device couldn't work out where it is
 * - unsupported: this browser (or an in-app browser, or a non-https page) can't share location
 */
export type LocationStatus = 'checking' | 'prompt' | 'asking' | 'live' | 'denied' | 'unavailable' | 'unsupported'

export interface LiveLocation {
  status: LocationStatus
  position: LngLat | null
  /** Accuracy radius in meters. */
  accuracy: number | null
  /** Ask the browser for location and start following it. Call from a click. */
  start: () => void
  /** Hide our "turn on location" card without asking. */
  dismiss: () => void
}

/**
 * For testing and demos: `?at=42.2626,-71.8023` pretends the visitor is at that spot
 * (latitude,longitude), so any place can be checked from any computer.
 */
function simulatedPosition(): LngLat | null {
  if (typeof window === 'undefined') return null
  const at = new URLSearchParams(window.location.search).get('at')
  const m = at?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (!m) return null
  const lat = Number(m[1]), lng = Number(m[2])
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null
}

const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }

export function useLiveLocation(): LiveLocation {
  const [simulated] = useState(simulatedPosition)
  const real = useRealLocation(simulated == null)
  if (simulated) return { status: 'live', position: simulated, accuracy: 20, start: () => {}, dismiss: () => {} }
  return real
}

function useRealLocation(enabled: boolean): LiveLocation {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext
  const [status, setStatus] = useState<LocationStatus>(supported ? 'checking' : 'unsupported')
  const [position, setPosition] = useState<LngLat | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const watchId = useRef<number | null>(null)

  const start = useCallback(() => {
    if (!supported) { setStatus('unsupported'); return }
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
    setStatus((s) => (s === 'live' ? s : 'asking'))
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition([pos.coords.longitude, pos.coords.latitude])
        setAccuracy(pos.coords.accuracy)
        setStatus('live')
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied')
          if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
          watchId.current = null
        } else {
          // Timeouts and "position unavailable" can clear up on their own; keep watching.
          setStatus((s) => (s === 'live' ? s : 'unavailable'))
        }
      },
      WATCH_OPTIONS,
    )
  }, [supported])

  const dismiss = useCallback(() => setStatus((s) => (s === 'prompt' ? 'unavailable' : s)), [])

  // On open: if the visitor already allowed location, start following right away.
  // If they haven't decided, show our card so they know why we ask. If blocked, say how to fix it.
  useEffect(() => {
    if (!supported || !enabled) return
    let perm: PermissionStatus | null = null
    let cancelled = false
    const onChange = () => {
      if (!perm) return
      if (perm.state === 'granted') start()
      else if (perm.state === 'denied') setStatus('denied')
    }
    const decide = (state: PermissionState | 'unknown') => {
      if (cancelled) return
      if (state === 'granted') start()
      else if (state === 'denied') setStatus('denied')
      else setStatus('prompt')
    }
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then((p) => { perm = p; p.addEventListener('change', onChange); decide(p.state) })
        .catch(() => decide('unknown'))
    } else {
      queueMicrotask(() => decide('unknown'))
    }
    return () => {
      cancelled = true
      perm?.removeEventListener('change', onChange)
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
  }, [supported, enabled, start])

  return { status, position, accuracy, start, dismiss }
}

/** Plain-language steps to turn location back on, for the visitor's browser and device. */
export function locationHelp(): { browser: string; device: string } {
  const ua = navigator.userAgent
  const iOS = /iPhone|iPad|iPod/.test(ua)
  const android = /Android/.test(ua)
  const mac = /Macintosh/.test(ua) && !iOS
  const windows = /Windows/.test(ua)
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|CriOS|FxiOS/.test(ua)

  let browser = 'Click the icon at the left of the address bar (a lock or sliders), set Location to Allow, then reload the page.'
  if (iOS) browser = 'Tap "aA" (Safari) or the ⋯ menu in the address bar, open Website Settings, set Location to Allow, then reload.'
  else if (safari) browser = 'In Safari choose Settings, then Websites, then Location, set this site to Allow, then reload.'

  let device = ''
  if (windows) device = 'If that doesn\'t help, open Windows Settings > Privacy & security > Location and turn on location for your browser.'
  else if (mac) device = 'If that doesn\'t help, open System Settings > Privacy & Security > Location Services and turn it on for your browser.'
  else if (iOS) device = 'If that doesn\'t help, open Settings > Privacy & Security > Location Services and turn it on for your browser.'
  else if (android) device = 'If that doesn\'t help, pull down the quick settings and turn on Location.'
  return { browser, device }
}
