import { distanceMeters } from './geo'
import type { LngLat } from './types'

/**
 * Community road reports (police, crashes, hazards, closures), shared between everyone's devices.
 *
 * The site has no server of its own, so reports travel through ntfy.sh, a free public publish /
 * subscribe service that needs no account or key. Every report, confirmation and "not there
 * anymore" is a small event on a topic for its 1° map square; ntfy.sh keeps events for 12 hours and
 * each device folds the events it reads into the current list of reports (see foldEvents). Nothing
 * secret is involved: reports are public by nature, carry no free text, and every event is checked
 * field by field before it is used, because anyone can post to a public topic.
 *
 * Abuse limits: ntfy.sh rate-limits each IP address; on top of that the app lets one device send at
 * most a few reports per hour, counts one vote per device per report, ignores devices that flood a
 * square, and reports expire on their own unless other drivers confirm them.
 */

export type RoadReportType = 'police' | 'crash' | 'hazard' | 'closure'

export interface RoadReportKind {
  label: string
  icon: string
  /** How long a report lasts after it was posted or last confirmed. */
  ttlMinutes: number
  /** Reports of the same event closer than this are merged into one. */
  mergeMeters: number
  /** What the alert says, on screen and aloud. Police wording stays neutral on purpose. */
  alert: string
  color: string
}

export const ROAD_REPORT_TYPES: Record<RoadReportType, RoadReportKind> = {
  police: { label: 'Police presence', icon: '🚓', ttlMinutes: 60, mergeMeters: 300, color: '#2563eb',
    alert: 'Police presence reported ahead. Follow the posted speed limit.' },
  crash: { label: 'Crash', icon: '💥', ttlMinutes: 120, mergeMeters: 200, color: '#dc2626',
    alert: 'Crash reported ahead. Be ready to slow down.' },
  hazard: { label: 'Road hazard', icon: '⚠️', ttlMinutes: 180, mergeMeters: 150, color: '#ea580c',
    alert: 'Road hazard reported ahead. Use caution.' },
  closure: { label: 'Road closure', icon: '🚧', ttlMinutes: 720, mergeMeters: 200, color: '#7c3aed',
    alert: 'Road closure reported ahead.' },
}
export const ROAD_REPORT_IDS = Object.keys(ROAD_REPORT_TYPES) as RoadReportType[]
export const isRoadReportType = (t: unknown): t is RoadReportType => typeof t === 'string' && t in ROAD_REPORT_TYPES

/** Nothing outlives the 12 hours ntfy.sh keeps events, even when confirmed again and again. */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000
/** "Not there anymore" from this many different devices (since the last confirmation) removes a report. */
export const GONE_VOTES = 2
/** At most this many new reports per device per hour count; the rest of a flood is ignored. */
export const MAX_NEW_PER_DEVICE_HOUR = 6

/** One event as sent over the wire (short keys keep messages small). */
export interface WireEvent {
  v: 1
  /** new report, yes (still there), no (not there anymore) */
  k: 'new' | 'yes' | 'no'
  /** Report id. */
  id: string
  /** Report type (new only). */
  t?: RoadReportType
  /** Latitude, longitude (new only), 5 decimals (about 1 m). */
  la?: number
  lo?: number
  /** Direction of travel of the reporter in degrees, if they were moving on a road. */
  h?: number | null
  /** Road name where the report was placed, when known. */
  r?: string | null
  /** Random id of the sending device. */
  d: string
}

/** A checked event with the server's timestamp. */
export interface RoadEvent extends WireEvent {
  /** When ntfy.sh received it (ms). The device clock isn't trusted for this. */
  at: number
}

export interface RoadReport {
  id: string
  type: RoadReportType
  coords: LngLat
  heading: number | null
  road: string | null
  createdAt: number
  lastConfirmedAt: number
  /** Devices that posted or confirmed it. */
  confirmations: number
  /** "Not there anymore" votes since the last confirmation. */
  goneVotes: number
  /** Topic (map square) the report lives in, where votes for it go. */
  cell: string
  reporter: string
}

const ID_RE = /^[a-z0-9]{8,24}$/

/** Check every field of an event; anything odd is dropped. */
export function parseEvent(raw: unknown, at: number, now = Date.now()): RoadEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (e.v !== 1 || (e.k !== 'new' && e.k !== 'yes' && e.k !== 'no')) return null
  if (typeof e.id !== 'string' || !ID_RE.test(e.id) || typeof e.d !== 'string' || !ID_RE.test(e.d)) return null
  if (!Number.isFinite(at) || at > now + 5 * 60_000 || now - at > MAX_AGE_MS) return null
  const out: RoadEvent = { v: 1, k: e.k, id: e.id, d: e.d, at }
  if (e.k === 'new') {
    if (!isRoadReportType(e.t)) return null
    if (typeof e.la !== 'number' || typeof e.lo !== 'number' || !Number.isFinite(e.la) || !Number.isFinite(e.lo)) return null
    if (Math.abs(e.la) > 85 || Math.abs(e.lo) > 180) return null
    out.t = e.t
    out.la = Math.round(e.la * 1e5) / 1e5
    out.lo = Math.round(e.lo * 1e5) / 1e5
    out.h = typeof e.h === 'number' && Number.isFinite(e.h) && e.h >= 0 && e.h < 360 ? e.h : null
    // Road names are only compared and shown as plain text; keep them short and printable.
    out.r = typeof e.r === 'string' && e.r.length <= 80 && !/[\u0000-\u001f<>]/.test(e.r) ? e.r.trim() || null : null
  }
  return out
}

