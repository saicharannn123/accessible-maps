import { OSM_API_URL, OVERPASS_URLS } from '../config'
import { FAMOUS_URL } from './famous'
import { distanceMeters } from './geo'
import { fetchWithTimeout } from './places'
import { QLEVER_OSM_URL } from './sources'
import type { LngLat, Place } from './types'

// Related places for the place you selected: first the spots the map data links to it directly
// (the national park a peak stands in, the peaks inside a park, landmarks in a city), then
// nearby spots that matter for that kind of place (trailheads and viewpoints around a mountain,
// visitor centres in a park, museums in a city).
//
// Direct links come from Wikidata (located in protected area, part of, mountain range…). Nearby
// spots come from OpenStreetMap, read through QLever, with public Overpass servers raced as a backup.

/** What kind of place was selected; decides what "relevant nearby" means and how far to look. */
export type AnchorKind = 'mountain' | 'park' | 'city' | 'other'

/** Map pin and list icon groups. Each has its own icon and color. */
export type RelatedGroup = 'mountain' | 'park' | 'trail' | 'visitor' | 'viewpoint' | 'camp' | 'water' | 'landmark' | 'museum' | 'transit'

export const GROUP_LOOK: Record<RelatedGroup, { icon: string; color: string; label: string }> = {
  mountain: { icon: '⛰️', color: '#8a5a2b', label: 'Mountain' },
  park: { icon: '🌲', color: '#15803d', label: 'Park' },
  trail: { icon: '🥾', color: '#c2410c', label: 'Trail' },
  visitor: { icon: 'ℹ️', color: '#1d4ed8', label: 'Visitor facility' },
  viewpoint: { icon: '🔭', color: '#7c3aed', label: 'Viewpoint' },
  camp: { icon: '⛺', color: '#a16207', label: 'Camp or hut' },
  water: { icon: '💧', color: '#0e7490', label: 'Water or ice' },
  landmark: { icon: '📍', color: '#5b3df5', label: 'Landmark' },
  museum: { icon: '🏛️', color: '#9d174d', label: 'Museum' },
  transit: { icon: '🚉', color: '#334155', label: 'Station' },
}

export type Wheelchair = 'yes' | 'limited' | 'no' | 'unknown'

/** How access is described; missing data is said plainly, never guessed. */
export const WHEELCHAIR_LINE: Record<Wheelchair, string> = {
  yes: '♿ Wheelchair accessible',
  limited: '♿ Partly accessible',
  no: 'Not wheelchair accessible',
  unknown: 'Accessibility unknown',
}

export interface RelatedSpot {
  /** "wd:Q123" for Wikidata items, "node/123" etc. for OpenStreetMap objects. */
  id: string
  name: string
  coords: LngLat
  group: RelatedGroup
  /** What it is, e.g. "National park", "Trailhead". */
  kind: string
  /** Why it shows up, e.g. "Trailhead for this park", "Nearby viewpoint". */
  reason: string
  /** Linked to the selected place in the data, rather than just close by. */
  direct: boolean
  /** Straight-line distance from the selected place, in meters. */
  distance: number
  wheelchair: Wheelchair
  wikidata?: string
  osm?: string
  /** Wikipedia languages, for ranking direct links. */
  fame?: number
}

export interface RelatedResult {
  kind: AnchorKind
  /** How far around the place nearby spots were looked for, in meters. */
  radius: number
  spots: RelatedSpot[]
  /** The selected place's own Wikidata item and wheelchair tag, when found. */
  wikidata?: string
  wheelchair: Wheelchair
  /** Set when one of the two data sources could not be reached. */
  partial?: boolean
}

export const RADIUS_BY_KIND: Record<AnchorKind, number> = { mountain: 40_000, park: 25_000, city: 4_000, other: 3_000 }

type Cell = { value: string } | undefined
type Row = Record<string, Cell>

