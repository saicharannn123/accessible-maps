import { describe, expect, it } from 'vitest'
import { commonsFile, kindFromTag, kindFromTags, parseCommons, plainText, shortAbout, targetFromPlace } from '../details'

describe('commonsFile', () => {
  it('reads Wikidata P18 values and OSM wikimedia_commons tags', () => {
    expect(commonsFile('Liberty Science Center.jpg')).toBe('Liberty Science Center.jpg')
    expect(commonsFile('File:Some_Park_2019.JPG')).toBe('Some Park 2019.JPG')
  })
  it('reads Commons and upload.wikimedia.org links', () => {
    expect(commonsFile('https://commons.wikimedia.org/wiki/Special:FilePath/Eiffel%20Tower.jpg?width=640')).toBe('Eiffel Tower.jpg')
    expect(commonsFile('https://commons.wikimedia.org/wiki/File:Foo_bar.jpg')).toBe('Foo bar.jpg')
    expect(commonsFile('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo.jpg/640px-Foo.jpg')).toBe('Foo.jpg')
  })
  it('refuses other hosts, categories, logos and documents', () => {
    expect(commonsFile('https://example.com/photo.jpg')).toBeUndefined()
    expect(commonsFile('Category:Parks in New Jersey')).toBeUndefined()
    expect(commonsFile('Logo.svg')).toBeUndefined()
    expect(commonsFile('Brochure.pdf')).toBeUndefined()
    expect(commonsFile(undefined)).toBeUndefined()
  })
})

describe('parseCommons', () => {
  it('gives the thumbnail, author as plain text and the license', () => {
    const p = parseCommons({ query: { pages: { '1': { imageinfo: [{
      thumburl: 'https://upload.wikimedia.org/x/720px-a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:A.jpg',
      extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane &amp; Co</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } },
    }] } } } })
    expect(p).toEqual({ src: 'https://upload.wikimedia.org/x/720px-a.jpg', page: 'https://commons.wikimedia.org/wiki/File:A.jpg', author: 'Jane & Co', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0' })
  })
  it('gives nothing for a missing file or a non-web link', () => {
    expect(parseCommons({ query: { pages: { '-1': { missing: '' } } } })).toBeUndefined()
    expect(parseCommons({ query: { pages: { '1': { imageinfo: [{ thumburl: 'javascript:alert(1)', descriptionurl: 'https://commons.wikimedia.org/wiki/File:A.jpg' }] } } } })).toBeUndefined()
  })
})

describe('text helpers', () => {
  it('strips HTML', () => expect(plainText('<span>Photo by <b>Al</b></span>')).toBe('Photo by Al'))
  it('unescapes each entity once', () => expect(plainText('A &amp;lt;b&amp;gt; &amp; C')).toBe('A &lt;b&gt; & C'))
  it('keeps one or two sentences', () => {
    const t = 'Verona Park is a park in Verona, New Jersey. It has a lake. It opened in 1920.'
    expect(shortAbout(t)).toBe('Verona Park is a park in Verona, New Jersey. It has a lake.')
    expect(shortAbout('The museum is on St. Mark St. in town. Second one. Third.')).toBe('The museum is on St. Mark St. in town. Second one.')
  })
})

describe('kinds', () => {
  it('names places from their tags', () => {
    expect(kindFromTag('tourism=museum')).toBe('Museum')
    expect(kindFromTag('place=house')).toBe('Address')
    expect(kindFromTags({ leisure: 'park', name: 'X' })).toBe('Park')
    expect(kindFromTags({ 'addr:housenumber': '276', 'addr:street': 'Mill Road' })).toBe('Address')
    expect(kindFromTags({ amenity: 'restaurant', cuisine: 'italian;pizza' })).toBe('Italian restaurant')
  })
  it('gives every selection its own key', () => {
    const a = targetFromPlace({ name: 'A', detail: '', coords: [1, 2], osm: 'node/1' })
    const b = targetFromPlace({ name: 'A', detail: '', coords: [1, 2.001], osm: 'node/1' })
    expect(a.key).not.toBe(b.key)
  })
})
