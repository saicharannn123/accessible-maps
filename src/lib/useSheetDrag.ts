import { useEffect, useRef, type RefObject } from 'react'

/** Bottom sheet stops on phones: a peek of the title, half the screen, or nearly full. */
export type SheetSnap = 'peek' | 'half' | 'full'
export const SNAPS: SheetSnap[] = ['peek', 'half', 'full']

/** Sheet heights in pixels for a map area this tall. Must match the phone CSS in index.css. */
export function snapHeights(appH: number, dockH = 64, gap = 8): Record<SheetSnap, number> {
  return { peek: 78, half: appH * 0.58, full: appH - dockH - gap * 2 - 80 }
}

/**
 * Where a released drag should settle: a quick flick goes one stop in its direction, otherwise
 * the nearest stop wins. Velocity is in px/ms, positive when the finger moves down.
 */
export function pickSnap(height: number, velocity: number, from: SheetSnap, heights: Record<SheetSnap, number>): SheetSnap {
  if (Math.abs(velocity) > 0.45) {
    const i = SNAPS.indexOf(from)
    // A flick from the middle of a long drag counts from where the sheet is now, not where it started.
    const nearest = SNAPS.reduce((a, b) => (Math.abs(heights[b] - height) < Math.abs(heights[a] - height) ? b : a))
    const base = Math.abs(SNAPS.indexOf(nearest) - i) > 1 ? SNAPS.indexOf(nearest) : i
    const next = velocity > 0 ? Math.max(0, base - 1) : Math.min(SNAPS.length - 1, base + 1)
    return SNAPS[next]
  }
  return SNAPS.reduce((a, b) => (Math.abs(heights[b] - height) < Math.abs(heights[a] - height) ? b : a))
}

/**
 * Let the phone sheet follow the finger. Dragging the handle or title always moves the sheet;
 * inside the content, a swipe up grows the sheet until it is full, and a swipe down shrinks it
 * once the content is scrolled to the top. Otherwise the content scrolls as usual.
 */
export function useSheetDrag(
  panel: RefObject<HTMLElement | null>,
  scroller: RefObject<HTMLElement | null>,
  snap: SheetSnap,
  setSnap: (s: SheetSnap) => void,
) {
  const snapRef = useRef(snap)
  const setRef = useRef(setSnap)
  useEffect(() => { snapRef.current = snap; setRef.current = setSnap })

  useEffect(() => {
    const el = panel.current
    if (!el) return
    const phone = () => window.matchMedia('(max-width: 720px)').matches
    let startY = 0, startH = 0, lastY = 0, lastT = 0, velocity = 0
    let mode: 'idle' | 'maybe' | 'drag' | 'scroll' = 'idle'
    let onGrip = false

    const heights = () => snapHeights(el.parentElement?.clientHeight ?? window.innerHeight)

    const start = (e: TouchEvent) => {
      if (!phone() || e.touches.length !== 1) return
      const t = e.target as Element
      // Leave form fields and buttons inside the content alone until the finger actually moves.
      onGrip = !!t.closest('.sheet-handle, .panel-head, .sheet-grip')
      startY = lastY = e.touches[0].clientY
      lastT = performance.now()
      startH = el.getBoundingClientRect().height
      velocity = 0
      mode = 'maybe'
    }

    const move = (e: TouchEvent) => {
      if (mode === 'idle' || mode === 'scroll') return
      const y = e.touches[0].clientY
      const dy = y - startY
      if (mode === 'maybe') {
        if (Math.abs(dy) < 6) return
        const atTop = (scroller.current?.scrollTop ?? 0) <= 0
        const growing = dy < 0 && snapRef.current !== 'full'
        const shrinking = dy > 0 && atTop
        if (!onGrip && !growing && !shrinking) { mode = 'scroll'; return }
        mode = 'drag'
        el.classList.add('dragging')
      }
      e.preventDefault()
      const h = heights()
      const height = Math.max(h.peek - 20, Math.min(h.full + 20, startH - dy))
      el.style.maxHeight = `${height}px`
      el.style.height = `${height}px`
      const now = performance.now()
      if (now > lastT) velocity = velocity * 0.4 + ((y - lastY) / (now - lastT)) * 0.6
      lastY = y; lastT = now
    }

    const end = () => {
      if (mode === 'drag') {
        const height = el.getBoundingClientRect().height
        el.classList.remove('dragging')
        el.style.maxHeight = ''
        el.style.height = ''
        setRef.current(pickSnap(height, velocity, snapRef.current, heights()))
      }
      mode = 'idle'
    }

    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [panel, scroller])
}