/** "Point(lon lat)" to coordinates. */
export function parsePoint(wkt: string | undefined): LngLat | null {
  const m = wkt ? /point\s*\(\s*(-?[\d.e]+)\s+(-?[\d.e]+)/i.exec(wkt) : null
  return m ? [Number(m[1]), Number(m[2])] : null
}

const qid = (uri: string | undefined) => uri?.split('/').pop() ?? ''
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// ---------------------------------------------------------------------------------------------
// What kind of place is it?

const OSM_KIND: [RegExp, AnchorKind][] = [
  [/^natural=(peak|volcano|mountain_range|ridge|hill|massif)$/, 'mountain'],
  [/^(boundary=(national_park|protected_area)|leisure=(nature_reserve|park)|landuse=forest)$/, 'park'],
  [/^(place=(city|town|municipality|borough|suburb|village)|boundary=administrative)$/, 'city'],
]

/** Kind from an OSM tag like "natural=peak". */
export function kindFromOsmTag(tag: string | undefined): AnchorKind | null {
  if (!tag) return null
  for (const [re, k] of OSM_KIND) if (re.test(tag)) return k
  return null
}

/** Kind from the description shown under a famous place ("National park", "Mountain"…). */
export function kindFromText(text: string | undefined): AnchorKind | null {
  const t = (text ?? '').toLowerCase()
  if (/mountain|peak|volcano|summit|massif|\bhill\b/.test(t)) return 'mountain'
  if (/national park|protected|reserve|sanctuary|\bpark\b|forest|biosphere/.test(t)) return 'park'
  if (/\b(city|capital|town|metropolis|municipality)\b/.test(t)) return 'city'
  return null
}

// Wikidata classes we test the selected item against (anything that is a subclass counts too).
const KIND_ROOTS: Record<string, AnchorKind> = {
  Q8502: 'mountain', Q207326: 'mountain', Q8072: 'mountain', Q46831: 'mountain',
  Q473972: 'park', Q22698: 'park', Q158454: 'park',
  Q515: 'city', Q3957: 'city', Q1549591: 'city', Q5119: 'city',
}

/** Group for a related Wikidata item, from the English name of its class. */
export function groupFromText(text: string): RelatedGroup {
  const t = text.toLowerCase()
  if (/mountain|peak|summit|volcano|massif|ridge|\bhill\b|range|col\b|pass\b/.test(t)) return 'mountain'
  if (/park|reserve|protected|sanctuary|biosphere|forest|wilderness|heritage site/.test(t)) return 'park'
  if (/trail|path|route|trek/.test(t)) return 'trail'
  if (/glacier|lake|river|waterfall|spring|stream|reservoir|sea\b|bay\b/.test(t)) return 'water'
  if (/museum|gallery/.test(t)) return 'museum'
  if (/station|airport|metro/.test(t)) return 'transit'
  if (/viewpoint|observation/.test(t)) return 'viewpoint'
  if (/camp|hut|refuge|lodge/.test(t)) return 'camp'
  if (/visitor|information|ranger/.test(t)) return 'visitor'
  return 'landmark'
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

// ---------------------------------------------------------------------------------------------
// Wikidata: find the item, then what it links to.

async function sparql(url: string, query: string, signal?: AbortSignal, ms = 20000): Promise<Row[]> {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query }),
  }, ms, signal)
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  const data = (await res.json()) as { results?: { bindings?: Row[] } }
  return data.results?.bindings ?? []
}

