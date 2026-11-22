import { describe, expect, it } from 'vitest'
import { fameFor, famousQuery, parseFamous, snapBox, thumb } from './famous'

describe('famous places', () => {
  it('needs more fame the further out you zoom', () => {
    expect(fameFor(4)).toBeGreaterThan(fameFor(7))
    expect(fameFor(7)).toBeGreaterThan(fameFor(12))
  })

  it('snaps the view outward so small pans reuse the answer', () => {
    expect(snapBox([12.3, -13.2, 30.9, 4.7], 6)).toEqual([10, -15, 35, 5])
    expect(snapBox([12.4, -13.1, 30.8, 4.6], 6)).toEqual([10, -15, 35, 5])
    expect(snapBox([-200, -90, 200, 90], 3)).toEqual([-180, -85, 180, 85])
  })

  it('asks only for places inside the box and famous enough', () => {
    const q = famousQuery([10, -15, 35, 5], 15)
    expect(q).toContain('FILTER(?sl >= 15)')
    expect(q).toContain('geof:longitude(?coord) >= 10')
    expect(q).toContain('wd:Q46169')
  })

  it('reads Wikidata rows into places', () => {
    const v = (value: string) => ({ value })
    const [p] = parseFamous([{
      item: v('http://www.wikidata.org/entity/Q217232'), name: v('Virunga National Park'),
      c: v('POINT(29.5 -0.9166)'), t: v('http://www.wikidata.org/entity/Q46169'),
      photo: v('http://commons.wikimedia.org/wiki/Special:FilePath/Virunga.jpg'),
      about: v('national park in the Democratic Republic of the Congo'), wiki: v('https://en.wikipedia.org/wiki/Virunga_National_Park'), fame: v('79'),
    }])
    expect(p).toMatchObject({ id: 'Q217232', coords: [29.5, -0.9166], kind: 'National park', icon: '🌳', fame: 79 })
    expect(p.photo).toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Virunga.jpg?width=480')
  })

  it('makes https thumbnails', () => {
    expect(thumb('http://x/y.jpg', 200)).toBe('https://x/y.jpg?width=200')
  })
})
