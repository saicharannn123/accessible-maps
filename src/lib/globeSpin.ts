import type { Map as MlMap } from 'maplibre-gl'

/**
 * Free spinning for the zoomed-out globe.
 *
 * MapLibre's own globe drag keeps north up, so it can never carry you over a pole. Here the camera
 * is a point on the sphere (the spot in the middle of the screen) plus the direction that is "up"
 * on screen. A drag turns both around the globe's center, like spinning a real globe with your
 * hand, and the result is turned back into a center, bearing and zoom for MapLibre. Crossing a
 * pole simply turns the map upside down (bearing +180°) on the far side, with no jump.
 */

export type Vec3 = [number, number, number]
export interface Orientation { center: Vec3; up: Vec3 }
export interface Camera { lng: number; lat: number; bearing: number }

const RAD = Math.PI / 180
/** Where Mercator (and MapLibre's globe sizing) stops. */
const MAX_MERC_LAT = 85.051129

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return scale(a, 1 / l) }

/** Camera (center + bearing) → orientation on the unit sphere. */
export function toOrientation(cam: Camera): Orientation {
  const lat = cam.lat * RAD, lng = cam.lng * RAD, b = cam.bearing * RAD
  const center: Vec3 = [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)]
  const north: Vec3 = [-Math.sin(lat) * Math.cos(lng), -Math.sin(lat) * Math.sin(lng), Math.cos(lat)]
  const east: Vec3 = [-Math.sin(lng), Math.cos(lng), 0]
  return { center, up: norm(add(scale(north, Math.cos(b)), scale(east, Math.sin(b)))) }
}

/** Orientation → camera. Exactly on a pole the longitude comes from the screen's up direction. */
export function toCamera(o: Orientation): Camera {
  const [x, y, z] = o.center
  const lat = Math.asin(Math.max(-1, Math.min(1, z))) / RAD
  const flat = Math.hypot(x, y)
  let lng: number
  if (flat > 1e-9) lng = Math.atan2(y, x) / RAD
  else {
    // On the pole: pick the longitude whose north (or south) direction is screen-up, i.e. bearing 0.
    const u = z > 0 ? scale(o.up, -1) : o.up
    lng = Math.atan2(u[1], u[0]) / RAD
  }
  const lr = lat * RAD, gr = lng * RAD
  const north: Vec3 = [-Math.sin(lr) * Math.cos(gr), -Math.sin(lr) * Math.sin(gr), Math.cos(lr)]
  const east: Vec3 = [-Math.sin(gr), Math.cos(gr), 0]
  const bearing = Math.atan2(dot(o.up, east), dot(o.up, north)) / RAD
  return { lng, lat, bearing: Math.abs(bearing) < 1e-9 ? 0 : bearing }
}

/**
 * Turn the globe as if the surface under the finger moved by (dx, dy) screen pixels, for a globe
 * `radius` pixels across. Dragging right brings the land on the left into the middle, dragging down
 * brings in the land above, in whatever direction the map is currently facing.
 */
export function spin(o: Orientation, dx: number, dy: number, radius: number): Orientation {
  const dist = Math.hypot(dx, dy)
  if (dist === 0 || radius <= 0) return o
  const right = cross(o.up, o.center) // screen right, tangent to the sphere
  // The spot that was at (-dx, -dy) from the middle comes to the middle. Screen y points down.
  const dir = norm(add(scale(right, -dx), scale(o.up, dy)))
  const axis = norm(cross(o.center, dir))
  const a = dist / radius
  return { center: norm(rotate(o.center, axis, a)), up: norm(rotate(o.up, axis, a)) }
}

/** Rodrigues' rotation of v around the unit axis k by angle a. */
function rotate(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a)
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)))
}

/** MapLibre draws the globe bigger towards the poles (to match Mercator in the middle), up to 85°. */
const sizeFactor = (lat: number) => 1 / Math.cos(Math.min(Math.abs(lat), MAX_MERC_LAT) * RAD)

/** Globe radius on screen, in CSS pixels. */
export function globeRadius(zoom: number, lat: number): number {
  return (512 * 2 ** zoom) / (2 * Math.PI) * sizeFactor(lat)
}

/** The zoom that keeps the globe the same size on screen when the middle moves from lat0 to lat1. */
export function sameSizeZoom(zoom: number, lat0: number, lat1: number): number {
  return zoom + Math.log2(sizeFactor(lat0) / sizeFactor(lat1))
}

/** Free spinning is on while the globe is small enough that its poles can come to the middle. */
export function isGlobeView(zoom: number, lat: number, width: number, height: number): boolean {
  return globeRadius(zoom, lat) <= 2.5 * Math.min(width, height)
}

/**
 * Wire free spinning into a map. While the globe is zoomed out, one-finger / left-button drags
 * spin it (with a little momentum); pinch-to-zoom, wheel zoom and right-drag rotate keep working.
 * Zoomed in, MapLibre's usual panning takes over. Returns a function that removes everything.
 */
