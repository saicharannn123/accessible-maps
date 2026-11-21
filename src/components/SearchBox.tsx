import { useEffect, useRef, useState } from 'react'
import { searchPlaces } from '../lib/geocode'
import type { Place } from '../lib/types'

interface Props {
  label: string
  placeholder: string
  value: Place | null
  onSelect: (p: Place | null) => void
  extraOptions?: { label: string; onPick: () => void }[]
}

export function SearchBox({ label, placeholder, value, onSelect, extraOptions = [] }: Props) {
  const [text, setText] = useState(value?.name ?? '')
  const [results, setResults] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  // Keep the text in step when the parent picks a place (e.g. "Pick on map").
  const [shownValue, setShownValue] = useState(value)
  if (value !== shownValue) {
    setShownValue(value)
    setText(value?.name ?? '')
  }

  useEffect(() => {
    if (!open) return
    window.clearTimeout(timer.current)
    const ctrl = new AbortController()
    timer.current = window.setTimeout(() => {
      searchPlaces(text, ctrl.signal)
        .then((r) => { setResults(r); setError(null) })
        .catch((e) => { if (e.name !== 'AbortError') setError('Search is unavailable right now') })
    }, 300)
    return () => { window.clearTimeout(timer.current); ctrl.abort() }
  }, [text, open])

  return (
    <div className="search">
      <label>
        <span className="search-label">{label}</span>
        <input
          type="search"
          value={text}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setText(e.target.value); if (!e.target.value) onSelect(null) }}
        />
      </label>
      {open && (
        <ul className="search-results" role="listbox">
          {extraOptions.map((o) => (
            <li key={o.label}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { o.onPick(); setOpen(false) }}>
                <strong>{o.label}</strong>
              </button>
            </li>
          ))}
          {error && <li className="search-error">{error}</li>}
          {results.map((r, i) => (
            <li key={`${r.name}-${i}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onSelect(r); setOpen(false) }}
              >
                <strong>{r.name}</strong>
                {r.detail && <span>{r.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
