import { OSM_API_URL } from '../config'
import { cityStatePostal, cleanPostcode } from './address'
import { fetchWithTimeout, type NearbyPlace, type Wheelchair } from './places'
import { safeWebUrl } from './safeUrl'
import type { LngLat, Place } from './types'

/**
 * The details card: everything worth knowing about one selected spot, from reliable sources only.
 *
 * - OpenStreetMap: the object's own tags (address, hours, website, wheelchair access, description).
 * - Wikidata: only when the OSM object (or the famous-place pin) names its Wikidata item. We never
 *   guess an item from a name, so a plain address never gets someone else's photo.
 * - Wikimedia Commons: the photo (Wikidata P18, or the OSM wikimedia_commons / image tag) with its
 *   author and license, read from Commons itself.
 * - Wikipedia: a one- or two-sentence description, from the article the Wikidata item links to.
 */

/** What we know about a selection before any lookup: enough to draw the card straight away. */
export interface DetailTarget {
  /** Changes whenever the selection does; answers for an older key are ignored. */
  key: string
  name: string
  coords: LngLat
  icon?: string
  /** What it is, e.g. "Museum" or "Italian restaurant". */
  kind?: string
  osm?: string
  osmTag?: string
  wikidata?: string
  photo?: string
  about?: string
  wiki?: string
  street?: string
  area?: string
  postcode?: string
  country?: string
  /** One-line address when that's all we have (category results). */
  address?: string
  hours?: string
  website?: string
  phone?: string
  wheelchair?: Wheelchair
}

export interface PhotoCredit {
  /** Image to show (a Commons thumbnail). */
  src: string
  /** The file's page on Commons, where the full credit and license live. */
  page: string
  author: string
  license?: string
  licenseUrl?: string
}

export interface PlaceFacts {
  kind?: string
  street?: string
  area?: string
  postcode?: string
  country?: string
  about?: { text: string; source: 'Wikipedia' | 'Wikidata' | 'OpenStreetMap'; url?: string }
  photo?: PhotoCredit
  hours?: string
  website?: string
  phone?: string
  wheelchair: Wheelchair
  wheelchairNote?: string
  toiletsWheelchair?: Wheelchair
  osm?: string
  wikidata?: string
  /** Some source didn't answer, so the card may be missing something. */
  partial?: boolean
}

// --- Turning the app's different selections into one target -----------------------------------

export function targetFromPlace(p: Place): DetailTarget {
  return {
    key: `p:${p.wikidata ?? p.osm ?? ''}|${p.name}|${p.coords[0].toFixed(5)},${p.coords[1].toFixed(5)}`,
    name: p.name, coords: p.coords, icon: p.icon, kind: kindFromTag(p.osmTag), osm: p.osm, osmTag: p.osmTag,
    wikidata: p.wikidata, photo: p.photo, about: p.about, wiki: p.wiki,
    street: p.street, area: p.area, postcode: p.postcode, country: p.country,
  }
}

export function targetFromNearby(p: NearbyPlace, icon?: string): DetailTarget {
  return {
    key: `n:${p.id}`, name: p.name, coords: p.coords, icon, kind: p.kind, osm: p.id,
    address: p.address, hours: p.openingHours, website: p.website, phone: p.phone, wheelchair: p.wheelchair,
  }
}

// --- What kind of place -------------------------------------------------------------------------

const PRETTY: Record<string, string> = {
  fuel: 'Gas station', charging_station: 'EV charger', atm: 'ATM', cafe: 'Café', toilets: 'Public restroom',
  fitness_centre: 'Gym', department_store: 'Department store', mall: 'Shopping mall', guest_house: 'Guest house',
  bus_station: 'Bus station', halt: 'Train stop', post_office: 'Post office', fast_food: 'Takeout',
  nature_reserve: 'Nature reserve', place_of_worship: 'Place of worship', townhall: 'Town hall',
  community_centre: 'Community center', arts_centre: 'Arts center', sports_centre: 'Sports center',
  playground: 'Playground', golf_course: 'Golf course', dog_park: 'Dog park', picnic_site: 'Picnic site',
  viewpoint: 'Viewpoint', attraction: 'Attraction', peak: 'Mountain peak', water: 'Lake or pond',
  house: 'Address', residential: 'Address', detached: 'Address', apartments: 'Apartment building',
  yes: 'Building', building: 'Building',
}
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
const KIND_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'office', 'craft', 'healthcare', 'railway', 'natural', 'boundary', 'place', 'building']

