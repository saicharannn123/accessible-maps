import { useCallback, useEffect, useMemo, useState } from 'react'
import { bearingDeg } from './navigation'
import { distanceMeters } from './geo'
import {
  cellTopic, deviceId, fetchEvents, foldEvents, loadSent, publishEvent, randomId, reportsBase, saveSent, sendLimit,
  topicsAround, type RoadEvent, type RoadReport, type RoadReportType, type WireEvent,
} from './roadReports'
import type { LngLat } from './types'

/** Faster than this (about 5 mph) counts as driving: reports and votes wait until you stop. */
export const MOVING_MPS = 2.5

export interface Motion {
  /** Meters per second from recent fixes, or null when there isn't a fresh, steady reading. */
  speedMps: number | null
  /** Direction of travel in degrees, when moving far enough to tell. */
  heading: number | null
  moving: boolean
}

/**
 * Speed and direction from the last few location fixes. Kept simple and conservative: only fixes
 * from the last 10 seconds count, and with no fresh fix we assume you're not moving (browsers often
 * stop sending fixes while you stand still).
 */
export function useMotion(position: LngLat | null, accuracy: number | null): Motion {
  const [state, setState] = useState<{ fixes: Fix[]; now: number }>({ fixes: [], now: 0 })
  useEffect(() => {
    if (!position) return
    const now = Date.now()
    setState((s) => ({ now, fixes: [...s.fixes.filter((f) => now - f.at < 15000), { at: now, p: position, acc: accuracy ?? 50 }] }))
  }, [position, accuracy])
  // Re-check every few seconds so "moving" clears when fixes stop coming.
  useEffect(() => {
    const id = window.setInterval(() => setState((s) => (s.fixes.length ? { ...s, now: Date.now() } : s)), 4000)
    return () => window.clearInterval(id)
  }, [])
  return useMemo(() => motionFrom(state.fixes, state.now), [state])
}

type Fix = { at: number; p: LngLat; acc: number }

export function motionFrom(fixes: Fix[], now: number): Motion {
  const fresh = fixes.filter((f) => now - f.at < 10000 && f.acc <= 60)
  if (fresh.length < 2) return { speedMps: null, heading: null, moving: false }
  const a = fresh[0], b = fresh[fresh.length - 1]
  const dt = (b.at - a.at) / 1000
  if (dt < 2) return { speedMps: null, heading: null, moving: false }
  const d = distanceMeters(a.p, b.p)
  const speedMps = d / dt
  return { speedMps, heading: d > 15 ? bearingDeg(a.p, b.p) : null, moving: speedMps > MOVING_MPS }
}

export interface RoadReportsApi {
  reports: RoadReport[]
  status: 'idle' | 'loading' | 'ok' | 'error'
  error: string | null
  /** Post a new report. Resolves to an error message, or null when sent. */
  send: (type: RoadReportType, at: LngLat, opts?: { heading?: number | null; road?: string | null }) => Promise<string | null>
  /** "Still there" (yes) or "Not there anymore" (no). */
  vote: (r: RoadReport, v: 'yes' | 'no') => Promise<string | null>
  /** This device's vote on a report, if any. */
  myVote: (id: string) => 'yes' | 'no' | null
  refresh: () => void
}

/**
 * Shared road reports around some points (you, the map, your route). Polls every `everyMs`
 * while the page is visible; your own reports and votes show at once, before the server echoes them.
 */
export function useRoadReports(points: LngLat[], everyMs: number): RoadReportsApi {
  const [base] = useState(reportsBase)
  // Round to whole squares so small moves don't restart polling.
  const topicKey = topicsAround(points).join(',')
  const [events, setEvents] = useState<RoadEvent[]>([])
  // Own events, shown before the server echoes them back.
  const [local, setLocal] = useState<RoadEvent[]>([])
  const [status, setStatus] = useState<RoadReportsApi['status']>('idle')
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sent, setSent] = useState(() => loadSent())
  const [kick, setKick] = useState(0)

  useEffect(() => {
    if (!topicKey) return
    let stop = false
    let ctrl: AbortController | null = null
    let timer: number | undefined
    const run = async () => {
      if (stop) return
      if (document.visibilityState === 'hidden') { timer = window.setTimeout(run, everyMs); return }
      ctrl?.abort()
      ctrl = new AbortController()
      setStatus((s) => (s === 'ok' ? s : 'loading'))
      try {
        const got = await fetchEvents(topicKey.split(','), ctrl.signal, base)
        if (stop) return
        setEvents(got)
        setLocal((l) => l.filter((x) => Date.now() - x.at < 120_000 && !got.some((e) => e.k === x.k && e.id === x.id && e.d === x.d)))
        setStatus('ok'); setError(null)
      } catch (e) {
        if (stop || (e instanceof DOMException && e.name === 'AbortError')) return
        setStatus('error'); setError('Road reports could not be loaded. Retrying…')
      }
      setNow(Date.now())
      timer = window.setTimeout(run, everyMs)
    }
    void run()
    const onShow = () => { if (document.visibilityState === 'visible') { window.clearTimeout(timer); void run() } }
    document.addEventListener('visibilitychange', onShow)
    return () => { stop = true; ctrl?.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onShow) }
  }, [topicKey, everyMs, base, kick])

  // Keep "x min ago" and expiry current between polls.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(id)
  }, [])

  // foldEvents drops an own event that also came back from the server.
  const reports = useMemo(() => foldEvents([...events, ...local], now), [events, local, now])

  const post = useCallback(async (topic: string, e: WireEvent): Promise<string | null> => {
    try {
      await publishEvent(topic, e, base)
      const at = Date.now()
      setLocal((l) => [...l, { ...e, at }])
      setNow(at)
      return null
    } catch (err) {
      return err instanceof Error && err.message.startsWith('Too many') ? err.message : 'Could not send. Check your connection and try again.'
    }
  }, [base])

  const send = useCallback<RoadReportsApi['send']>(async (type, at, opts = {}) => {
    const s = loadSent()
    const limit = sendLimit(s)
    if (limit) return limit
    const e: WireEvent = {
      v: 1, k: 'new', id: randomId(), t: type, la: Math.round(at[1] * 1e5) / 1e5, lo: Math.round(at[0] * 1e5) / 1e5,
      h: opts.heading == null ? null : Math.round(opts.heading), r: opts.road?.slice(0, 80) || null, d: deviceId(),
    }
    const err = await post(cellTopic(at), e)
    if (!err) { const next = { ...s, news: [...s.news, Date.now()] }; saveSent(next); setSent(next) }
    return err
  }, [post, setSent])

  const vote = useCallback<RoadReportsApi['vote']>(async (r, v) => {
    const s = loadSent()
    if (s.votes[r.id]?.v === v) return null
    const err = await post(r.cell, { v: 1, k: v, id: r.id, d: deviceId() })
    if (!err) { const next = { ...s, votes: { ...s.votes, [r.id]: { v, at: Date.now() } } }; saveSent(next); setSent(next) }
    return err
  }, [post, setSent])

  const myVote = useCallback((id: string) => sent.votes[id]?.v ?? null, [sent])
  const refresh = useCallback(() => setKick((k) => k + 1), [setKick])

  // Reports you said are gone disappear for you right away, even before others agree.
  const visible = useMemo(() => reports.filter((r) => sent.votes[r.id]?.v !== 'no'), [reports, sent])
  return { reports: visible, status, error, send, vote, myVote, refresh }
}