/** Smallest angle between two compass headings, 0-180. */
export function headingDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

/** Same road, or we can't tell. Names compare loosely ("Main St" vs "main st"). */
export function sameRoad(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return n(a) === n(b)
}

/** Same direction of travel, or we can't tell. */
export function sameDirection(a: number | null | undefined, b: number | null | undefined, slack = 60): boolean {
  return a == null || b == null || headingDiff(a, b) <= slack
}

export const isActive = (r: RoadReport, now = Date.now()) =>
  now - r.lastConfirmedAt < ROAD_REPORT_TYPES[r.type].ttlMinutes * 60_000 && now - r.createdAt < MAX_AGE_MS && r.goneVotes < GONE_VOTES

/** When a report will disappear unless someone confirms it. */
export const expiresAt = (r: RoadReport) =>
  Math.min(r.lastConfirmedAt + ROAD_REPORT_TYPES[r.type].ttlMinutes * 60_000, r.createdAt + MAX_AGE_MS)

/**
 * Turn the events of the last 12 hours into the reports that are still current.
 * - A new report close to an active one of the same type, road and direction confirms that one
 *   instead (two drivers reporting the same crash make one report).
 * - "Still there" refreshes the expiry; "Not there anymore" from two devices, or from the person
 *   who posted it, removes it.
 * - One vote per device per report; devices that post a flood of reports are ignored.
 */
export function foldEvents(events: RoadEvent[], now = Date.now(), cellOf: (c: LngLat) => string = cellTopic): RoadReport[] {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  const reports = new Map<string, RoadReport & { voters: Map<string, 'yes' | 'no'>; removed: boolean }>()
  // Merged reports keep the id of the first one; votes for a merged id go there too.
  const alias = new Map<string, string>()
  const perDevice = new Map<string, number[]>()
  const seen = new Set<string>()
  for (const e of sorted) {
    const key = `${e.k}|${e.id}|${e.d}`
    if (seen.has(key)) continue // the same event delivered twice (e.g. our own copy and the server's)
    seen.add(key)
    if (e.k === 'new') {
      const times = (perDevice.get(e.d) ?? []).filter((t) => e.at - t < 3600_000)
      times.push(e.at)
      perDevice.set(e.d, times)
      if (times.length > MAX_NEW_PER_DEVICE_HOUR) continue
      const coords: LngLat = [e.lo!, e.la!]
      const kind = ROAD_REPORT_TYPES[e.t!]
      let target: (typeof reports extends Map<string, infer R> ? R : never) | undefined
      for (const r of reports.values()) {
        if (r.removed || r.type !== e.t || !isActive(r, e.at)) continue
        if (distanceMeters(r.coords, coords) > kind.mergeMeters) continue
        if (!sameRoad(r.road, e.r) || !sameDirection(r.heading, e.h)) continue
        target = r
        break
      }
      if (target) {
        alias.set(e.id, target.id)
        vote(target, e.d, 'yes', e.at)
        if (target.heading == null && e.h != null) target.heading = e.h
        if (!target.road && e.r) target.road = e.r
        continue
      }
      if (reports.has(e.id)) continue
      reports.set(e.id, {
        id: e.id, type: e.t!, coords, heading: e.h ?? null, road: e.r ?? null, createdAt: e.at, lastConfirmedAt: e.at,
        confirmations: 1, goneVotes: 0, cell: cellOf(coords), reporter: e.d, voters: new Map([[e.d, 'yes']]), removed: false,
      })
    } else {
      const r = reports.get(alias.get(e.id) ?? e.id)
      if (!r || r.removed || !isActive(r, e.at)) continue
      vote(r, e.d, e.k, e.at)
      if (e.k === 'no' && e.d === r.reporter) r.removed = true
    }
  }
  return [...reports.values()]
    .filter((r) => !r.removed && isActive(r, now))
    .map(({ voters: _v, removed: _r, ...r }) => r)
}

function vote(r: RoadReport & { voters: Map<string, 'yes' | 'no'> }, device: string, v: 'yes' | 'no', at: number) {
  const before = r.voters.get(device)
  if (before === v) return
  r.voters.set(device, v)
  if (v === 'yes') {
    r.lastConfirmedAt = Math.max(r.lastConfirmedAt, at)
    r.confirmations += 1
    // A fresh confirmation outweighs earlier "gone" votes.
    r.goneVotes = 0
    for (const [d, x] of r.voters) if (x === 'no' && d !== device) r.voters.delete(d)
  } else {
    r.goneVotes += 1
  }
}

// ---------------------------------------------------------------------------------------------
// Map squares and the ntfy.sh transport.

