import { useEffect, useRef, useState } from 'react'
import { searchAll, type SearchResults } from '../lib/geocode'
import type { Place } from '../lib/types'

interface Props {
  label: string
  placeholder: string
  value: Place | null
  onSelect: (p: Place | null) => void
  extraOptions?: { label: string; onPick: () => void }[]
  /** Prefer results near this point (your live location or the map). */
  near?: [number, number]
  /** Keep the label for screen readers only. */
  hideLabel?: boolean
}

let nextId = 0

/**
 * A maps-style search box: suggestions as you type, nearest first, typo-tolerant.
 * Enter picks the highlighted (or top) suggestion, even if it is still loading.
 */
export function SearchBox({ label, placeholder, value, onSelect, extraOptions = [], near, hideLabel }: Props) {
  const [text, setText] = useState(value?.name ?? '')
  const [found, setFound] = useState<(SearchResults & { query: string }) | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const nearRef = useRef(near)
  const enterPending = useRef(false)
  const onSelectRef = useRef(onSelect)
  const [listId] = useState(() => `search-${++nextId}`)
  useEffect(() => { nearRef.current = near; onSelectRef.current = onSelect })

  // Keep the text in step when the parent picks a place (e.g. "Pick on map").
  const [shownValue, setShownValue] = useState(value)
  if (value !== shownValue) {
    setShownValue(value)
    setText(value?.name ?? '')
  }

  const query = text.trim()
  // Don't search for the name of the place that's already chosen ("My location").
  const wantSearch = open && query.length >= 2 && query !== value?.name
  const places = wantSearch && found?.query === query ? found.places : []
  const loading = wantSearch && found?.query !== query && !error

  const choose = (p: Place) => {
    onSelectRef.current(p)
    setText(p.name)
    setOpen(false)
    setActive(-1)
  }

  useEffect(() => {
    if (!wantSearch) return
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => {
      searchAll(query, ctrl.signal, nearRef.current)
        .then((r) => {
          setError(null)
          setFound({ ...r, query })
          if (enterPending.current) {
            enterPending.current = false
            if (r.places[0]) choose(r.places[0])
          }
        })
        .catch((e) => { if (e.name !== 'AbortError') setError('Search is unavailable right now. Try again in a moment.') })
    }, 250)
    return () => { window.clearTimeout(timer); ctrl.abort() }
    // choose only uses refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, wantSearch])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!places.length) return
      e.preventDefault()
      setOpen(true)
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % places.length : (a <= 0 ? places.length : a) - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (places.length) choose(places[Math.max(active, 0)])
      else if (query.length >= 2) { enterPending.current = true; setOpen(true) }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="search">
      <label>
        {label ? <span className={hideLabel ? 'sr-only' : 'search-label'}>{label}</span> : <span className="sr-only">Search</span>}
        <input
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onFocus={(e) => { setOpen(true); e.target.select() }}
          onBlur={() => window.setTimeout(() => { setOpen(false); enterPending.current = false }, 150)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setText(e.target.value); setOpen(true); setActive(-1); setError(null)
            if (!e.target.value) onSelect(null)
          }}
        />
      </label>
      {open && (
        <ul className="search-results" role="listbox" id={listId}>
          {extraOptions.map((o) => (
            <li key={o.label}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { o.onPick(); setOpen(false) }}>
                <strong>{o.label}</strong>
              </button>
            </li>
          ))}
          {error && <li className="search-error">{error}</li>}
          {loading && <li className="search-note" aria-live="polite">Searching…</li>}
          {wantSearch && !loading && !error && places.length === 0 && (
            <li className="search-note">No matches nearby. Check the spelling or try a street, town or business name.</li>
          )}
          {places.map((r, i) => (
            <li key={`${r.name}-${r.coords.join()}`}>
              {found?.kind && i === 0 && <div className="search-group">{found.kind.icon} {found.kind.label} near you</div>}
              <button
                type="button"
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r)}
              >
                <strong>{r.icon && <span aria-hidden="true">{r.icon} </span>}{r.name}</strong>
                {r.detail && <span>{r.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
