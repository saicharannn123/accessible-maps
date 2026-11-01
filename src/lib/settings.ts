import type { Settings } from './types'

const KEY = 'accessible-maps.settings'
export const DEFAULT_SETTINGS: Settings = { profile: 'wheelchair', maxInclinePercent: 6 }

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s))
}
