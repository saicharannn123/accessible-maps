import { ORS_KEY, ORS_URL, OSRM_URLS } from '../config'
import { distanceToLine, formatDistance } from './geo'
import type { AccessData } from './overpass'
import { REPORT_LABELS } from './types'
import type { LngLat, Report, RouteResult, RouteStep, RouteWarning, Settings, TravelMode } from './types'
import { timeAgo } from './reports'

interface BaseRoute {
  geometry: LngLat[]
  distanceMeters: number
  durationSeconds: number
  stepFreeVerified: boolean
  steps: RouteStep[]
}

/** ORS accepts only these incline limits for the wheelchair profile. */
function orsIncline(percent: number): number {
  return [3, 6, 10, 15].find((v) => percent <= v) ?? 15
}

/** Build the OpenRouteService request for a mobility profile. Exported for tests. */
export function orsRequest(coordinates: LngLat[], settings: Settings) {
  switch (settings.profile) {
    case 'wheelchair':
      return {
        profile: 'wheelchair',
        body: {
          coordinates,
          options: {
            profile_params: {
              restrictions: {
                maximum_incline: orsIncline(settings.maxInclinePercent),
                maximum_sloped_kerb: 0.03,
                smoothness_type: 'good',
              },
            },
          },
        },
      }
    case 'stroller':
      return {
        profile: 'wheelchair',
        body: {
          coordinates,
          options: {
            profile_params: {
              restrictions: {
                maximum_incline: orsIncline(Math.max(settings.maxInclinePercent, 10)),
                maximum_sloped_kerb: 0.06,
              },
            },
          },
        },
      }
    case 'cane':
    case 'night':
      return {
        profile: 'foot-walking',
        body: { coordinates, options: { avoid_features: ['steps'] } },
      }
  }
}

async function routeWithOrs(points: LngLat[], settings: Settings, key: string): Promise<BaseRoute> {
  const { profile, body } = orsRequest(points, settings)
  const res = await fetch(`${ORS_URL}/${profile}/geojson`, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) {
      throw new Error('No step-free route found between these points. Try a nearby start or end.')
    }
    throw new Error(`Routing failed (${res.status})`)
  }
  const data = await res.json()
  const f = data.features[0]
  return {
    steps: orsSteps(f.properties.segments ?? [], f.geometry.coordinates),
    geometry: f.geometry.coordinates,
    distanceMeters: f.properties.summary.distance,
    durationSeconds: f.properties.summary.duration,
    // Wheelchair profiles avoid steps and high curbs; foot profiles here avoid steps.
    stepFreeVerified: true,
  }
}

/** Average speeds for on-foot modes; OSRM's foot profile assumes a brisk walk. */
const WALK_SPEED = 1.3 // m/s, about 4.7 km/h
const ACCESSIBLE_SPEED = 1.0 // m/s, a relaxed pace of about 3.6 km/h

/** Build the free OSRM request URL for a mode. Exported for tests. */
export function osrmUrl(mode: TravelMode, points: LngLat[]): string {
  const base = mode === 'car' ? OSRM_URLS.car : mode === 'bike' ? OSRM_URLS.bike : OSRM_URLS.foot
  const coords = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';')
  return `${base}/${coords}?overview=full&geometries=geojson&steps=true`
}

async function routeWithOsrm(mode: TravelMode, points: LngLat[]): Promise<BaseRoute> {
  const res = await fetch(osrmUrl(mode, points))
  if (!res.ok) throw new Error(res.status === 429 ? 'The free route server is busy. Try again in a moment.' : `Routing failed (${res.status})`)
  const data = await res.json()
  const what = mode === 'car' ? 'driving' : mode === 'bike' ? 'cycling' : 'walking'
  if (!data.routes?.length) throw new Error(`No ${what} route found between these points.`)
  const r = data.routes[0]
  const walking = mode === 'walk' || mode === 'accessible'
  return {
    steps: osrmSteps(r.legs ?? []),
    geometry: r.geometry.coordinates,
    distanceMeters: r.distance,
    durationSeconds: walking ? r.distance / (mode === 'walk' ? WALK_SPEED : ACCESSIBLE_SPEED) : r.duration,
    stepFreeVerified: false,
  }
}

interface OsrmStep {
  distance: number
  name?: string
  ref?: string
  destinations?: string
  maneuver: { type: string; modifier?: string; location: LngLat; exit?: number }
}

