// Place names that depend on who is looking, the way Google Maps and Apple Maps label them.
// OpenStreetMap keeps one name per place; these rules swap in the name a country officially uses.
// To add one: list the names the map data may carry (`match`), what each country sees (`names`),
// and what everyone else sees (`otherwise`).

export interface PlaceRename {
  /** Names the map data may carry for this place (in any name field). */
  match: string[]
  /** Country code -> name shown to that country's view. */
  names: Record<string, string>
  /** Name for every other view. */
  otherwise: string
}

export const PLACE_RENAMES: PlaceRename[] = [
  {
    // Renamed by US executive order in 2025. Google: "Gulf of America" in the US,
    // "Gulf of Mexico" in Mexico, both names elsewhere. Apple does the same.
    match: ['Gulf of Mexico', 'Golfo de México', 'Golfo de Mexico', 'Gulf of America'],
    names: { US: 'Gulf of America', MX: 'Gulf of Mexico' },
    otherwise: 'Gulf of Mexico (Gulf of America)',
  },
  {
    // Renamed by the same 2025 order; the national park keeps the name Denali.
    match: ['Denali', 'Mount McKinley'],
    names: { US: 'Mount McKinley' },
    otherwise: 'Denali',
  },
  {
    // The country's own English name since 2022, used by the UN, Google and Apple.
    match: ['Turkey', 'Türkiye'],
    names: {},
    otherwise: 'Türkiye',
  },
]

/** The name a country's view shows for a place, or null to keep the map's own name. Exported for tests. */
export function nameFor(name: string, country: string | null): string | null {
  const r = PLACE_RENAMES.find((x) => x.match.includes(name))
  if (!r) return null
  return (country && r.names[country]) || r.otherwise
}

const NAME_FIELDS = ['name', 'name_en', 'name:en', 'name:latin']

/** Wrap a label's text expression so renamed places show the name for this view. */
export function renameExpression(original: unknown, country: string | null): unknown {
  const cases: unknown[] = []
  for (const r of PLACE_RENAMES) {
    const shown = (country && r.names[country]) || r.otherwise
    cases.push(
      ['any', ...NAME_FIELDS.map((f) => ['in', ['coalesce', ['get', f], ''], ['literal', r.match]])],
      shown,
    )
  }
  return ['case', ...cases, original]
}