const WD_PREFIX = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
`

/** The Wikidata item with exactly this English name close to a point, best known first. Exported for tests. */
export function findItemQuery(name: string, [lng, lat]: LngLat, deg = 0.3): string {
  const dLng = deg / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  return `${WD_PREFIX}SELECT ?item ?c ?sl WHERE {
  ?item rdfs:label "${esc(name)}"@en .
  ?item wdt:P625 ?c .
  FILTER(geof:longitude(?c) >= ${(lng - dLng).toFixed(4)} && geof:longitude(?c) <= ${(lng + dLng).toFixed(4)} && geof:latitude(?c) >= ${(lat - deg).toFixed(4)} && geof:latitude(?c) <= ${(lat + deg).toFixed(4)})
  ?item wikibase:sitelinks ?sl .
} ORDER BY DESC(?sl) LIMIT 5`
}

export function kindQuery(q: string): string {
  const roots = Object.keys(KIND_ROOTS).map((r) => `wd:${r}`).join(' ')
  return `${WD_PREFIX}SELECT DISTINCT ?root WHERE { VALUES ?root { ${roots} } wd:${q} wdt:P31/wdt:P279* ?root }`
}

// How each link reads in the list, depending on which way it points.
export const LINKS: Record<string, { rank: number; reason: (kind: string, anchor: AnchorKind) => string }> = {
  park: { rank: 0, reason: (k) => `${cap(k || 'Protected area')} this place is in` },
  inPark: { rank: 1, reason: (k, a) => `${cap(k || 'Place')} inside this ${a === 'park' ? 'park' : 'area'}` },
  partOf: { rank: 2, reason: () => 'This place is part of it' },
  hasPart: { rank: 2, reason: () => 'Part of this place' },
  range: { rank: 3, reason: () => 'Mountain range this peak belongs to' },
  feature: { rank: 3, reason: () => 'Landform this place sits on' },
  onFeature: { rank: 1, reason: (k) => /park|protected|reserve/i.test(k) ? `${cap(k)} around this mountain` : `${cap(k || 'Place')} on this mountain` },
  inRange: { rank: 4, reason: () => 'Peak in this range' },
  inCity: { rank: 4, reason: (k) => `${cap(k || 'Landmark')} in this city` },
}

/** Everything linked to item `q` in Wikidata, with a name and coordinates. Exported for tests. */
export function linksQuery(q: string, city = false): string {
  const Q = `wd:${q}`
  return `${WD_PREFIX}SELECT ?r ?rel (SAMPLE(?nm) AS ?name) (SAMPLE(?c0) AS ?c) (MAX(?s) AS ?sl) WHERE {
  { BIND("park" AS ?rel) ${Q} wdt:P3018 ?r } UNION
  { BIND("inPark" AS ?rel) ?r wdt:P3018 ${Q} } UNION
  { BIND("partOf" AS ?rel) ${Q} wdt:P361 ?r } UNION
  { BIND("hasPart" AS ?rel) ?r wdt:P361 ${Q} } UNION
  { BIND("hasPart" AS ?rel) ${Q} wdt:P527 ?r } UNION
  { BIND("range" AS ?rel) ${Q} wdt:P4552 ?r } UNION
  { BIND("inRange" AS ?rel) ?r wdt:P4552 ${Q} } UNION
  { BIND("feature" AS ?rel) ${Q} wdt:P706 ?r } UNION
  { BIND("onFeature" AS ?rel) ?r wdt:P706 ${Q} }${city ? ` UNION
  { BIND("inCity" AS ?rel) ?r wdt:P131 ${Q} . ?r wikibase:sitelinks ?s1 . FILTER(?s1 >= 6) }` : ''}
  FILTER(?r != ${Q})
  ?r wdt:P625 ?c0 .
  ?r rdfs:label ?nm . FILTER(LANG(?nm) = "en")
  ?r wikibase:sitelinks ?s .
}
GROUP BY ?r ?rel ORDER BY DESC(?sl) LIMIT 150`
}

/**
 * The English class name ("national park", "glacier") of each item. A separate small query: joined
 * into the links query, QLever looks up the class of every item in Wikidata first, which takes seconds.
 */
export function typesQuery(ids: string[]): string {
  return `${WD_PREFIX}SELECT ?r (SAMPLE(?tl) AS ?type) WHERE {
  VALUES ?r { ${ids.map((q) => `wd:${q}`).join(' ')} }
  ?r wdt:P31 ?t . ?t rdfs:label ?tl . FILTER(LANG(?tl) = "en")
} GROUP BY ?r`
}

// Classes that are never a place you'd visit (administrative areas, people's settlements around a peak…).
const SKIP_TYPES = /^(human settlement|village|census town|tehsil|district|administrative|community development block|gram panchayat|human|city|town|county|state|country)/i

/** Wikidata rows to direct spots, keeping the strongest link for each item. Exported for tests. */
export function parseLinks(rows: Row[], from: LngLat, anchor: AnchorKind): RelatedSpot[] {
  const best = new Map<string, RelatedSpot & { rank: number }>()
  for (const r of rows) {
    const coords = parsePoint(r.c?.value)
    const id = qid(r.r?.value)
    const rel = r.rel?.value ?? ''
    const link = LINKS[rel]
    if (!coords || !id || !r.name || !link) continue
    const type = r.type?.value ?? ''
    if (rel === 'inCity' && SKIP_TYPES.test(type)) continue
    const distance = distanceMeters(from, coords)
    // Peaks of a whole range only help when they're actually in the area.
    if (rel === 'inRange' && distance > 60_000) continue
    if (rel === 'inCity' && distance > 30_000) continue
    const fame = Number(r.sl?.value ?? 0)
    const spot = {
      id: `wd:${id}`, name: r.name.value, coords, group: groupFromText(`${type} ${rel === 'range' || rel === 'inRange' ? 'mountain' : ''}`),
      kind: cap(type) || 'Place', reason: link.reason(type, anchor), direct: true, distance, wheelchair: 'unknown' as Wheelchair,
      wikidata: id, fame, rank: link.rank,
    }
    const had = best.get(spot.id)
    if (!had || spot.rank < had.rank) best.set(spot.id, spot)
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank || (b.fame ?? 0) - (a.fame ?? 0) || a.distance - b.distance)
    .map(({ rank: _rank, ...s }) => s)
}

// ---------------------------------------------------------------------------------------------
// OpenStreetMap: relevant spots nearby.

interface Want { key: string; value: string; extra?: [string, string]; group: RelatedGroup; kind: string; named: boolean }

const NATURE: Want[] = [
  { key: 'highway', value: 'trailhead', group: 'trail', kind: 'Trailhead', named: false },
  { key: 'tourism', value: 'viewpoint', group: 'viewpoint', kind: 'Viewpoint', named: false },
  { key: 'information', value: 'visitor_centre', group: 'visitor', kind: 'Visitor centre', named: false },
  { key: 'tourism', value: 'information', extra: ['information', 'office'], group: 'visitor', kind: 'Visitor information', named: true },
  { key: 'amenity', value: 'ranger_station', group: 'visitor', kind: 'Ranger station', named: false },
  { key: 'tourism', value: 'alpine_hut', group: 'camp', kind: 'Mountain hut', named: false },
  { key: 'tourism', value: 'wilderness_hut', group: 'camp', kind: 'Wilderness hut', named: false },
  { key: 'tourism', value: 'camp_site', group: 'camp', kind: 'Campsite', named: true },
  { key: 'boundary', value: 'national_park', group: 'park', kind: 'National park', named: true },
  { key: 'boundary', value: 'protected_area', group: 'park', kind: 'Protected area', named: true },
  { key: 'leisure', value: 'nature_reserve', group: 'park', kind: 'Nature reserve', named: true },
  { key: 'natural', value: 'peak', group: 'mountain', kind: 'Peak', named: true },
  { key: 'natural', value: 'glacier', group: 'water', kind: 'Glacier', named: true },
]

const CITY: Want[] = [
  { key: 'tourism', value: 'attraction', group: 'landmark', kind: 'Attraction', named: true },
  { key: 'tourism', value: 'museum', group: 'museum', kind: 'Museum', named: true },
  { key: 'tourism', value: 'viewpoint', group: 'viewpoint', kind: 'Viewpoint', named: false },
  { key: 'information', value: 'office', group: 'visitor', kind: 'Visitor information', named: false },
  { key: 'historic', value: 'monument', group: 'landmark', kind: 'Monument', named: true },
  { key: 'leisure', value: 'park', group: 'park', kind: 'Park', named: true },
  { key: 'railway', value: 'station', group: 'transit', kind: 'Station', named: true },
]

export function wantsFor(kind: AnchorKind): Want[] {
  return kind === 'mountain' || kind === 'park' ? NATURE : CITY
}

const KEY = (k: string) => `<https://www.openstreetmap.org/wiki/Key:${k}>`

