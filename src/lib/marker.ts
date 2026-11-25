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
  { id: 'car', label: 'Car', hint: 'A car that drives along the road with you' },
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
  dot: false, beam: true, arrow: true, walker: false, wheelchair: false, car: true, bike: false, star: false,
}

const EMOJI: Partial<Record<DrawnMarker, string>> = { walker: '🚶', wheelchair: '🧑‍🦽', bike: '🚲', star: '⭐' }

/** The marker's HTML. Static markup built only from the constants above. */
export function markerHtml(style: DrawnMarker): string {
  switch (style) {
    case 'dot':
      return '<span class="me-mk me-dot"></span>'
    case 'beam':
      return '<span class="me-mk me-beam"><svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="bm-beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5b3df5" stop-opacity=".55"/><stop offset="1" stop-color="#5b3df5" stop-opacity="0"/></linearGradient></defs><path d="M32 32 L14 2 A34 34 0 0 1 50 2 Z" fill="url(#bm-beam)"/></svg><span class="me-dot"></span></span>'
    case 'arrow':
      return '<span class="me-mk me-arrow"><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="#fff"/><path d="M24 7 L37 38 L24 31 L11 38 Z" fill="#5b3df5" stroke="#3a22b8" stroke-width="1.5" stroke-linejoin="round"/></svg></span>'
    case 'car':
      return CAR_SVG
    default:
      return `<span class="me-mk me-emoji">${EMOJI[style] ?? '📍'}</span>`
  }
}

/**
 * A top-down car in the BM Locator violet, nose pointing up: soft shadow, shaded body, tinted
 * glass, roof, mirrors, headlights and taillights.
 */
const CAR_SVG = `<span class="me-mk me-car"><svg viewBox="0 0 44 80" aria-hidden="true">
<defs>
<linearGradient id="bm-car-body" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a22b8"/><stop offset=".22" stop-color="#6d50ff"/><stop offset=".5" stop-color="#8b74ff"/><stop offset=".78" stop-color="#6d50ff"/><stop offset="1" stop-color="#3a22b8"/></linearGradient>
<linearGradient id="bm-car-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1440"/><stop offset="1" stop-color="#3b3478"/></linearGradient>
<linearGradient id="bm-car-roof" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4a30d6"/><stop offset=".5" stop-color="#7a62ff"/><stop offset="1" stop-color="#4a30d6"/></linearGradient>
<radialGradient id="bm-car-shadow"><stop offset=".6" stop-color="#17123a" stop-opacity=".35"/><stop offset="1" stop-color="#17123a" stop-opacity="0"/></radialGradient>
</defs>
<ellipse cx="22" cy="42" rx="21" ry="38" fill="url(#bm-car-shadow)"/>
<rect x="3" y="15" width="4" height="10" rx="2" fill="#111"/><rect x="37" y="15" width="4" height="10" rx="2" fill="#111"/>
<rect x="3" y="54" width="4" height="11" rx="2" fill="#111"/><rect x="37" y="54" width="4" height="11" rx="2" fill="#111"/>
<path d="M22 4 C31 4 37 8 38 16 L39 62 C39 70 34 75 22 75 C10 75 5 70 5 62 L6 16 C7 8 13 4 22 4 Z" fill="url(#bm-car-body)" stroke="#2a1890" stroke-width="1"/>
<path d="M14 7.5 Q22 5.5 30 7.5" stroke="#b9acff" stroke-width="1" fill="none" opacity=".7"/>
<path d="M17 9 L17 20 M27 9 L27 20" stroke="#4a30d6" stroke-width=".8" opacity=".7"/>
<path d="M9.5 24 Q22 19 34.5 24 L32 34 Q22 31.5 12 34 Z" fill="url(#bm-car-glass)"/>
<path d="M12 25 Q17 23 21 23" stroke="#fff" stroke-width="1.2" opacity=".35" fill="none" stroke-linecap="round"/>
<rect x="12" y="34" width="20" height="21" rx="3" fill="url(#bm-car-roof)"/>
<path d="M8.5 27 L11 35 L11 54 L8.5 59 Z M35.5 27 L33 35 L33 54 L35.5 59 Z" fill="#241b5c" opacity=".9"/>
<path d="M12 55 Q22 57.5 32 55 L33.5 63 Q22 66 10.5 63 Z" fill="url(#bm-car-glass)"/>
<path d="M4 28 L1 27 L1.5 31 L5 31 Z M40 28 L43 27 L42.5 31 L39 31 Z" fill="#4a30d6"/>
<path d="M9 7.5 Q11 5.5 14.5 5.2 L13.5 9 Q10.5 9.3 9 7.5 Z M35 7.5 Q33 5.5 29.5 5.2 L30.5 9 Q33.5 9.3 35 7.5 Z" fill="#fff8d6"/>
<path d="M8 71 Q10 73.5 14 74 L14 71.5 Z M36 71 Q34 73.5 30 74 L30 71.5 Z" fill="#ff3b5c"/>
</svg></span>`