/** "tourism=museum" → "Museum"; "place=house" → "Address". */
export function kindFromTag(tag: string | undefined): string | undefined {
  if (!tag) return undefined
  const [k, v] = tag.split('=')
  if (!v || v === 'no') return undefined
  if (k === 'boundary' && v === 'national_park') return 'National park'
  if (k === 'boundary' && v === 'protected_area') return 'Protected area'
  if (k === 'place' && v !== 'house') return titleCase(v)
  if (k === 'highway') return 'Street'
  return PRETTY[v] ?? titleCase(v)
}

/** The kind of place from all its OSM tags, most telling tag first. */
export function kindFromTags(t: Record<string, string>): string | undefined {
  if (t.cuisine && (t.amenity === 'restaurant' || t.amenity === 'fast_food')) {
    return `${titleCase(t.cuisine.split(';')[0])} ${t.amenity === 'fast_food' ? 'takeout' : 'restaurant'}`
  }
  for (const k of KIND_KEYS) if (t[k]) return kindFromTag(`${k}=${t[k]}`)
  if (t['addr:housenumber']) return 'Address'
  return undefined
}

function wheelchairOf(v: string | undefined): Wheelchair {
  return v === 'yes' || v === 'designated' ? 'yes' : v === 'limited' ? 'limited' : v === 'no' ? 'no' : 'unknown'
}

// --- Wikimedia Commons --------------------------------------------------------------------------

/**
 * The Commons file name in a Wikidata P18 value, an OSM wikimedia_commons tag ("File:X.jpg"), or
 * a Commons / upload.wikimedia.org link. Only real photos: no maps, logos (SVG) or documents.
 */
export function commonsFile(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let s = raw.trim()
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s)
      if (u.hostname === 'upload.wikimedia.org') {
        // /wikipedia/commons/a/ab/Name.jpg or /wikipedia/commons/thumb/a/ab/Name.jpg/640px-Name.jpg
        const m = /\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/.exec(u.pathname)
        if (!m) return undefined
        s = decodeURIComponent(m[1])
      } else if (u.hostname === 'commons.wikimedia.org') {
        const m = /\/wiki\/(?:Special:FilePath\/|File:)(.+)$/.exec(u.pathname)
        if (!m) return undefined
        s = decodeURIComponent(m[1])
      } else return undefined
    }
  } catch { return undefined }
  s = s.replace(/^(File|Image):/i, '').replace(/_/g, ' ').trim()
  if (!s || s.includes('/') || !/\.(jpe?g|png|webp|tiff?)$/i.test(s)) return undefined
  return s
}

/** Plain text from the bit of HTML Commons uses for an author ("<a href=…>Jane</a>"). */
export function plainText(html: string | undefined): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, ' ')
    // &amp; last, so "&amp;lt;" reads as the text "&lt;" instead of turning into "<".
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

interface CommonsAnswer {
  query?: { pages?: Record<string, { missing?: string; imageinfo?: { thumburl?: string; url?: string; descriptionurl?: string
    extmetadata?: Record<string, { value?: string }> }[] }> }
}

