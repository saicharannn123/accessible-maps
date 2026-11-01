import { REPORT_LIFETIME_DAYS } from '../config'
import type { Report } from './types'

// Version 1 keeps reports in this browser only. Step 2 of the spec moves them to Supabase
// so everyone sees everyone's reports.
const KEY = 'accessible-maps.reports'
const LIFETIME_MS = REPORT_LIFETIME_DAYS * 24 * 60 * 60 * 1000

export function loadReports(now = Date.now()): Report[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Report[]
    return all.filter((r) => now - r.createdAt < LIFETIME_MS)
  } catch {
    return []
  }
}

export function saveReports(reports: Report[]): void {
  localStorage.setItem(KEY, JSON.stringify(reports))
}

export function timeAgo(ts: number, now = Date.now()): string {
  const min = Math.round((now - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