function boxAround([lng, lat]: LngLat, meters: number): [number, number, number, number] {
  const dLat = meters / 111_320
  const dLng = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat]
}

/** One SPARQL query for every wanted tag around a point. Exported for tests. */
export function osmQuery(wants: Want[], at: LngLat, meters: number): string {
  const [w, s, e, n] = boxAround(at, meters)
  const parts = wants.map((x, i) => `{ ?o ${KEY(x.key)} "${x.value}" .${x.extra ? ` ?o ${KEY(x.extra[0])} "${x.extra[1]}" .` : ''} BIND(${i} AS ?w) }`)
  return `PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT ?o (MIN(?w) AS ?want) (SAMPLE(?nm) AS ?name) (SAMPLE(?en) AS ?nameEn) (SAMPLE(?wkt) AS ?c) (SAMPLE(?wc) AS ?wheelchair) (SAMPLE(?wd) AS ?wikidata) WHERE {
  ${parts.join(' UNION\n  ')}
  ?o geo:hasGeometry/geo:asWKT ?g0 .
  BIND(geof:centroid(?g0) AS ?wkt)
  FILTER(geof:longitude(?wkt) >= ${w.toFixed(4)} && geof:longitude(?wkt) <= ${e.toFixed(4)} && geof:latitude(?wkt) >= ${s.toFixed(4)} && geof:latitude(?wkt) <= ${n.toFixed(4)})
  OPTIONAL { ?o ${KEY('name')} ?nm }
  OPTIONAL { ?o ${KEY('name:en')} ?en }
  OPTIONAL { ?o ${KEY('wheelchair')} ?wc }
  OPTIONAL { ?o ${KEY('wikidata')} ?wd }
}
GROUP BY ?o LIMIT 400`
}

export interface OsmHit { osm: string; want: number; name?: string; coords: LngLat; wheelchair?: string; wikidata?: string }

/** QLever OSM rows to hits. The object URI ends in /node/123, /way/123 or /relation/123. */
export function parseOsmRows(rows: Row[]): OsmHit[] {
  const out: OsmHit[] = []
  for (const r of rows) {
    const coords = parsePoint(r.c?.value)
    const m = r.o && /(node|way|relation)\/(\d+)$/.exec(r.o.value)
    if (!coords || !m) continue
    out.push({
      osm: `${m[1]}/${m[2]}`, want: Number(r.want?.value ?? 0), coords,
      name: r.nameEn?.value || r.name?.value, wheelchair: r.wheelchair?.value, wikidata: r.wikidata?.value,
    })
  }
  return out
}

