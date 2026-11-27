import { useSyncExternalStore } from 'react'
import type { LngLat } from './types'

/*
 * My Maps: named maps of saved places and your own pins, kept in this browser (localStorage).
 *
 * Every item stores its own name and coordinates, never a tile or feature id, so saved places,
 * pins and notes stay put when the underlying map data is refreshed.
 */

const KEY = 'accessible-maps.my-maps'
export const MAX_MAPS = 50
export const MAX_ITEMS = 300
export const MAX_NOTE = 500
export const MAX_LABEL = 80

/** Pin colors to pick from; the first is the app's violet. */
export const PIN_COLORS = ['#5b3df5', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#2563eb', '#475569'] as const

/** What the Save button needs to know about a place, from search, Related places or a dropped pin. */
export interface SaveablePlace {
  name: string
  coords: LngLat
  /** Kind of place, e.g. "Mountain" or "Trailhead"; for a search result, its address line. */
  kind?: string
  detail?: string
  icon?: string
  source?: 'search' | 'related' | 'pin'
  /** OpenStreetMap ("node/123", "way/4") or Wikidata ("wd:Q123") id, for a link back to the source. */
  osmId?: string
}

export interface MapItem {
  id: string
  /** The place's own name when saved. */
  name: string
  /** Your label; shown instead of the name when set. */
  label?: string
  coords: LngLat
  color: string
  note?: string
  kind?: string
  icon?: string
  source: 'search' | 'related' | 'pin'
  osmId?: string
  addedAt: number
  updatedAt: number
}

export interface MyMap {
  id: string
  name: string
  items: MapItem[]
  createdAt: number
  updatedAt: number
}

export interface MyMapsState {
  maps: MyMap[]
  /** The map new saves go to by default: the one you last opened or saved to. */
  activeId: string | null
}

export const EMPTY: MyMapsState = { maps: [], activeId: null }

const newId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
const clip = (s: string, n: number) => s.trim().slice(0, n)
export const itemTitle = (i: MapItem) => i.label?.trim() || i.name

/** Same place: same name within about 10 m. */
export function samePlace(a: { name: string; coords: LngLat }, b: { name: string; coords: LngLat }): boolean {
  return a.name === b.name && Math.abs(a.coords[0] - b.coords[0]) < 1e-4 && Math.abs(a.coords[1] - b.coords[1]) < 1e-4
}

export function findItem(map: MyMap, p: { name: string; coords: LngLat }): MapItem | undefined {
  return map.items.find((i) => samePlace(i, p))
}

/** A fresh name like "My map 2" that isn't taken yet. */
export function nextMapName(state: MyMapsState, base = 'My map'): string {
  const taken = new Set(state.maps.map((m) => m.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

const touch = (state: MyMapsState, id: string, fn: (m: MyMap) => MyMap, at: number): MyMapsState => ({
  ...state,
  maps: state.maps.map((m) => (m.id === id ? { ...fn(m), updatedAt: at } : m)),
})

export function createMap(state: MyMapsState, name: string, at = Date.now(), id = newId()): { state: MyMapsState; id: string } {
  if (state.maps.length >= MAX_MAPS) return { state, id: '' }
  const map: MyMap = { id, name: clip(name, MAX_LABEL) || nextMapName(state), items: [], createdAt: at, updatedAt: at }
  return { state: { maps: [map, ...state.maps], activeId: id }, id }
}

export function renameMap(state: MyMapsState, id: string, name: string, at = Date.now()): MyMapsState {
  const n = clip(name, MAX_LABEL)
  return n ? touch(state, id, (m) => ({ ...m, name: n }), at) : state
}

export function deleteMap(state: MyMapsState, id: string): MyMapsState {
  const maps = state.maps.filter((m) => m.id !== id)
  return { maps, activeId: state.activeId === id ? maps[0]?.id ?? null : state.activeId }
}

export function setActive(state: MyMapsState, id: string | null): MyMapsState {
  return state.activeId === id ? state : { ...state, activeId: id }
}

/** Save a place to a map. Saving the same place twice keeps the first copy (and your notes). */
export function addItem(state: MyMapsState, mapId: string, p: SaveablePlace, at = Date.now(), id = newId()): { state: MyMapsState; id: string } {
  const map = state.maps.find((m) => m.id === mapId)
  if (!map) return { state, id: '' }
  const name = clip(p.name, MAX_LABEL) || 'Dropped pin'
  const existing = findItem(map, { name, coords: p.coords })
  if (existing) return { state: setActive(state, mapId), id: existing.id }
  if (map.items.length >= MAX_ITEMS) return { state, id: '' }
  const item: MapItem = {
    id, name, coords: [p.coords[0], p.coords[1]],
    color: p.source === 'pin' ? PIN_COLORS[1] : PIN_COLORS[0],
    // Search details start with the distance from where you were ("8.3 km · …"), which goes stale.
    kind: (p.kind?.trim() || p.detail?.trim() || '').replace(/^[\d.,]+\s?(mi|km|ft|m)(\s·\s|$)/, '') || undefined,
    icon: p.icon, source: p.source ?? 'search', osmId: p.osmId, addedAt: at, updatedAt: at,
  }
  return { state: setActive(touch(state, mapId, (m) => ({ ...m, items: [...m.items, item] }), at), mapId), id }
}

export type ItemPatch = Partial<Pick<MapItem, 'label' | 'color' | 'note' | 'coords' | 'name'>>

export function updateItem(state: MyMapsState, mapId: string, itemId: string, patch: ItemPatch, at = Date.now()): MyMapsState {
  const clean: ItemPatch = { ...patch }
  if (clean.label !== undefined) clean.label = clean.label.slice(0, MAX_LABEL)
  if (clean.note !== undefined) clean.note = clean.note.slice(0, MAX_NOTE)
  if (clean.color !== undefined && !/^#[0-9a-f]{6}$/i.test(clean.color)) delete clean.color
  return touch(state, mapId, (m) => ({ ...m, items: m.items.map((i) => (i.id === itemId ? { ...i, ...clean, updatedAt: at } : i)) }), at)
}

export function removeItem(state: MyMapsState, mapId: string, itemId: string, at = Date.now()): MyMapsState {
  return touch(state, mapId, (m) => ({ ...m, items: m.items.filter((i) => i.id !== itemId) }), at)
}

// ---- Reading saved data defensively: storage can hold anything (old versions, hand edits, imports).

const isCoords = (c: unknown): c is LngLat =>
  Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
  Math.abs(c[0] as number) <= 180 && Math.abs(c[1] as number) <= 90
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined)

function readItem(x: unknown): MapItem | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (!isCoords(o.coords) || typeof o.name !== 'string') return null
  const color = typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : PIN_COLORS[0]
  const source = o.source === 'related' || o.source === 'pin' ? o.source : 'search'
  return {
    id: str(o.id, 64) || newId(), name: o.name.slice(0, MAX_LABEL), label: str(o.label, MAX_LABEL), coords: [o.coords[0], o.coords[1]],
    color, note: str(o.note, MAX_NOTE), kind: str(o.kind, 120), icon: str(o.icon, 8), source, osmId: str(o.osmId, 64),
    addedAt: Number(o.addedAt) || 0, updatedAt: Number(o.updatedAt) || 0,
  }
}

function readMap(x: unknown): MyMap | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o.name !== 'string') return null
  const items = Array.isArray(o.items) ? o.items.map(readItem).filter((i): i is MapItem => i != null).slice(0, MAX_ITEMS) : []
  return { id: str(o.id, 64) || newId(), name: o.name.slice(0, MAX_LABEL) || 'My map', items, createdAt: Number(o.createdAt) || 0, updatedAt: Number(o.updatedAt) || 0 }
}

/** Parse saved or imported My Maps data, dropping anything malformed. */
export function parseMyMaps(raw: unknown): MyMapsState {
  if (!raw || typeof raw !== 'object') return EMPTY
  const o = raw as Record<string, unknown>
  const maps = Array.isArray(o.maps) ? o.maps.map(readMap).filter((m): m is MyMap => m != null).slice(0, MAX_MAPS) : []
  const activeId = typeof o.activeId === 'string' && maps.some((m) => m.id === o.activeId) ? o.activeId : maps[0]?.id ?? null
  return { maps, activeId }
}

/** Add imported maps next to the ones already here; a map with the same id is replaced. */
export function mergeImport(state: MyMapsState, incoming: MyMapsState): MyMapsState {
  const ids = new Set(incoming.maps.map((m) => m.id))
  return { maps: [...incoming.maps, ...state.maps.filter((m) => !ids.has(m.id))].slice(0, MAX_MAPS), activeId: incoming.activeId ?? state.activeId }
}

export function exportJson(state: MyMapsState): string {
  return JSON.stringify({ app: 'BM Locator', kind: 'my-maps', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2)
}

// ---- A tiny shared store, so any part of the app (search card, Related places, the My Maps
// panel, the map) can read and save without passing props around. Other tabs stay in sync too.

function load(): MyMapsState {
  try { return parseMyMaps(JSON.parse(localStorage.getItem(KEY) ?? 'null')) } catch { return EMPTY }
}

let current: MyMapsState | null = null
let storageOk = true
const listeners = new Set<() => void>()

export function getMyMaps(): MyMapsState { return get() }

function get(): MyMapsState {
  if (!current) current = load()
  return current
}

export function updateMyMaps(fn: (s: MyMapsState) => MyMapsState): void {
  const next = fn(get())
  if (next === current) return
  current = next
  try { localStorage.setItem(KEY, JSON.stringify(next)); storageOk = true } catch { storageOk = false }
  listeners.forEach((l) => l())
}

/** False when the browser refused to save (private mode, storage full or blocked). */
export const myMapsSaved = () => storageOk

function subscribe(l: () => void) {
  listeners.add(l)
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { current = load(); listeners.forEach((x) => x()) } }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage) }
}

export function useMyMaps(): MyMapsState {
  return useSyncExternalStore(subscribe, get, () => EMPTY)
}

/** Save a place to a map (the active one, or a new "My map" if you have none). Returns the map id. */
export function savePlace(p: SaveablePlace, mapId?: string): string {
  let target = mapId ?? get().activeId ?? get().maps[0]?.id ?? null
  updateMyMaps((s) => {
    let st = s
    if (!target || !st.maps.some((m) => m.id === target)) {
      const made = createMap(st, nextMapName(st))
      st = made.state
      target = made.id
    }
    return addItem(st, target!, p).state
  })
  return target!
}

/** For tests: forget the cached copy so the next read comes from storage again. */
export function _resetMyMapsCache() { current = null }