export function attachGlobeSpin(map: MlMap, onUserSpin: () => void): () => void {
  const box = map.getCanvasContainer()
  let active: { id: number; x: number; y: number; o: Orientation; zoom: number; lat: number; moved: boolean } | null = null
  let samples: { t: number; x: number; y: number }[] = []
  let raf = 0
  let on = false

  const updateMode = () => {
    const c = map.getCenter()
    const want = isGlobeView(map.getZoom(), c.lat, map.getContainer().clientWidth, map.getContainer().clientHeight)
    if (want === on || active) return
    on = want
    box.classList.toggle('spin-globe', on)
    if (on) map.dragPan.disable()
    else map.dragPan.enable()
  }

  /** Apply a drag of (dx, dy) pixels, keeping the globe the same size on screen. */
  const apply = (dx: number, dy: number) => {
    if (!active) return
    const radius = globeRadius(active.zoom, active.lat)
    active.o = spin(active.o, dx, dy, radius)
    const cam = toCamera(active.o)
    const zoom = sameSizeZoom(active.zoom, active.lat, cam.lat)
    active.zoom = zoom
    active.lat = cam.lat
    map.jumpTo({ center: [cam.lng, cam.lat], bearing: cam.bearing, zoom })
  }

  const stopMomentum = () => { cancelAnimationFrame(raf); raf = 0 }

  const begin = (id: number, x: number, y: number) => {
    stopMomentum()
    map.stop()
    const c = map.getCenter()
    active = { id, x, y, o: toOrientation({ lng: c.lng, lat: c.lat, bearing: map.getBearing() }), zoom: map.getZoom(), lat: c.lat, moved: false }
    samples = [{ t: performance.now(), x, y }]
  }

  const onDown = (e: PointerEvent) => {
    // Touching a globe that is still coasting catches it.
    if (raf) { stopMomentum(); active = null }
    if (!on || active) {
      // A second finger: hand over to pinch-to-zoom.
      if (active && e.pointerType === 'touch') end(false)
      return
    }
    if (e.pointerType === 'mouse' && (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey)) return
    if ((e.target as Element).closest('.maplibregl-marker, .maplibregl-popup')) return
    begin(e.pointerId, e.clientX, e.clientY)
  }

  const onMove = (e: PointerEvent) => {
    if (!active || e.pointerId !== active.id) return
    const dx = e.clientX - active.x, dy = e.clientY - active.y
    if (!active.moved) {
      if (Math.hypot(dx, dy) < 3) return
      active.moved = true
      box.setPointerCapture?.(e.pointerId)
      box.classList.add('spinning')
      onUserSpin()
    }
    active.x = e.clientX
    active.y = e.clientY
    const t = performance.now()
    samples.push({ t, x: e.clientX, y: e.clientY })
    while (samples.length > 2 && t - samples[0].t > 100) samples.shift()
    apply(dx, dy)
  }

  const end = (momentum: boolean) => {
    if (!active) return
    const moved = active.moved
    box.classList.remove('spinning')
    if (box.hasPointerCapture?.(active.id)) box.releasePointerCapture(active.id)
    const first = samples[0], last = samples[samples.length - 1]
    const dt = last.t - first.t
    if (momentum && moved && dt > 0 && performance.now() - last.t < 80) {
      let vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt
      const speed = Math.hypot(vx, vy)
      const max = 4 // px per ms
      if (speed > max) { vx *= max / speed; vy *= max / speed }
      if (speed > 0.15) {
        let prev = performance.now()
        const step = (now: number) => {
          const ms = Math.min(now - prev, 50)
          prev = now
          const decay = Math.exp(-ms / 380)
          vx *= decay; vy *= decay
          apply(vx * ms, vy * ms)
          if (Math.hypot(vx, vy) > 0.02 && active) raf = requestAnimationFrame(step)
          else { active = null; raf = 0; updateMode() }
        }
        raf = requestAnimationFrame(step)
        return
      }
    }
    active = null
    updateMode()
  }

  const onUp = (e: PointerEvent) => { if (active && e.pointerId === active.id && !raf) end(true) }
  const onCancel = (e: PointerEvent) => { if (active && e.pointerId === active.id && !raf) end(false) }
  // Any other way of moving the map (wheel, pinch, buttons, search) stops the spin's momentum.
  const interrupt = () => { if (raf) { stopMomentum(); active = null; updateMode() } }

  box.addEventListener('pointerdown', onDown)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  box.addEventListener('wheel', interrupt, { passive: true })
  box.addEventListener('touchstart', interrupt, { passive: true })
  map.on('zoom', updateMode)
  map.on('resize', updateMode)
  updateMode()

  return () => {
    stopMomentum()
    box.removeEventListener('pointerdown', onDown)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    box.removeEventListener('wheel', interrupt)
    box.removeEventListener('touchstart', interrupt)
    map.off('zoom', updateMode)
    map.off('resize', updateMode)
  }
}