/** Read a Commons file's thumbnail, author and license. Exported for tests. */
export function parseCommons(data: CommonsAnswer): PhotoCredit | undefined {
  const page = Object.values(data.query?.pages ?? {})[0]
  const info = page && !('missing' in page) ? page.imageinfo?.[0] : undefined
  const src = safeWebUrl(info?.thumburl ?? info?.url)
  const filePage = safeWebUrl(info?.descriptionurl)
  if (!info || !src || !filePage) return undefined
  const meta = info.extmetadata ?? {}
  const author = plainText(meta.Artist?.value) || plainText(meta.Credit?.value) || 'Unknown author'
  const license = plainText(meta.LicenseShortName?.value) || undefined
  return { src, page: filePage, author: author.length > 80 ? `${author.slice(0, 77)}…` : author, license, licenseUrl: safeWebUrl(plainText(meta.LicenseUrl?.value)) }
}

async function commonsPhoto(file: string, signal?: AbortSignal): Promise<PhotoCredit | undefined> {
  const params = new URLSearchParams({
    action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '720',
    iiextmetadatafilter: 'Artist|Credit|LicenseShortName|LicenseUrl', format: 'json', origin: '*',
  })
  const res = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${params}`, {}, 9000, signal)
  if (!res.ok) throw new Error(`Commons ${res.status}`)
  return parseCommons(await res.json())
}

// --- Wikidata and Wikipedia ---------------------------------------------------------------------

interface WikidataEntity {
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>
  descriptions?: Record<string, { value?: string }>
  sitelinks?: Record<string, { title?: string }>
}

async function wikidataEntity(q: string, signal?: AbortSignal): Promise<WikidataEntity | undefined> {
  const params = new URLSearchParams({
    action: 'wbgetentities', ids: q, props: 'claims|descriptions|sitelinks', languages: 'en', sitefilter: 'enwiki',
    format: 'json', origin: '*',
  })
  const res = await fetchWithTimeout(`https://www.wikidata.org/w/api.php?${params}`, {}, 9000, signal)
  if (!res.ok) throw new Error(`Wikidata ${res.status}`)
  const data = (await res.json()) as { entities?: Record<string, WikidataEntity> }
  return data.entities?.[q]
}

const claim = (e: WikidataEntity | undefined, p: string): string | undefined => {
  const v = e?.claims?.[p]?.[0]?.mainsnak?.datavalue?.value
  return typeof v === 'string' ? v : undefined
}

/** The first one or two sentences of a text, kept short for the card. Exported for tests. */
export function shortAbout(text: string, maxSentences = 2, maxChars = 320): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  // Split after ". " followed by a capital, but not after initials or common abbreviations (St., Mt., U.S.).
  const parts = clean.split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
  let out = ''
  let n = 0
  for (const part of parts) {
    if (/\b(St|Mt|Ft|Dr|Mr|Mrs|Ms|Jr|Sr|No|U\.S|[A-Z])\.$/.test(part) && out.length + part.length < maxChars) {
      out = out ? `${out} ${part}` : part
      continue
    }
    if (n >= maxSentences) break
    if (out && out.length + part.length + 1 > maxChars) break
    out = out ? `${out} ${part}` : part
    n++
  }
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).replace(/\s+\S*$/, '')}…`
  return out
}

async function wikipediaSummary(title: string, signal?: AbortSignal): Promise<{ text: string; url?: string } | undefined> {
  const res = await fetchWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, {}, 9000, signal)
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`)
  const data = (await res.json()) as { type?: string; extract?: string; content_urls?: { desktop?: { page?: string } } }
  if (data.type === 'disambiguation' || !data.extract) return undefined
  return { text: shortAbout(data.extract), url: safeWebUrl(data.content_urls?.desktop?.page) }
}

// --- OpenStreetMap ------------------------------------------------------------------------------

async function osmTags(osm: string, signal?: AbortSignal): Promise<Record<string, string> | null> {
  if (!/^(node|way|relation)\/\d+$/.test(osm)) return null
  const res = await fetchWithTimeout(`${OSM_API_URL}/${osm}.json`, {}, 8000, signal)
  if (!res.ok) throw new Error(`OSM ${res.status}`)
  const data = (await res.json()) as { elements?: { tags?: Record<string, string> }[] }
  return data.elements?.[0]?.tags ?? {}
}

