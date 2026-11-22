import { describe, expect, it } from 'vitest'
import { parseQleverSignals } from './signals'

describe('signals from QLever', () => {
  it('reads OSM rows, keeping one per node', () => {
    const v = (value: string) => ({ value })
    const rows = [
      { n: v('https://www.openstreetmap.org/node/5'), hw: v('traffic_signals'), wkt: v('POINT(-74.3 40.79)') },
      { n: v('https://www.openstreetmap.org/node/5'), hw: v('traffic_signals'), wkt: v('POINT(-74.3 40.79)') },
      { n: v('https://www.openstreetmap.org/node/6'), hw: v('crossing'), wkt: v('POINT(-74.31 40.78)') },
    ]
    expect(parseQleverSignals(rows)).toEqual([
      { id: 5, coords: [-74.3, 40.79], kind: 'traffic' },
      { id: 6, coords: [-74.31, 40.78], kind: 'crossing' },
    ])
  })
})
