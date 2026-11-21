import type { Settings } from './types'

const KEY = 'accessible-maps.settings'
export const DEFAULT_SETTINGS: Settings = { profile: 'wheelchair', maxInclinePercent: 6, worldview: 'auto', mapStyle: 'liberty' }

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
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
