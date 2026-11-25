import { MAP_STYLES } from '../config'
import { TRAVEL_MODES, type Settings } from './types'
import { isMarkerStyle } from './marker'

const KEY = 'accessible-maps.settings'
export const DEFAULT_SETTINGS: Settings = { profile: 'wheelchair', maxInclinePercent: 6, worldview: 'auto', mapLook: 'signature', travelMode: 'walk', units: 'auto', marker: 'auto' }

export function loadSettings(): Settings {
  try {
    const s: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    if (!(s.mapLook in MAP_STYLES)) s.mapLook = DEFAULT_SETTINGS.mapLook
    // Clean was the default before the signature look; move people who never picked a look.
    if (!s.lookPicked && s.mapLook === 'clean') s.mapLook = DEFAULT_SETTINGS.mapLook
    if (!(s.travelMode in TRAVEL_MODES)) s.travelMode = DEFAULT_SETTINGS.travelMode
    if (!['auto', 'km', 'mi'].includes(s.units)) s.units = DEFAULT_SETTINGS.units
    if (!isMarkerStyle(s.marker)) s.marker = 'auto'
    return s
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Private browsing or blocked storage: settings just won't be remembered.
  }
}
