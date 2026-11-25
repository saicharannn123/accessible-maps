import type { TravelMode } from './types'

/** How your own position is drawn on the map. */
export type MarkerStyle = 'auto' | 'dot' | 'beam' | 'arrow' | 'walker' | 'wheelchair' | 'car' | 'bike' | 'star'
export type DrawnMarker = Exclude<MarkerStyle, 'auto'>

export const MARKER_STYLES: { id: MarkerStyle; label: string; hint: string }[] = [
  { id: 'auto', label: 'Automatic', hint: 'Dot while browsing, arrow while navigating' },
  { id: 'dot', label: 'Dot', hint: 'Classic round dot' },
  { id: 'beam', label: 'Dot + beam', hint: 'Dot with a cone showing which way you face' },
  { id: 'arrow', label: 'Arrow', hint: 'Points the way you are going' },
  { id: 'walker', label: 'Walker', hint: 'A person walking' },
  { id: 'wheelchair', label: 'Wheelchair', hint: 'Wheelchair user' },
  { id: 'car', label: 'Car', hint: 'For driving' },
  { id: 'bike', label: 'Bike', hint: 'For cycling' },
  { id: 'star', label: 'Star', hint: 'Easy to spot' },
]

export const isMarkerStyle = (v: unknown): v is MarkerStyle => MARKER_STYLES.some((m) => m.id === v)

/** What to draw right now: Automatic shows a dot, an arrow while navigating, a car or bike for those modes. */
export function resolveMarker(style: MarkerStyle, navigating: boolean, mode: TravelMode): DrawnMarker {
  if (style !== 'auto') return style
  if (!navigating) return 'dot'
  return mode === 'car' ? 'car' : mode === 'bike' ? 'bike' : 'arrow'
}

/** Markers that turn with your heading. Emoji markers stay upright so they stay readable. */
export const ROTATES: Record<DrawnMarker, boolean> = {
  dot: false, beam: true, arrow: true, walker: false, wheelchair: false, car: false, bike: false, star: false,
}

const EMOJI: Partial<Record<DrawnMarker, string>> = { walker: '🚶', wheelchair: '🧑‍🦽', car: '🚗', bike: '🚲', star: '⭐' }

/** The marker's HTML. Static markup built only from the constants above. */
export function markerHtml(style: DrawnMarker): string {
  switch (style) {
    case 'dot':
      return '<span class="me-mk me-dot"></span>'
    case 'beam':
      return '<span class="me-mk me-beam"><svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="bm-beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5b3df5" stop-opacity=".55"/><stop offset="1" stop-color="#5b3df5" stop-opacity="0"/></linearGradient></defs><path d="M32 32 L14 2 A34 34 0 0 1 50 2 Z" fill="url(#bm-beam)"/></svg><span class="me-dot"></span></span>'
    case 'arrow':
      return '<span class="me-mk me-arrow"><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="#fff"/><path d="M24 7 L37 38 L24 31 L11 38 Z" fill="#5b3df5" stroke="#3a22b8" stroke-width="1.5" stroke-linejoin="round"/></svg></span>'
    default:
      return `<span class="me-mk me-emoji">${EMOJI[style] ?? '📍'}</span>`
  }
}
