import { beforeEach, describe, expect, it } from 'vitest'
import {
  addItem, createMap, deleteMap, EMPTY, exportJson, findItem, mergeImport, MAX_NOTE, nextMapName, parseMyMaps, removeItem,
  renameMap, updateItem, type MyMapsState,
} from '../myMaps'

const nanda = { name: 'Nanda Devi', coords: [79.9707, 30.3755] as [number, number], kind: 'Mountain', source: 'search' as const }

function trip(): { s: MyMapsState; id: string } {
  const r = createMap(EMPTY, 'Himalayan Trip', 1, 'm1')
  return { s: r.state, id: r.id }
}

describe('My Maps', () => {
  it('creates a named map and makes it the default', () => {
    const { s, id } = trip()
    expect(s.maps[0]).toMatchObject({ id: 'm1', name: 'Himalayan Trip', items: [] })
    expect(s.activeId).toBe(id)
  })
  it('names unnamed maps without clashing', () => {
    let s = createMap(EMPTY, '').state
    expect(s.maps[0].name).toBe('My map')
    s = createMap(s, '  ').state
    expect(s.maps[0].name).toBe('My map 2')
    expect(nextMapName(s)).toBe('My map 3')
  })
  it('saves a place once, keeping the first copy and its notes', () => {
    const { s, id } = trip()
    const a = addItem(s, id, nanda, 2, 'i1')
    const withNote = updateItem(a.state, id, 'i1', { note: 'Base camp walk' }, 3)
    const again = addItem(withNote, id, { ...nanda, coords: [79.97071, 30.37551] }, 4, 'i2')
    expect(again.id).toBe('i1')
    expect(again.state.maps[0].items).toHaveLength(1)
    expect(again.state.maps[0].items[0].note).toBe('Base camp walk')
  })
  it('stores names and coordinates so items outlive map data updates', () => {
    const { s, id } = trip()
    const { state } = addItem(s, id, { ...nanda, osmId: 'node/123' }, 2, 'i1')
    const item = state.maps[0].items[0]
    expect(item).toMatchObject({ name: 'Nanda Devi', coords: [79.9707, 30.3755], kind: 'Mountain', osmId: 'node/123' })
    expect(findItem(state.maps[0], nanda)?.id).toBe('i1')
  })
  it('drops the stale distance from search details', () => {
    const { s, id } = trip()
    const { state } = addItem(s, id, { name: 'Nanda Devi', coords: [79.97, 30.37], kind: '8.3 km · Uttarakhand' }, 2, 'i1')
    expect(state.maps[0].items[0].kind).toBe('Uttarakhand')
  })
  it('edits labels, colors and notes, and ignores bad colors', () => {
    const { s, id } = trip()
    let st = addItem(s, id, { name: 'Dropped pin', coords: [80, 30.4], source: 'pin' }, 2, 'p1').state
    st = updateItem(st, id, 'p1', { label: 'Camp', color: '#16a34a', note: 'x'.repeat(MAX_NOTE + 50) })
    st = updateItem(st, id, 'p1', { color: 'red; background:url(x)' })
    expect(st.maps[0].items[0]).toMatchObject({ label: 'Camp', color: '#16a34a', source: 'pin' })
    expect(st.maps[0].items[0].note).toHaveLength(MAX_NOTE)
  })
  it('renames, removes items and deletes maps', () => {
    const { s, id } = trip()
    let st = addItem(s, id, nanda, 2, 'i1').state
    st = renameMap(st, id, 'Uttarakhand')
    expect(st.maps[0].name).toBe('Uttarakhand')
    expect(renameMap(st, id, '   ')).toBe(st)
    st = removeItem(st, id, 'i1')
    expect(st.maps[0].items).toHaveLength(0)
    st = deleteMap(st, id)
    expect(st).toEqual({ maps: [], activeId: null })
  })
  it('reads back what it saved and drops malformed entries', () => {
    const { s, id } = trip()
    const st = addItem(s, id, nanda, 2, 'i1').state
    expect(parseMyMaps(JSON.parse(JSON.stringify(st)))).toEqual(st)
    const messy = { maps: [{ name: 'A', items: [{ name: 'ok', coords: [1, 2] }, { name: 'bad', coords: [500, 2] }, null, 'x'] }, { items: [] }, 7] }
    const read = parseMyMaps(messy)
    expect(read.maps).toHaveLength(1)
    expect(read.maps[0].items.map((i) => i.name)).toEqual(['ok'])
    expect(parseMyMaps('nonsense')).toEqual(EMPTY)
  })
  it('round-trips a backup and merges it with existing maps', () => {
    const { s, id } = trip()
    const st = addItem(s, id, nanda, 2, 'i1').state
    const back = parseMyMaps(JSON.parse(exportJson(st)))
    expect(back.maps[0].items[0].name).toBe('Nanda Devi')
    const other = createMap(EMPTY, 'Paris', 1, 'm2').state
    const merged = mergeImport(other, back)
    expect(merged.maps.map((m) => m.name)).toEqual(['Himalayan Trip', 'Paris'])
  })
})

describe('My Maps store', () => {
  beforeEach(async () => {
    const store = new Map<string, string>()
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear(), key: () => null, length: 0,
    } as Storage
    ;(await import('../myMaps'))._resetMyMapsCache()
  })
  it('saves to a new map when there is none, and survives a reload', async () => {
    const m = await import('../myMaps')
    const id = m.savePlace(nanda)
    m._resetMyMapsCache() // like refreshing the page
    const after = m.getMyMaps()
    expect(after.maps).toHaveLength(1)
    expect(after.maps[0].id).toBe(id)
    expect(after.maps[0].items[0].name).toBe('Nanda Devi')
  })
})
