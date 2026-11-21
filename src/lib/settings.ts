import { MAP_STYLES } from '../config'
import { TRAVEL_MODES, type Settings } from './types'

const KEY = 'accessible-maps.settings'
export const DEFAULT_SETTINGS: Settings = { profile: 'wheelchair', maxInclinePercent: 6, worldview: 'auto', mapLook: 'clean', travelMode: 'walk' }

export function loadSettings(): Settings {
  try {
    const s: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    if (!(s.mapLook in MAP_STYLES)) s.mapLook = DEFAULT_SETTINGS.mapLook
    if (!(s.travelMode in TRAVEL_MODES)) s.travelMode = DEFAULT_SETTINGS.travelMode
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