export const NTFY_URL = 'https://ntfy.sh'
const TOPIC_PREFIX = 'bmlocator-road1-'

/** The ntfy.sh topic for the 1° square a point falls in. */
export function cellTopic(c: LngLat): string {
  const lat = Math.floor(c[1]) + 90, lng = Math.floor(c[0]) + 180
  return `${TOPIC_PREFIX}${lat}-${lng}`
}

/** Topics covering some points and their neighboring squares, closest first, at most `max`. */
export function topicsAround(points: LngLat[], max = 12): string[] {
  const out: string[] = []
  const add = (t: string) => { if (!out.includes(t) && out.length < max) out.push(t) }
  for (const p of points) add(cellTopic(p))
  for (const p of points) {
    for (const [dx, dy] of [[0, 0.4], [0, -0.4], [0.4, 0], [-0.4, 0], [0.4, 0.4], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4]]) {
      add(cellTopic([p[0] + dx, Math.max(-85, Math.min(85, p[1] + dy))]))
    }
  }
  return out
}

/** Points every ~20 km along a line, so a long route asks about every square it passes. */
export function samplePoints(line: LngLat[], everyMeters = 20000): LngLat[] {
  if (line.length === 0) return []
  const out: LngLat[] = [line[0]]
  let since = 0
  for (let i = 1; i < line.length; i++) {
    since += distanceMeters(line[i - 1], line[i])
    if (since >= everyMeters) { out.push(line[i]); since = 0 }
  }
  out.push(line[line.length - 1])
  return out
}

/** Read the last 12 hours of events for these squares. */
export async function fetchEvents(topics: string[], signal?: AbortSignal, base = NTFY_URL, now = Date.now()): Promise<RoadEvent[]> {
  if (topics.length === 0) return []
  const res = await fetch(`${base}/${topics.join(',')}/json?poll=1&since=12h`, { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`Reports service answered ${res.status}`)
  const text = await res.text()
  const out: RoadEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim() || out.length > 5000) continue
    try {
      const msg = JSON.parse(line) as { event?: string; time?: number; message?: string; topic?: string }
      if (msg.event !== 'message' || typeof msg.message !== 'string' || msg.message.length > 600) continue
      if (typeof msg.topic !== 'string' || !msg.topic.startsWith(TOPIC_PREFIX)) continue
      const e = parseEvent(JSON.parse(msg.message), (msg.time ?? 0) * 1000, now)
      if (e) out.push(e)
    } catch { /* skip lines that aren't ours */ }
  }
  return out
}

/** Send one event to a square's topic. text/plain keeps it a "simple" request (no CORS preflight). */
export async function publishEvent(topic: string, e: WireEvent, base = NTFY_URL): Promise<void> {
  const res = await fetch(`${base}/${topic}`, { method: 'POST', body: JSON.stringify(e), headers: { 'Content-Type': 'text/plain' } })
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many reports from your network. Try again in a minute.' : `Reports service answered ${res.status}`)
}

/** Where to send and read reports: ?reports=http://localhost:9999 points tests at a local stand-in. */
export function reportsBase(): string {
  try {
    const v = new URLSearchParams(window.location.search).get('reports')
    if (v && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v)) return v
  } catch { /* not in a browser */ }
  return NTFY_URL
}

// ---------------------------------------------------------------------------------------------
// This device: its random id, its votes, and its own sending limits.

const DEVICE_KEY = 'bm-locator.device-id'
const SENT_KEY = 'bm-locator.road-reports-sent'

export const randomId = (n = 16) => {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

export function deviceId(): string {
  try {
    const v = localStorage.getItem(DEVICE_KEY)
    if (v && ID_RE.test(v)) return v
    const id = randomId()
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    return (memoryId ??= randomId())
  }
}
let memoryId: string | undefined

interface Sent { news: number[]; votes: Record<string, { v: 'yes' | 'no'; at: number }> }
export function loadSent(now = Date.now()): Sent {
  try {
    const s = JSON.parse(localStorage.getItem(SENT_KEY) ?? '{}') as Partial<Sent>
    const votes = Object.fromEntries(Object.entries(s.votes ?? {}).filter(([, x]) => now - x.at < MAX_AGE_MS))
    return { news: (s.news ?? []).filter((t) => now - t < 3600_000), votes }
  } catch {
    return { news: [], votes: {} }
  }
}
export function saveSent(s: Sent) {
  try { localStorage.setItem(SENT_KEY, JSON.stringify(s)) } catch { /* storage blocked */ }
}

/** Why this device can't send a new report right now, or null. */
export function sendLimit(s: Sent, now = Date.now()): string | null {
  const recent = s.news.filter((t) => now - t < 3600_000)
  if (recent.length >= MAX_NEW_PER_DEVICE_HOUR - 1) return 'You have sent several reports this hour. Please wait a while before sending more.'
  const last = Math.max(0, ...recent)
  if (now - last < 30_000) return 'Please wait a few seconds before sending another report.'
  return null
}

export function agoText(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60 ? `${min % 60} min ` : ''}ago`
}