// --- Putting it together ------------------------------------------------------------------------

const cache = new Map<string, PlaceFacts>()
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError') }

/** Everything for the card. Sources that fail are skipped (and marked partial), never guessed. */
export async function loadDetails(t: DetailTarget, signal?: AbortSignal): Promise<PlaceFacts> {
  const hit = cache.get(t.key)
  if (hit) return hit
  let partial = false
  const soft = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => { aborted(signal); void e; partial = true; return undefined })

  // 1. The OSM object's own tags.
  const tags = (t.osm ? await soft(osmTags(t.osm, signal)) : null) ?? {}
  aborted(signal)
  const wikidata = (/^Q\d+$/.test(tags.wikidata ?? '') ? tags.wikidata : undefined) ?? t.wikidata

  // 2. Its Wikidata item, if the data names one.
  const entity = wikidata ? await soft(wikidataEntity(wikidata, signal)) : undefined
  aborted(signal)

  // 3. Photo and description at the same time.
  const file = commonsFile(claim(entity, 'P18')) ?? commonsFile(tags.wikimedia_commons) ?? commonsFile(tags.image) ?? commonsFile(t.photo)
  const enwiki = entity?.sitelinks?.enwiki?.title ?? (/^en:/.test(tags.wikipedia ?? '') ? tags.wikipedia.slice(3) : undefined)
  const [photo, wiki] = await Promise.all([
    file ? soft(commonsPhoto(file, signal)) : undefined,
    enwiki ? soft(wikipediaSummary(enwiki, signal)) : undefined,
  ])
  aborted(signal)

  const wdDesc = entity?.descriptions?.en?.value
  const about: PlaceFacts['about'] = wiki?.text ? { text: wiki.text, source: 'Wikipedia', url: wiki.url ?? safeWebUrl(t.wiki) }
    : tags.description ? { text: shortAbout(tags.description), source: 'OpenStreetMap' }
    : wdDesc ? { text: wdDesc[0].toUpperCase() + wdDesc.slice(1) + (/[.!?]$/.test(wdDesc) ? '' : '.'), source: 'Wikidata', url: `https://www.wikidata.org/wiki/${wikidata}` }
    : t.about ? { text: t.about[0].toUpperCase() + t.about.slice(1) + (/[.!?]$/.test(t.about) ? '' : '.'), source: 'Wikidata', url: wikidata ? `https://www.wikidata.org/wiki/${wikidata}` : undefined }
    : undefined

  const country = (tags['addr:country'] ?? t.country)?.toUpperCase()
  const tagStreet = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
  const postcode = cleanPostcode(tags['addr:postcode'], country) ?? t.postcode
  const tagArea = tags['addr:city'] ? cityStatePostal({ city: tags['addr:city'], state: tags['addr:state'], postcode, country }) : ''

  const facts: PlaceFacts = {
    kind: kindFromTags(tags) ?? t.kind,
    street: tagStreet || t.street,
    area: tagArea || t.area,
    postcode,
    country,
    about,
    photo,
    hours: tags.opening_hours ?? t.hours,
    website: safeWebUrl(tags.website ?? tags['contact:website'] ?? tags.url ?? t.website ?? claim(entity, 'P856')),
    phone: tags.phone ?? tags['contact:phone'] ?? t.phone,
    wheelchair: tags.wheelchair ? wheelchairOf(tags.wheelchair) : (t.wheelchair ?? 'unknown'),
    wheelchairNote: tags['wheelchair:description:en'] ?? tags['wheelchair:description'],
    toiletsWheelchair: tags['toilets:wheelchair'] ? wheelchairOf(tags['toilets:wheelchair']) : undefined,
    osm: t.osm,
    wikidata,
    partial,
  }
  if (!partial) cache.set(t.key, facts)
  return facts
}
