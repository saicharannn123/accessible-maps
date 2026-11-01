import { FALLBACK_FOOT_ROUTER_URL, ORS_KEY, ORS_URL } from '../config'
import { distanceToLine, formatDistance } from './geo'
import type { AccessData } from './overpass'
import { REPORT_LABELS } from './types'
import type { LngLat, Report, RouteResult, RouteWarning, Settings } from './types'
import { timeAgo } from './reports'

interface BaseRoute {
  geometry: LngLat[]
  distanceMeters: number
  durationSeconds: number
  stepFreeVerified: boolean
}

/** ORS accepts only these incline limits for the wheelchair profile. */
function orsIncline(percent: number): number {
  return [3, 6, 10, 15].find((v) => percent <= v) ?? 15
}

/** Build the OpenRouteService request for a mobility profile. Exported for tests. */
export function orsRequest(from: LngLat, to: LngLat, settings: Settings) {
  const coordinates = [from, to]
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

async function routeWithOrs(from: LngLat, to: LngLat, settings: Settings, key: string): Promise<BaseRoute> {
  const { profile, body } = orsRequest(from, to, settings)
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
    geometry: f.geometry.coordinates,
    distanceMeters: f.properties.summary.distance,
    durationSeconds: f.properties.summary.duration,
    // Wheelchair profiles avoid steps and high curbs; foot profiles here avoid steps.
    stepFreeVerified: true,
  }
}

async function routeWithFallback(from: LngLat, to: LngLat): Promise<BaseRoute> {
  const url = `${FALLBACK_FOOT_ROUTER_URL}/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Routing failed (${res.status})`)
  const data = await res.json()
  if (!data.routes?.length) throw new Error('No walking route found between these points.')
  const r = data.routes[0]
  return {
    geometry: r.geometry.coordinates,
    distanceMeters: r.distance,
    // OSRM foot speeds assume brisk walking; slow it to a relaxed, accessible pace (~3.6 km/h).
    durationSeconds: r.distance / 1.0,
    stepFreeVerified: false,
  }
}

/** Check a route against map obstacles, lighting and user reports. Exported for tests. */
export function findWarnings(
  route: BaseRoute,
  settings: Settings,
  access: AccessData | null,
  reports: Report[],
  now = Date.now(),
): RouteWarning[] {
  const warnings: RouteWarning[] = []
  const line = route.geometry

  if (!route.stepFreeVerified && settings.profile !== 'night') {
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

    if (settings.profile === 'night') {
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

export async function planRoute(
  from: LngLat,
  to: LngLat,
  settings: Settings,
  loadAccess: (route: LngLat[]) => Promise<AccessData | null>,
  reports: Report[],
): Promise<RouteResult> {
  const base = ORS_KEY ? await routeWithOrs(from, to, settings, ORS_KEY) : await routeWithFallback(from, to)
  const access = await loadAccess(base.geometry).catch(() => null)
  return { ...base, warnings: findWarnings(base, settings, access, reports) }
}
