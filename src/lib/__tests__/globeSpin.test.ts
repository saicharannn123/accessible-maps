import { describe, expect, it } from 'vitest'
import { globeRadius, isGlobeView, sameSizeZoom, spin, toCamera, toOrientation } from '../globeSpin'

const wrap = (d: number) => ((d % 360) + 540) % 360 - 180
const close = (a: number, b: number, eps = 1e-6) => Math.abs(wrap(a - b)) < eps

describe('globe spin', () => {
  it('round-trips a camera', () => {
    for (const cam of [{ lng: -74.3, lat: 40.8, bearing: 0 }, { lng: 179, lat: -60, bearing: 123 }, { lng: 10, lat: 89.9, bearing: -45 }]) {
      const back = toCamera(toOrientation(cam))
      expect(close(back.lng, cam.lng)).toBe(true)
      expect(back.lat).toBeCloseTo(cam.lat, 6)
      expect(close(back.bearing, cam.bearing)).toBe(true)
    }
  })

  it('spins all the way round the equator and across the date line without jumps', () => {
    const r = 300
    let o = toOrientation({ lng: 0, lat: 0, bearing: 0 })
    const step = (2 * Math.PI * r) / 360 // one degree per step
    let prev = toCamera(o)
    for (let i = 0; i < 360; i++) {
      o = spin(o, -step, 0, r) // drag left: the globe turns east
      const cam = toCamera(o)
      expect(Math.abs(wrap(cam.lng - prev.lng))).toBeCloseTo(1, 6)
      expect(cam.lat).toBeCloseTo(0, 6)
      expect(close(cam.bearing, 0)).toBe(true)
      prev = cam
    }
    expect(close(prev.lng, 0, 1e-6)).toBe(true)
  })

  it('carries you over the North Pole and down the other side, upside down', () => {
    const r = 300
    let o = toOrientation({ lng: -74, lat: 40, bearing: 0 })
    const step = (2 * Math.PI * r) / 720 // half a degree per step
    let prev = toCamera(o)
    let maxLat = -90
    for (let i = 0; i < 200; i++) { // 100° northwards
      o = spin(o, 0, step, r) // drag down: land above comes into view
      const cam = toCamera(o)
      // The middle of the screen always moves exactly half a degree along the globe.
      const a = toOrientation({ ...prev, bearing: 0 }).center, b = toOrientation({ ...cam, bearing: 0 }).center
      const moved = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180 / Math.PI
      expect(moved).toBeCloseTo(0.5, 6)
      maxLat = Math.max(maxLat, cam.lat)
      prev = cam
    }
    expect(maxLat).toBeGreaterThan(89.9)
    expect(prev.lat).toBeCloseTo(40, 6) // 40 + 100 = 140 → 40° on the far side
    expect(close(prev.lng, 106)).toBe(true)
    expect(close(Math.abs(prev.bearing), 180)).toBe(true)
  })

  it('goes over the South Pole too, and a full loop comes home', () => {
    const r = 200
    let o = toOrientation({ lng: 20, lat: -10, bearing: 0 })
    const step = (2 * Math.PI * r) / 360
    for (let i = 0; i < 360; i++) o = spin(o, 0, -step, r)
    const cam = toCamera(o)
    expect(cam.lat).toBeCloseTo(-10, 6)
    expect(close(cam.lng, 20)).toBe(true)
    expect(close(cam.bearing, 0)).toBe(true)
  })

  it('keeps the globe the same size as the middle moves poleward', () => {
    const z = sameSizeZoom(2, 0, 60)
    expect(globeRadius(z, 60)).toBeCloseTo(globeRadius(2, 0), 6)
    expect(isGlobeView(2, 0, 400, 800)).toBe(true)
    expect(isGlobeView(10, 0, 400, 800)).toBe(false)
  })
})
