// Country borders "as seen from" a country, the way Google Maps and Apple Maps show
// different borders to people in different countries (their "worldview").
//
// OpenStreetMap draws borders where they are on the ground (de facto). Natural Earth, a free
// public-domain map dataset, also records how ~30 countries officially see each border line:
// for every line, FCLASS_<code> says whether that country treats it as an international
// border, a disputed line, or doesn't recognise it at all.

export type WorldviewSetting = 'auto' | 'osm' | WorldviewCode

export const WORLDVIEWS = {
  IN: 'India', PK: 'Pakistan', CN: 'China', TW: 'Taiwan', NP: 'Nepal', BD: 'Bangladesh',
  US: 'United States', GB: 'United Kingdom', FR: 'France', DE: 'Germany', ES: 'Spain', IT: 'Italy',
  NL: 'Netherlands', PT: 'Portugal', SE: 'Sweden', PL: 'Poland', GR: 'Greece', TR: 'Türkiye',
  RU: 'Russia', UA: 'Ukraine', IL: 'Israel', PS: 'Palestine', SA: 'Saudi Arabia', EG: 'Egypt',
  MA: 'Morocco', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', JP: 'Japan', KO: 'South Korea', VN: 'Vietnam', ID: 'Indonesia',
} as const
export type WorldviewCode = keyof typeof WORLDVIEWS

// Pinned to a release so the lines don't change under us. Served free by the jsDelivr CDN.
export const NE_BORDERS_URL =
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_admin_0_boundary_lines_land.geojson'

const TIMEZONE_COUNTRY: Record<string, WorldviewCode> = {
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Karachi': 'PK', 'Asia/Shanghai': 'CN',
  'Asia/Urumqi': 'CN', 'Asia/Taipei': 'TW', 'Asia/Kathmandu': 'NP', 'Asia/Katmandu': 'NP', 'Asia/Dhaka': 'BD',
  'Africa/Casablanca': 'MA', 'Africa/Cairo': 'EG', 'Asia/Riyadh': 'SA', 'Asia/Jerusalem': 'IL',
  'Asia/Gaza': 'PS', 'Asia/Hebron': 'PS', 'Europe/Istanbul': 'TR', 'Europe/Athens': 'GR', 'Europe/Moscow': 'RU',
  'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA', 'America/Argentina/Buenos_Aires': 'AR', 'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KO', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Saigon': 'VN',
}

// The US and Mexico draw borders as on the ground, but name some places differently (see placeNames.ts).
const NAME_TIMEZONE_PREFIX: [RegExp, WorldviewCode][] = [
  [/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Nome|Adak|Boise|Detroit|Indiana\/.*|Kentucky\/.*|North_Dakota\/.*|Menominee|Metlakatla|Yakutat)$/, 'US'],
  [/^Pacific\/Honolulu$/, 'US'],
  [/^America\/(Mexico_City|Cancun|Merida|Monterrey|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Mazatlan|Bahia_Banderas|Hermosillo|Tijuana)$/, 'MX'],
]

/** Which country's place names to show automatically: the border view, or the US / Mexico. */
export function detectNameView(timeZone?: string, languages: readonly string[] = []): WorldviewCode | null {
  const border = detectWorldview(timeZone, languages)
  if (border) return border
  for (const [re, code] of NAME_TIMEZONE_PREFIX) if (timeZone && re.test(timeZone)) return code
  // Many browsers everywhere say en-US, so only trust the language when there's no time zone.
  if (timeZone) return null
  for (const lang of languages) {
    const region = lang.split('-')[1]?.toUpperCase()
    if (region === 'US' || region === 'MX') return region
  }
  return null
}

export function browserNameView(): WorldviewCode | null {
  try {
    return detectNameView(Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages ?? [navigator.language])
  } catch {
    return null
  }
}

/**
 * Which country's borders to show automatically. Only countries whose official borders differ
 * from what's on the ground somewhere get their own view; everyone else sees OpenStreetMap's.
 */
export function detectWorldview(timeZone?: string, languages: readonly string[] = []): WorldviewCode | null {
  if (timeZone && TIMEZONE_COUNTRY[timeZone]) return TIMEZONE_COUNTRY[timeZone]
  for (const lang of languages) {
    const region = lang.split('-')[1]?.toUpperCase()
    const code = region === 'KR' ? 'KO' : region
    if (code && Object.values(TIMEZONE_COUNTRY).includes(code as WorldviewCode)) return code as WorldviewCode
  }
  return null
}

export function browserWorldview(): WorldviewCode | null {
  try {
    return detectWorldview(Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages ?? [navigator.language])
  } catch {
    return null
  }
}

/** The border class this country gives a line, falling back to the line's general class. */
function lineClass(code: WorldviewCode): unknown[] {
  return ['coalesce', ['get', `FCLASS_${code}`], ['get', 'FEATURECLA']]
}

/** MapLibre filter for lines the country treats as settled international borders. */
export function solidFilter(code: WorldviewCode): unknown[] {
  return ['==', ['slice', lineClass(code), 0, 13], 'International']
}

/** MapLibre filter for lines the country shows as disputed, undefined or a line of control. */
export function dashedFilter(code: WorldviewCode): unknown[] {
  return ['any',
    ['==', ['slice', lineClass(code), 0, 8], 'Disputed'],
    ['==', ['slice', lineClass(code), 0, 10], 'Indefinite'],
    ['==', ['slice', lineClass(code), 0, 13], 'Indeterminant'],
    ['==', ['slice', lineClass(code), 0, 15], 'Line of control'],
  ]
}
