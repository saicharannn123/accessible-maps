export type LngLat = [number, number]

export type MobilityProfile = 'wheelchair' | 'stroller' | 'cane' | 'night'

export const PROFILE_LABELS: Record<MobilityProfile, string> = {
  wheelchair: 'Wheelchair',
  stroller: 'Stroller',
  cane: 'Cane or walker',
  night: 'Night walking',
}

export interface Place {
  name: string
  detail: string
  coords: LngLat
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
}
