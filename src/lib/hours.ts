// Reads OpenStreetMap opening_hours text (e.g. "Mo-Fr 08:00-18:00; Sa 09:00-14:00; Su off")
// and works out whether a place is open right now. Covers the common forms used for shops and
// restaurants; anything fancier (dates, holidays only, sunrise...) returns null = "hours unknown".

type Interval = [number, number] // minutes from the start of the day; end can pass midnight (> 1440)
type Week = Interval[][] // index 0 = Monday ... 6 = Sunday

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function parseDays(sel: string): number[] | null {
  const out = new Set<number>()
  for (const part of sel.split(',')) {
    const m = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/)
    if (!m) return null
    const a = DAYS.indexOf(m[1])
    const b = m[2] ? DAYS.indexOf(m[2]) : a
    for (let i = 0; i < 7; i++) {
      const d = (a + i) % 7
      out.add(d)
      if (d === b) break
    }
  }
  return [...out]
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function parseTimes(s: string): Interval[] | null {
  const out: Interval[] = []
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/)
    if (!m) return null
    const start = toMin(m[1])
    let end = toMin(m[2])
    if (end <= start) end += 1440 // e.g. 18:00-02:00 runs past midnight
    out.push([start, end])
  }
  return out
}

/** Parse opening_hours into a weekly schedule, or null if the format isn't understood. Exported for tests. */
export function parseOpeningHours(text: string): Week | null {
  const src = text.trim()
  if (!src) return null
  if (src === '24/7') return DAYS.map(() => [[0, 1440]])
  const week: Week = DAYS.map(() => [])
  // Rules are split by ";". A comma right after a time that is followed by a day also starts a rule.
  const rules = src.split(';').flatMap((r) => r.split(/(?<=\d)\s*,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/))
  let understood = false
  for (const raw of rules) {
    const rule = raw.trim()
    if (!rule) continue
    // Public / school holiday rules: we can't know holiday dates, so leave them out.
    if (/^(PH|SH)\b/.test(rule)) continue
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?(?:\s*,\s*PH)?\s*(.*)$/)
    if (!m) return null
    const days = m[1] ? parseDays(m[1]) : [0, 1, 2, 3, 4, 5, 6]
    if (!days) return null
    const rest = m[2].trim()
    let times: Interval[]
    if (rest === 'off' || rest === 'closed') times = []
    else if (rest === '' || rest === '00:00-24:00') times = [[0, 1440]]
    else {
      const t = parseTimes(rest)
      if (!t) return null
      times = t
    }
    // In opening_hours a later rule replaces earlier ones for the days it names.
    for (const d of days) week[d] = times
    understood = true
  }
  return understood ? week : null
}

export interface OpenStatus {
  open: boolean
  /** e.g. "Closes 10 PM", "Opens 11 AM Tue", "Open 24 hours" */
  detail: string
}

function fmt(min: number): string {
  const h24 = Math.floor((min % 1440) / 60)
  const m = min % 60
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h24 < 12 ? 'AM' : 'PM'}`
}

/** Is the place open at `now` (the visitor's local time)? Null when the hours can't be read. */
export function openStatus(text: string | undefined, now: Date = new Date()): OpenStatus | null {
  if (!text) return null
  const week = parseOpeningHours(text)
  if (!week) return null
  if (week.every((d) => d.length === 1 && d[0][0] === 0 && d[0][1] >= 1440)) return { open: true, detail: 'Open 24 hours' }

  const today = (now.getDay() + 6) % 7 // JS Sunday=0 -> Monday=0
  const minute = now.getHours() * 60 + now.getMinutes()

  // Open intervals as absolute minutes from the start of yesterday, covering yesterday to a week ahead.
  const spans: Interval[] = []
  for (let off = -1; off <= 7; off++) {
    const d = (today + off + 7) % 7
    for (const [s, e] of week[d]) spans.push([(off + 1) * 1440 + s, (off + 1) * 1440 + e])
  }
  spans.sort((a, b) => a[0] - b[0])
  const t = 1440 + minute

  const current = spans.find(([s, e]) => s <= t && t < e)
  if (current) {
    // Merge back-to-back spans (e.g. 24 hours across days) to find the real closing time.
    let end = current[1]
    for (const [s, e] of spans) if (s <= end && e > end) end = e
    if (end - t >= 7 * 1440) return { open: true, detail: 'Open 24 hours' }
    const closeDay = Math.floor(end / 1440) - 1
    return { open: true, detail: `Closes ${fmt(end)}${closeDay > 1 ? ` ${DAY_NAMES[(today + closeDay) % 7]}` : ''}` }
  }
  const next = spans.find(([s]) => s > t)
  if (!next) return { open: false, detail: 'Closed' }
  const dayOff = Math.floor(next[0] / 1440) - 1
  const when = dayOff === 0 ? '' : dayOff === 1 ? ' tomorrow' : ` ${DAY_NAMES[(today + dayOff) % 7]}`
  return { open: false, detail: `Opens ${fmt(next[0])}${when}` }
}
