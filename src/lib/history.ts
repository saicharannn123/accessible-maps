import type { Place, TravelMode } from './types'

// Recent searches, places and trips, kept in this browser only.
const KEY = 'accessible-maps.history'
export const MAX_HISTORY = 15

export type HistoryEntry =
  | { kind: 'place'; place: Place }
  | { kind: 'route'; from: Place | null; to: Place; mode: TravelMode }
  | { kind: 'category'; category: string }
export type HistoryItem = HistoryEntry & { at: number }

const sameSpot = (a: Place | null, b: Place | null) =>
  a === b || (a != null && b != null && a.name === b.name &&
    Math.abs(a.coords[0] - b.coords[0]) < 1e-4 && Math.abs(a.coords[1] - b.coords[1]) < 1e-4)

export function sameItem(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.kind === 'place' && b.kind === 'place') return sameSpot(a.place, b.place)
  if (a.kind === 'route' && b.kind === 'route') return sameSpot(a.from, b.from) && sameSpot(a.to, b.to)
  if (a.kind === 'category' && b.kind === 'category') return a.category === b.category
  return false
}

/** Put the entry first (stamped now), dropping an older copy of it and anything past the limit. */
export function addHistory(list: HistoryItem[], entry: HistoryEntry, at = Date.now()): HistoryItem[] {
  // Search details start with the distance from where you were ("7.5 mi · …"), which goes stale.
  if (entry.kind === 'place') entry = { ...entry, place: { ...entry.place, detail: entry.place.detail.replace(/^[\d.,]+\s?(mi|km|ft|m)\s·\s/, '') } }
  return [{ ...entry, at }, ...list.filter((x) => !sameItem(x, entry))].slice(0, MAX_HISTORY)
}

export function loadHistory(): HistoryItem[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(all) ? all.filter((x) => x && typeof x.at === 'number').slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

export function saveHistory(list: HistoryItem[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* storage full or blocked */ }
}