const ARROWS: Record<string, string> = {
  uturn: '↶', 'sharp right': '↱', right: '↱', 'slight right': '↗', straight: '↑',
  'slight left': '↖', left: '↰', 'sharp left': '↰',
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`

/** Turn OSRM legs into plain-English steps. Exported for tests. */
export function osrmSteps(legs: { steps?: OsrmStep[] }[]): RouteStep[] {
  const out: RouteStep[] = []
  legs.forEach((leg, li) => {
    for (const s of leg.steps ?? []) {
      const { type, modifier, location, exit } = s.maneuver
      const road = s.name || s.ref || ''
      const onto = road ? ` onto ${road}` : ''
      const on = road ? ` on ${road}` : ''
      const dir = modifier && modifier !== 'straight' ? modifier : null
      let text: string
      if (type === 'depart') text = `Head out${on}`
      else if (type === 'arrive') {
        // A multi-stop trip has one leg per stop; only the last one is the destination.
        if (li < legs.length - 1) text = `Arrive at stop ${li + 1}`
        else text = 'Arrive at your destination'
      } else if (type === 'roundabout' || type === 'rotary') text = `At the roundabout, take the ${exit ? ordinal(exit) + ' ' : ''}exit${onto}`
      else if (type === 'exit roundabout' || type === 'exit rotary') text = `Leave the roundabout${onto}`
      else if (modifier === 'uturn') text = `Make a U-turn${on}`
      else if (type === 'continue' || type === 'new name' || (!dir && type !== 'fork' && type !== 'merge')) {
        // Skip "the street changes its name" steps that would just repeat themselves.
        if (type === 'new name' && out.length && out[out.length - 1].text.endsWith(road)) { out[out.length - 1].distanceMeters += s.distance; continue }
        text = `Continue${onto || on}`
      } else if (type === 'fork') text = `Keep ${dir?.includes('left') ? 'left' : 'right'} at the fork${onto}`
      else if (type === 'merge') text = `Merge${dir ? ' ' + dir.replace('slight ', '') : ''}${onto}`
      else if (type === 'on ramp') text = `Take the ramp${dir ? ' on the ' + dir.replace(/^(slight|sharp) /, '') : ''}${s.destinations ? ' toward ' + s.destinations : ''}`
      else if (type === 'off ramp') text = `Take the exit${dir ? ' on the ' + dir.replace(/^(slight|sharp) /, '') : ''}${s.destinations ? ' toward ' + s.destinations : onto}`
      else if (type === 'end of road') text = `At the end of the road, turn ${dir?.includes('left') ? 'left' : 'right'}${onto}`
      else text = `${dir?.startsWith('slight') ? 'Bear' : 'Turn'} ${dir?.replace(/^(slight|sharp) /, '')}${onto}`
      const icon = type === 'depart' ? '●' : type === 'arrive' ? '⚑' : type.includes('roundabout') || type.includes('rotary') ? '⟳' : ARROWS[modifier ?? 'straight'] ?? '↑'
      out.push({ text, distanceMeters: s.distance, coords: location, icon })
    }
  })
  return out
}

/** OpenRouteService segments carry ready-made instructions; we only add places and arrows. */
export function orsSteps(
  segments: { steps?: { instruction: string; distance: number; type: number; way_points: [number, number] }[] }[],
  line: LngLat[],
): RouteStep[] {
  // ORS step types: 0 left, 1 right, 2 sharp left, 3 sharp right, 4 slight left, 5 slight right,
  // 6 straight, 7 roundabout, 8 exit roundabout, 9 U-turn, 10 goal, 11 depart, 12 keep left, 13 keep right.
  const icons = ['↰', '↱', '↰', '↱', '↖', '↗', '↑', '⟳', '⟳', '↶', '⚑', '●', '↖', '↗']
  return segments.flatMap((seg) => (seg.steps ?? []).map((s) => ({
    text: s.instruction,
    distanceMeters: s.distance,
    coords: line[s.way_points[0]] ?? line[0],
    icon: icons[s.type] ?? '↑',
  })))
}

/** Check a route against map obstacles, lighting and user reports. Exported for tests. */
export function findWarnings(
  route: Omit<BaseRoute, 'steps'>,
  settings: Settings,
  access: AccessData | null,
  reports: Report[],
  now = Date.now(),
): RouteWarning[] {
  const warnings: RouteWarning[] = []
  const line = route.geometry
  // Steps, curbs and sidewalk reports only matter on foot; plain walking just isn't promised step-free.
  const mode = settings.travelMode
  if (mode === 'car' || mode === 'bike') return warnings
  const accessible = mode === 'accessible'

  if (accessible && !route.stepFreeVerified && settings.profile !== 'night') {
    warnings.push({
      kind: 'not-verified',
      message:
        'This route uses plain walking directions, so it is not guaranteed step-free. Add a free OpenRouteService key for true step-free routing.',
    })
  }

  if (access) {
    for (const o of access.obstacles) {
      if (o.kind === 'elevator') continue
      const d = o.line ? Math.min(...o.line.map((p) => distanceToLine(p, line))) : distanceToLine(o.coords, line)
      if (d <= 8) {
        warnings.push({
          kind: 'steps',
          message: o.kind === 'steps' ? 'Steps on or next to the route' : 'Raised curb with no curb cut',
          coords: o.coords,
        })
      }
    }

    if (accessible && settings.profile === 'night') {
      let unlitMeters = 0
      let firstUnlit: LngLat | undefined
      for (const w of access.lighting) {
        if (w.lit) continue
        const near = w.line.filter((p) => distanceToLine(p, line) <= 10)
        if (near.length >= 2) {
          firstUnlit ??= near[0]
          unlitMeters += 20 * (near.length - 1)
        }
      }
      if (firstUnlit) {
        warnings.push({
          kind: 'unlit',
          message: `About ${formatDistance(unlitMeters)} of this route is on streets mapped as unlit`,
          coords: firstUnlit,
        })
      }
    }
  }

  for (const r of reports) {
    if (distanceToLine(r.coords, line) <= 30) {
      warnings.push({
        kind: 'report',
        message: `${REPORT_LABELS[r.type]} reported ${timeAgo(r.createdAt, now)}${r.note ? `: "${r.note}"` : ''}`,
        coords: r.coords,
      })
    }
  }
  return warnings
}

/** Plan a trip through all points in order: start, any stops, destination. */
export async function planRoute(
  points: LngLat[],
  settings: Settings,
  loadAccess: (route: LngLat[]) => Promise<AccessData | null>,
  reports: Report[],
): Promise<RouteResult> {
  const mode = settings.travelMode
  const base = mode === 'accessible' && ORS_KEY
    ? await routeWithOrs(points, settings, ORS_KEY)
    : await routeWithOsrm(mode, points)
  const onFoot = mode === 'walk' || mode === 'accessible'
  const access = onFoot ? await loadAccess(base.geometry).catch(() => null) : null
  return { ...base, warnings: findWarnings(base, settings, access, reports) }
}
