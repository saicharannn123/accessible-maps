export type LngLat = [number, number]

export type MobilityProfile = 'wheelchair' | 'stroller' | 'cane' | 'night'

export const PROFILE_LABELS: Record<MobilityProfile, string> = {
  wheelchair: 'Wheelchair',
  stroller: 'Stroller',
  cane: 'Cane or walker',
  night: 'Night walking',
}

/** How you're getting there. "accessible" uses the mobility profile (step-free where possible). */
export type TravelMode = 'walk' | 'accessible' | 'bike' | 'car'

export const TRAVEL_MODES: Record<TravelMode, { label: string; icon: string }> = {
  car: { label: 'Drive', icon: '🚗' },
  walk: { label: 'Walk', icon: '🚶' },
  accessible: { label: 'Step-free', icon: '♿' },
  bike: { label: 'Bike', icon: '🚲' },
}

export interface Place {
  name: string
  detail: string
  coords: LngLat
  /** Emoji for the kind of place, shown in search results. */
  icon?: string
  /** Far from you (shown under "Farther away"). */
  far?: boolean
  /** Well-known places: a photo, a one-line description and a Wikipedia link. */
  photo?: string
  about?: string
  wiki?: string
  /** OpenStreetMap object, e.g. "node/123" or "relation/456". */
  osm?: string
  /** Main OSM tag, e.g. "natural=peak", used to tell what kind of place this is. */
  osmTag?: string
  /** Wikidata item, e.g. "Q123", for places that have one. */
  wikidata?: string
  /** Postal code from the address provider (ZIP code, PIN code...), when it has one. */
  postcode?: string
  /** Two-letter country code, e.g. "US" or "IN". */
  country?: string
  /** Town, state and postal code, e.g. "Livingston, NJ 07039" (no distance). */
  area?: string
  /** House number and street, e.g. "276 Mill Road". */
  street?: string
  /** County or district, used to tell apart places that otherwise read the same. */
  county?: string
}

export type ReportType =
  | 'broken-elevator'
  | 'blocked-sidewalk'
  | 'missing-curb-cut'
  | 'restroom-closed'
  | 'other'

export const REPORT_LABELS: Record<ReportType, string> = {
  'broken-elevator': 'Broken elevator',
  'blocked-sidewalk': 'Blocked sidewalk',
  'missing-curb-cut': 'Missing curb cut',
  'restroom-closed': 'Restroom closed',
  other: 'Other problem',
}

export interface Report {
  id: string
  type: ReportType
  note: string
  coords: LngLat
  createdAt: number
}

export interface RouteWarning {
  kind: 'steps' | 'report' | 'unlit' | 'not-verified'
  message: string
  coords?: LngLat
}

/** One turn-by-turn instruction. */
export interface RouteStep {
  text: string
  /** Distance to walk or drive after this instruction, before the next one. */
  distanceMeters: number
  coords: LngLat
  /** A small arrow for the kind of turn. */
  icon: string
}

export interface RouteResult {
  geometry: LngLat[]
  distanceMeters: number
  durationSeconds: number
  stepFreeVerified: boolean
  warnings: RouteWarning[]
  steps: RouteStep[]
}

export interface Settings {
  profile: MobilityProfile
  maxInclinePercent: number
  /** Whose view of country borders to show: 'auto' (from your region), 'osm' (as on the ground) or a country code. */
  worldview: import('./worldview').WorldviewSetting
  /** Base map look. Renamed from mapStyle so everyone moves to the new Clean default once. */
  mapLook: import('../config').MapStyleId
  /** Set once the visitor chooses a map look themselves. */
  lookPicked?: boolean
  /** Travel mode for directions, remembered between visits. */
  travelMode: TravelMode
  /** Distance units: 'auto' picks miles in the US and UK, kilometers elsewhere. */
  units: 'auto' | import('./geo').DistanceUnits
  /** How your own position is drawn: dot, arrow, walker… */
  marker?: import('./marker').MarkerStyle
}
