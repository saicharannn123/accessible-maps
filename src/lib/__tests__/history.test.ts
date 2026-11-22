import { describe, expect, it } from 'vitest'
import { addHistory, MAX_HISTORY, type HistoryEntry, type HistoryItem } from '../history'

const place = (name: string, x = 0): HistoryEntry => ({ kind: 'place', place: { name, detail: '', coords: [x, 0] } })

describe('history', () => {
  it('puts the newest first and drops the older copy', () => {
    const list = addHistory(addHistory(addHistory([], place('A')), place('B')), place('A', 0.00001))
    expect(list.map((i) => i.kind === 'place' && i.place.name)).toEqual(['A', 'B'])
  })
  it('keeps the same name at a different spot', () => {
    expect(addHistory(addHistory([], place('Walmart', 0)), place('Walmart', 1))).toHaveLength(2)
  })
  it('caps the list', () => {
    let list: HistoryItem[] = []
    for (let i = 0; i < 30; i++) list = addHistory(list, place(`P${i}`, i))
    expect(list).toHaveLength(MAX_HISTORY)
    expect(list[0].kind === 'place' && list[0].place.name).toBe('P29')
  })
  it('tells trips apart by start and end', () => {
    const to = { name: 'T', detail: '', coords: [1, 1] as [number, number] }
    const a: HistoryItem = { kind: 'route', from: null, to, mode: 'car', at: 1 }
    const b: HistoryEntry = { kind: 'route', from: { name: 'S', detail: '', coords: [2, 2] }, to, mode: 'car' }
    expect(addHistory([a], b)).toHaveLength(2)
    expect(addHistory([a], { ...a, mode: 'walk' })).toHaveLength(1)
  })
})
