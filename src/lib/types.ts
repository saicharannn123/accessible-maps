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

export interface RouteResult {
  geometry: LngLat[]
  distanceMeters: number
  durationSeconds: number
  stepFreeVerified: boolean
  warnings: RouteWarning[]
}

export interface Settings {
  profile: MobilityProfile
  maxInclinePercent: number
  /** Whose view of country borders to show: 'auto' (from your region), 'osm' (as on the ground) or a country code. */
  worldview: import('./worldview').WorldviewSetting
  /** Base map look. Renamed from mapStyle so everyone moves to the new Clean default once. */
  mapLook: import('../config').MapStyleId
  /** Travel mode for directions, remembered between visits. */
  travelMode: TravelMode
  /** Distance units: 'auto' picks miles in the US and UK, kilometers elsewhere. */
  units: 'auto' | import('./geo').DistanceUnits
}
