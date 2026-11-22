import { fetchWithTimeout } from './places'
import type { LngLat } from './types'

// Well-known places (national parks, landmarks, museums, waterfalls, capitals…) from Wikidata,
// shown when you look at a country or region. How well known a place is comes from how many
// Wikipedia languages write about it, so zoomed out you see only the famous ones.
// QLever is a free, fast Wikidata mirror that answers map-box questions in a second or two.

export const FAMOUS_URL = 'https://qlever.cs.uni-freiburg.de/api/wikidata'
export const FAMOUS_MIN_ZOOM = 3
export const FAMOUS_MAX_ZOOM = 14

export interface FamousPlace {
  id: string
  name: string
  coords: LngLat
  kind: string
  icon: string
  about?: string
  photo?: string
  wiki?: string
  /** Number of Wikipedia languages with an article: our measure of fame. */
  fame: number
}

type BBox = [number, number, number, number] // west, south, east, north

export const FAMOUS_KINDS: Record<string, { label: string; icon: string }> = {
  Q5119: { label: 'Capital city', icon: '🏙️' },
  Q570116: { label: 'Tourist attraction', icon: '📸' },
  Q46169: { label: 'National park', icon: '🌳' },
  Q473972: { label: 'Protected area', icon: '🌿' },
  Q33506: { label: 'Museum', icon: '🏛️' },
  Q34038: { label: 'Waterfall', icon: '💧' },
  Q8072: { label: 'Volcano', icon: '🌋' },
  Q8502: { label: 'Mountain', icon: '⛰️' },
  Q23413: { label: 'Castle', icon: '🏰' },
  Q16560: { label: 'Palace', icon: '👑' },
  Q839954: { label: 'Archaeological site', icon: '🏺' },
  Q2319498: { label: 'Landmark', icon: '📍' },
  Q4989906: { label: 'Monument', icon: '🗿' },
  Q2977: { label: 'Cathedral', icon: '⛪' },
  Q32815: { label: 'Mosque', icon: '🕌' },
  Q44539: { label: 'Temple', icon: '🛕' },
  Q43501: { label: 'Zoo', icon: '🦁' },
  Q40080: { label: 'Beach', icon: '🏖️' },
  Q12518: { label: 'Tower', icon: '🗼' },
  Q12280: { label: 'Bridge', icon: '🌉' },
  Q174782: { label: 'Square', icon: '⛲' },
  Q1107656: { label: 'Garden', icon: '🌷' },
  Q9259: { label: 'World Heritage Site', icon: '🌍' },
}

/** How famous a place must be to show at this zoom (Wikipedia languages). */
export function fameFor(zoom: number): number {
  if (zoom < 5) return 60
  if (zoom < 7) return 30
  if (zoom < 9) return 15
  if (zoom < 11) return 8
  return 4
}

/** Snap a view outward to a grid that fits the zoom, so small pans reuse the same answer. */
export function snapBox([w, s, e, n]: BBox, zoom: number): BBox {
  const step = zoom < 5 ? 20 : zoom < 7 ? 5 : zoom < 9 ? 2 : zoom < 11 ? 0.5 : 0.1
  const f = (v: number, up: boolean) => Math.round((up ? Math.ceil(v / step) : Math.floor(v / step)) * step * 1000) / 1000
  return [Math.max(-180, f(w, false)), Math.max(-85, f(s, false)), Math.min(180, f(e, true)), Math.min(85, f(n, true))]
}

export function famousQuery([w, s, e, n]: BBox, fame: number, limit = 60): string {
  const types = Object.keys(FAMOUS_KINDS).map((q) => `wd:${q}`).join(' ')
  return `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT ?item (SAMPLE(?label) AS ?name) (SAMPLE(?coord) AS ?c) (SAMPLE(?type) AS ?t) (SAMPLE(?img) AS ?photo) (SAMPLE(?desc) AS ?about) (SAMPLE(?article) AS ?wiki) (MAX(?sl) AS ?fame) WHERE {
  VALUES ?type { ${types} }
  ?item wdt:P31 ?type .
  ?item wikibase:sitelinks ?sl .
  FILTER(?sl >= ${fame})
  ?item wdt:P625 ?coord .
  FILTER(geof:longitude(?coord) >= ${w} && geof:longitude(?coord) <= ${e} && geof:latitude(?coord) >= ${s} && geof:latitude(?coord) <= ${n})
  ?item rdfs:label ?label . FILTER(LANG(?label) = "en")
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}
GROUP BY ?item ORDER BY DESC(?fame) LIMIT ${limit}`
}

type Cell = { value: string } | undefined
type Row = Record<'item' | 'name' | 'c' | 't' | 'photo' | 'about' | 'wiki' | 'fame', Cell>

/** "Point(lon lat)" to coordinates. */
function parsePoint(wkt: string): LngLat | null {
  const m = /point\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(wkt)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** A small, fast thumbnail of a Wikimedia Commons file. */
export function thumb(url: string, width = 480): string {
  return `${url.replace(/^http:/, 'https:')}?width=${width}`
}

export function parseFamous(rows: Row[]): FamousPlace[] {
  const out: FamousPlace[] = []
  for (const r of rows) {
    const coords = r.c && parsePoint(r.c.value)
    if (!coords || !r.item || !r.name) continue
    const qid = r.t?.value.split('/').pop() ?? ''
    const kind = FAMOUS_KINDS[qid] ?? { label: 'Landmark', icon: '📍' }
    out.push({
      id: r.item.value.split('/').pop()!,
      name: r.name.value,
      coords,
      kind: kind.label,
      icon: kind.icon,
      about: r.about?.value,
      photo: r.photo ? thumb(r.photo.value) : undefined,
      wiki: r.wiki?.value.replace(/^http:/, 'https:'),
      fame: Number(r.fame?.value ?? 0),
    })
  }
  return out
}

const cache = new Map<string, FamousPlace[]>()

/** Famous places in the view, best known first. */
export async function loadFamous(view: BBox, zoom: number, signal?: AbortSignal): Promise<FamousPlace[]> {
  const box = snapBox(view, zoom)
  const fame = fameFor(zoom)
  const key = `${box.join(',')}|${fame}`
  const hit = cache.get(key)
  if (hit) return hit
  const res = await fetchWithTimeout(FAMOUS_URL, {
    method: 'POST',
    headers: { Accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query: famousQuery(box, fame) }),
  }, 20000, signal)
  if (!res.ok) throw new Error(`Famous places failed to load (${res.status})`)
  const data = (await res.json()) as { results?: { bindings?: Row[] } }
  const found = parseFamous(data.results?.bindings ?? [])
  cache.set(key, found)
  return found
}