export function overpassQuery(wants: Want[], at: LngLat, meters: number): string {
  const [w, s, e, n] = boxAround(at, meters)
  const bb = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`
  const sel = wants.map((x) => `nwr["${x.key}"="${x.value}"]${x.extra ? `["${x.extra[0]}"="${x.extra[1]}"]` : ''}(${bb});`).join('')
  return `[out:json][timeout:20];(${sel});out center tags 400;`
}

/** Overpass elements to hits, matching each to the first wanted tag it carries. */
export function parseOverpass(elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[], wants: Want[]): OsmHit[] {
  const out: OsmHit[] = []
  for (const el of elements) {
    const t = el.tags ?? {}
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon
    const want = wants.findIndex((x) => t[x.key] === x.value && (!x.extra || t[x.extra[0]] === x.extra[1]))
    if (lat == null || lon == null || want < 0) continue
    out.push({ osm: `${el.type}/${el.id}`, want, coords: [lon, lat], name: t['name:en'] || t.name, wheelchair: t.wheelchair, wikidata: t.wikidata })
  }
  return out
}

/**
 * Wanted spots in the districts, counties or towns (admin levels 5-8) that contain the place,
 * and inside the place's own outline (a park or city). Districts that only touch the outline
 * are left out: for a big city like Paris that's dozens of towns and the query times out.
 * QLever has these "contains" links worked out in advance, so this answers in a couple of
 * seconds, where a plain map-box search over all the world's peaks and parks can take 25 s.
 * Exported for tests.
 */
export function adminAreaQuery(osm: string, wants: Want[], [lng, lat]: LngLat): string {
  const parts = wants.map((x, i) => `{ ?o ${KEY(x.key)} "${x.value}" .${x.extra ? ` ?o ${KEY(x.extra[0])} "${x.extra[1]}" .` : ''} BIND(${i} AS ?w) }`)
  return `PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
PREFIX ogc: <http://www.opengis.net/rdf#>
SELECT ?o (MIN(?w) AS ?want) (SAMPLE(?nm) AS ?name) (SAMPLE(?en) AS ?nameEn) (SAMPLE(?wkt) AS ?c) (SAMPLE(?wc) AS ?wheelchair) (SAMPLE(?wd) AS ?wikidata) WHERE {
  { SELECT DISTINCT ?a WHERE {
    { ?a ogc:sfContains <https://www.openstreetmap.org/${osm}> .
      ?a ${KEY('boundary')} "administrative" . ?a ${KEY('admin_level')} ?lvl . FILTER(?lvl >= 5 && ?lvl <= 8) }${osm.startsWith('node/') ? '' : `
    UNION { VALUES ?a { <https://www.openstreetmap.org/${osm}> } }`}
  } }
  ?a ogc:sfContains ?o .
  ${parts.join(' UNION\n  ')}
  ?o geo:hasGeometry/geo:asWKT ?g0 .
  BIND(geof:centroid(?g0) AS ?wkt)
  OPTIONAL { ?o ${KEY('name')} ?nm }
  OPTIONAL { ?o ${KEY('name:en')} ?en }
  OPTIONAL { ?o ${KEY('wheelchair')} ?wc }
  OPTIONAL { ?o ${KEY('wikidata')} ?wd }
}
GROUP BY ?o ORDER BY ASC(geof:distance(?c, "POINT(${lng.toFixed(5)} ${lat.toFixed(5)})"^^geo:wktLiteral)) LIMIT 400`
}

async function osmHits(wants: Want[], at: LngLat, meters: number, signal?: AbortSignal, osm?: string): Promise<OsmHit[]> {
  // Fast path: the districts or towns around the place, then keep what's within reach.
  if (osm) {
    try {
      const hits = parseOsmRows(await sparql(QLEVER_OSM_URL, adminAreaQuery(osm, wants, at), signal, 10000))
        .filter((h) => distanceMeters(at, h.coords) <= meters)
      if (hits.length) return hits
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      // Fall through to the map-box search below.
    }
  }
  const race = new AbortController()
  const stop = () => race.abort()
  signal?.addEventListener('abort', stop)
  try {
    return await Promise.any([
      sparql(QLEVER_OSM_URL, osmQuery(wants, at, meters), race.signal, 25000).then(parseOsmRows),
      ...OVERPASS_URLS.slice(0, 2).map(async (url) => {
        const res = await fetchWithTimeout(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(wants, at, meters) }) }, 25000, race.signal)
        if (!res.ok) throw new Error(`Overpass ${res.status}`)
        const data = (await res.json()) as { elements?: [] }
        if (!data.elements) throw new Error('Overpass gave no data')
        return parseOverpass(data.elements, wants)
      }),
    ])
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw e instanceof AggregateError ? e.errors[0] : e
  } finally {
    race.abort()
    signal?.removeEventListener('abort', stop)
  }
}

const WC = (v: string | undefined): Wheelchair => (v === 'yes' || v === 'limited' || v === 'no' ? v : v === 'designated' ? 'yes' : 'unknown')

/** The words that make a name specific: "Nanda Devi National Park" → "nanda devi". */
export function coreName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(national park|national|park|wildlife sanctuary|sanctuary|biosphere reserve|reserve|mount|mountain|peak|state park|forest|city|of|the)\b/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** OSM hits to nearby spots with a reason each. Exported for tests. */
export function nearbySpots(hits: OsmHit[], wants: Want[], anchor: { name: string; coords: LngLat; kind: AnchorKind }): RelatedSpot[] {
  const core = coreName(anchor.name)
  const what = anchor.kind === 'park' ? 'park' : anchor.kind === 'mountain' ? 'mountain' : anchor.kind === 'city' ? 'city' : 'place'
  const out: RelatedSpot[] = []
  for (const h of hits) {
    const want = wants[h.want]
    if (!want) continue
    if (want.named && !h.name) continue
    const distance = distanceMeters(anchor.coords, h.coords)
    // A spot named after the selected place ("Nanda Devi Base Camp", "Yosemite Valley Visitor Center")
    // belongs to it; anything else is relevant because of what it is and where it is.
    const namedFor = core.length >= 3 && !!h.name && h.name.toLowerCase().includes(core)
    const serves = want.group === 'trail' || want.group === 'visitor' || want.group === 'camp' || want.group === 'viewpoint'
    const reason = !namedFor ? `Nearby ${want.kind.toLowerCase()}` : serves ? `${want.kind} for this ${what}` : `${want.kind} named after this ${what}`
    out.push({
      id: h.osm, osm: h.osm, name: h.name || want.kind, coords: h.coords, group: want.group, kind: want.kind,
      reason, direct: namedFor, distance, wheelchair: WC(h.wheelchair), wikidata: h.wikidata,
    })
  }
  return out
}

// Containment: OpenStreetMap areas (parks, reserves) that contain the place, and spots inside an
// area. QLever's copy of OSM has these "contains" links worked out in advance, so they are exact.

const OSM_PREFIX = `PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
PREFIX ogc: <http://www.opengis.net/rdf#>
`
const osmIri = (osm: string) => `<https://www.openstreetmap.org/${osm}>`

/** The OSM object that carries this Wikidata item, if any. Exported for tests. */
export function osmForWikidataQuery(q: string): string {
  return `SELECT ?o WHERE { ?o ${KEY('wikidata')} "${esc(q)}" } LIMIT 3`
}

const AREA_WANTS: Want[] = [
  { key: 'boundary', value: 'national_park', group: 'park', kind: 'National park', named: true },
  { key: 'boundary', value: 'protected_area', group: 'park', kind: 'Protected area', named: true },
  { key: 'leisure', value: 'nature_reserve', group: 'park', kind: 'Nature reserve', named: true },
  { key: 'leisure', value: 'park', group: 'park', kind: 'Park', named: true },
]

/** Parks and reserves whose area contains the OSM object. Exported for tests. */
export function containersQuery(osm: string): string {
  const parts = AREA_WANTS.map((x, i) => `{ ?o ${KEY(x.key)} "${x.value}" . BIND(${i} AS ?w) }`)
  return `${OSM_PREFIX}SELECT ?o (MIN(?w) AS ?want) (SAMPLE(?nm) AS ?name) (SAMPLE(?en) AS ?nameEn) (SAMPLE(?wkt) AS ?c) (SAMPLE(?wc) AS ?wheelchair) (SAMPLE(?wd) AS ?wikidata) WHERE {
  ?o ogc:sfContains ${osmIri(osm)} .
  ${parts.join(' UNION ')}
  ?o ${KEY('name')} ?nm .
  OPTIONAL { ?o ${KEY('name:en')} ?en }
  OPTIONAL { ?o ${KEY('wheelchair')} ?wc }
  OPTIONAL { ?o ${KEY('wikidata')} ?wd }
  ?o geo:hasGeometry/geo:asWKT ?g0 .
  BIND(geof:centroid(?g0) AS ?wkt)
}
GROUP BY ?o LIMIT 20`
}

/** Wanted spots inside any of the given OSM areas. Exported for tests. */
export function insideQuery(areas: string[], wants: Want[]): string {
  const parts = wants.map((x, i) => `{ ?o ${KEY(x.key)} "${x.value}" .${x.extra ? ` ?o ${KEY(x.extra[0])} "${x.extra[1]}" .` : ''} BIND(${i} AS ?w) }`)
  return `${OSM_PREFIX}SELECT ?o (SAMPLE(?a) AS ?area) (MIN(?w) AS ?want) (SAMPLE(?nm) AS ?name) (SAMPLE(?en) AS ?nameEn) (SAMPLE(?wkt) AS ?c) (SAMPLE(?wc) AS ?wheelchair) (SAMPLE(?wd) AS ?wikidata) WHERE {
  VALUES ?a { ${areas.map(osmIri).join(' ')} }
  ?a ogc:sfContains ?o .
  ${parts.join(' UNION\n  ')}
  ?o geo:hasGeometry/geo:asWKT ?g0 .
  BIND(geof:centroid(?g0) AS ?wkt)
  OPTIONAL { ?o ${KEY('name')} ?nm }
  OPTIONAL { ?o ${KEY('name:en')} ?en }
  OPTIONAL { ?o ${KEY('wheelchair')} ?wc }
  OPTIONAL { ?o ${KEY('wikidata')} ?wd }
}
GROUP BY ?o LIMIT 300`
}

/** Container rows to direct spots: "National park this mountain is in". Exported for tests. */
export function containerSpots(rows: Row[], anchor: { coords: LngLat; kind: AnchorKind }): RelatedSpot[] {
  const what = anchor.kind === 'other' ? 'place' : anchor.kind
  return parseOsmRows(rows).flatMap((h) => {
    const want = AREA_WANTS[h.want]
    if (!want || !h.name) return []
    return [{ id: h.osm, osm: h.osm, name: h.name, coords: h.coords, group: want.group, kind: want.kind,
      reason: `${want.kind} this ${what} is in`, direct: true, distance: distanceMeters(anchor.coords, h.coords),
      wheelchair: WC(h.wheelchair), wikidata: h.wikidata }]
  })
}

/** Spots inside the place itself ("Trailhead in this park") or inside the park around it ("In Nanda Devi National Park"). */
export function insideSpots(rows: Row[], wants: Want[], anchor: { coords: LngLat; kind: AnchorKind; osm?: string }, areaNames: Map<string, string>): RelatedSpot[] {
  const what = anchor.kind === 'other' ? 'area' : anchor.kind
  const out: RelatedSpot[] = []
  for (const r of rows) {
    const [h] = parseOsmRows([r])
    const area = /(node|way|relation)\/(\d+)$/.exec(r.area?.value ?? '')
    const want = h && wants[h.want]
    if (!h || !want || !area || (want.named && !h.name)) continue
    const areaId = `${area[1]}/${area[2]}`
    const reason = areaId === anchor.osm ? `${want.kind} in this ${what}` : `${want.kind} in ${areaNames.get(areaId) ?? 'the same park'}`
    out.push({ id: h.osm, osm: h.osm, name: h.name || want.kind, coords: h.coords, group: want.group, kind: want.kind,
      reason, direct: true, distance: distanceMeters(anchor.coords, h.coords), wheelchair: WC(h.wheelchair), wikidata: h.wikidata })
  }
  return out
}

// What to show first near each kind of place.
const GROUP_ORDER: Record<AnchorKind, RelatedGroup[]> = {
  mountain: ['park', 'trail', 'viewpoint', 'visitor', 'camp', 'mountain', 'water', 'landmark', 'museum', 'transit'],
  park: ['visitor', 'trail', 'viewpoint', 'camp', 'park', 'mountain', 'water', 'landmark', 'museum', 'transit'],
  city: ['landmark', 'museum', 'visitor', 'viewpoint', 'park', 'transit', 'trail', 'camp', 'mountain', 'water'],
  other: ['landmark', 'visitor', 'museum', 'viewpoint', 'park', 'trail', 'transit', 'camp', 'mountain', 'water'],
}
const PER_GROUP = 4
const MAX_DIRECT = 12
const MAX_SPOTS = 24

/**
 * Put it together: direct links first (parks around it, Wikidata links, spots inside), then nearby
 * spots named after the place, then other nearby spots in the order that suits the kind of place,
 * a few of each, nearest first. The same thing found twice (Wikidata and OSM, or a park drawn as
 * both boundary and reserve) is shown once, keeping the best reason and the OSM details.
 * `direct` must already be in priority order. Exported for tests.
 */
export function mergeSpots(direct: RelatedSpot[], nearby: RelatedSpot[], anchor: { name: string; coords: LngLat; kind: AnchorKind; wikidata?: string; osm?: string }): RelatedSpot[] {
  const isSelf = (s: RelatedSpot) => (anchor.wikidata && s.wikidata === anchor.wikidata) || (anchor.osm && s.osm === anchor.osm) ||
    (s.name.toLowerCase() === anchor.name.toLowerCase() && s.distance < 1500)
  const out: RelatedSpot[] = []
  const same = (a: RelatedSpot, b: RelatedSpot) => (a.wikidata && a.wikidata === b.wikidata) || (a.osm && a.osm === b.osm) ||
    (a.name !== a.kind && a.name.toLowerCase() === b.name.toLowerCase() && (a.group === b.group || distanceMeters(a.coords, b.coords) < 500))
  const perGroup = new Map<string, number>()
  const add = (s: RelatedSpot, limit: number, bucket: string) => {
    if (isSelf(s)) return
    const had = out.find((o) => same(o, s))
    if (had) {
      // Enrich what's already listed with the OpenStreetMap details.
      if (!had.osm && s.osm) had.osm = s.osm
      if (had.wheelchair === 'unknown') had.wheelchair = s.wheelchair
      if (!had.wikidata) had.wikidata = s.wikidata
      return
    }
    const k = `${bucket}|${s.group}`
    if ((perGroup.get(k) ?? 0) >= limit) return
    perGroup.set(k, (perGroup.get(k) ?? 0) + 1)
    out.push({ ...s })
  }
  for (const d of direct) add(d, 5, 'direct')
  out.splice(MAX_DIRECT)
  for (const s of nearby.filter((x) => x.direct).sort((a, b) => a.distance - b.distance)) add({ ...s }, 3, 'named')
  for (const g of GROUP_ORDER[anchor.kind]) {
    for (const s of nearby.filter((x) => !x.direct && x.group === g).sort((a, b) => a.distance - b.distance)) add(s, PER_GROUP, 'near')
  }
  return out.slice(0, MAX_SPOTS)
}

// ---------------------------------------------------------------------------------------------

async function osmTags(osm: string, signal?: AbortSignal): Promise<Record<string, string> | null> {
  try {
    const res = await fetchWithTimeout(`${OSM_API_URL}/${osm}.json`, {}, 8000, signal)
    if (!res.ok) return null
    const data = (await res.json()) as { elements?: { tags?: Record<string, string> }[] }
    return data.elements?.[0]?.tags ?? null
  } catch (e) {
    if (signal?.aborted) throw e
    return null
  }
}

const cache = new Map<string, RelatedResult>()

export function anchorKey(p: Place): string {
  return p.wikidata ?? p.osm ?? `${p.name}|${p.coords[0].toFixed(4)},${p.coords[1].toFixed(4)}`
}

/** Related spots for a selected place. Fails only when both Wikidata and OpenStreetMap are unreachable. */
export async function loadRelated(place: Place, signal?: AbortSignal): Promise<RelatedResult> {
  const key = anchorKey(place)
  const hit = cache.get(key)
  if (hit) return hit
  const keepAbort = (e: unknown) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); return e }

  // 1. Who is it? The OSM object's own tags give its Wikidata item and wheelchair access.
  let osm = place.osm
  const tags = osm ? await osmTags(osm, signal) : null
  let wikidata = place.wikidata ?? (tags?.wikidata && /^Q\d+$/.test(tags.wikidata) ? tags.wikidata : undefined)
  let wdFailed = false
  if (!wikidata && place.name && place.name !== 'Dropped pin') {
    try {
      const rows = await sparql(FAMOUS_URL, findItemQuery(place.name, place.coords), signal)
      // Best known item with exactly this name within ~30 km.
      wikidata = rows.map((r) => ({ q: qid(r.item?.value), c: parsePoint(r.c?.value) }))
        .find((r) => r.q && r.c && distanceMeters(r.c, place.coords) < 30_000)?.q
    } catch (e) { keepAbort(e); wdFailed = true }
  }
  // A famous place picked on the map has a Wikidata item but no OSM object yet: look it up.
  if (!osm && wikidata) {
    try {
      const rows = await sparql(QLEVER_OSM_URL, osmForWikidataQuery(wikidata), signal, 10000)
      const m = rows.map((r) => /(node|way|relation)\/(\d+)$/.exec(r.o?.value ?? '')).find(Boolean)
      if (m) osm = `${m[1]}/${m[2]}`
    } catch (e) { keepAbort(e) }
  }

  // 2. What kind of place? OSM tag first, then Wikidata classes, then the description.
  let kind: AnchorKind | null = kindFromOsmTag(place.osmTag) ??
    (tags ? kindFromOsmTag(Object.entries(tags).map(([k, v]) => `${k}=${v}`).find((t) => kindFromOsmTag(t))) : null)
  if (!kind && wikidata) {
    try {
      const roots = (await sparql(FAMOUS_URL, kindQuery(wikidata), signal, 12000)).map((r) => KIND_ROOTS[qid(r.root?.value)])
      kind = (['mountain', 'park', 'city'] as AnchorKind[]).find((k) => roots.includes(k)) ?? null
    } catch (e) { keepAbort(e) }
  }
  kind ??= kindFromText(`${place.detail} ${place.about ?? ''}`) ?? 'other'
  const anchor = { name: place.name, coords: place.coords, kind, wikidata, osm }
  const linksP = (async () => {
    if (!wikidata) return [] as Row[]
    try {
      const rows = await sparql(FAMOUS_URL, linksQuery(wikidata, kind === 'city'), signal)
      const ids = [...new Set(rows.map((r) => qid(r.r?.value)).filter(Boolean))]
      if (!ids.length) return rows
      const types = new Map((await sparql(FAMOUS_URL, typesQuery(ids), signal, 12000).catch(() => [] as Row[]))
        .map((r) => [qid(r.r?.value), r.type] as const))
      return rows.map((r) => ({ ...r, type: types.get(qid(r.r?.value)) }))
    } catch (e) { keepAbort(e); wdFailed = true; return [] as Row[] }
  })()

  // 3. Everything at once: Wikidata links, nearby OSM spots, the parks around it and what's inside.
  const radius = RADIUS_BY_KIND[kind]
  const wants = wantsFor(kind)
  let osmFailed = false
  const containersP = osm && kind !== 'city'
    ? sparql(QLEVER_OSM_URL, containersQuery(osm), signal, 15000).then((rows) => containerSpots(rows, anchor)).catch((e) => { keepAbort(e); return [] as RelatedSpot[] })
    : Promise.resolve([] as RelatedSpot[])
  const insideP = containersP.then(async (parks) => {
    // Inside the selected park itself, or inside the park around a peak.
    const areas = new Map<string, string>()
    if (osm && !osm.startsWith('node/') && kind === 'park') areas.set(osm, place.name)
    for (const p of parks.slice(0, 3)) if (p.osm && !p.osm.startsWith('node/')) areas.set(p.osm, p.name)
    if (!areas.size) return [] as RelatedSpot[]
    // Inside a park around a peak, the other peaks and glaciers are listed as nearby instead.
    const inWants = kind === 'park' ? wants : wants.filter((w) => w.group !== 'mountain' && w.group !== 'water' && w.group !== 'park')
    const rows = await sparql(QLEVER_OSM_URL, insideQuery([...areas.keys()], inWants), signal, 20000)
    return insideSpots(rows, inWants, anchor, areas)
  }).catch((e) => { keepAbort(e); return [] as RelatedSpot[] })
  const [linkRows, hits, parks, inside] = await Promise.all([
    linksP,
    osmHits(wants, place.coords, radius, signal, osm).catch((e) => { keepAbort(e); osmFailed = true; return [] as OsmHit[] }),
    containersP,
    insideP,
  ])
  if (osmFailed && (wdFailed || !wikidata) && !parks.length) throw new Error('Related places could not be loaded')
  const links = parseLinks(linkRows, place.coords, kind)
  const spots = mergeSpots([...parks, ...links, ...inside], nearbySpots(hits, wants, anchor), anchor)
  const result: RelatedResult = { kind, radius, spots, wikidata, wheelchair: WC(tags?.wheelchair), partial: osmFailed || wdFailed }
  if (!result.partial) cache.set(key, result)
  return result
}

/** A related spot as a Place, to select it, route to it or save it. */
export function spotPlace(s: RelatedSpot): Place {
  return { name: s.name, detail: s.kind, coords: s.coords, icon: GROUP_LOOK[s.group].icon, osm: s.osm, wikidata: s.wikidata }
}
