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
  /** Called when the box gets focus (e.g. so a map tap fills this box). */
  onFocus?: () => void
}

let nextId = 0

/**
 * A maps-style search box: suggestions as you type, nearest first, typo-tolerant.
 * Enter picks the highlighted (or top) suggestion, even if it is still loading.
 */
export function SearchBox({ label, placeholder, value, onSelect, extraOptions = [], near, hideLabel, onFocus }: Props) {
  const [text, setText] = useState(value?.name ?? '')
  const [found, setFound] = useState<(SearchResults & { query: string }) | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  /** Bumped to search again (automatic retries and the Try again button). */
  const [attempt, setAttempt] = useState(0)
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
    let retry: number | undefined
    const timer = window.setTimeout(() => {
      searchAll(query, ctrl.signal, nearRef.current)
        .then((r) => {
          setError(null)
          setFound({ ...r, query })
          if (enterPending.current) {
            enterPending.current = false
            if (r.places[0]) choose(r.places[0])
          }
          // Then, for sports and cuisines, add places tagged with exactly that (slower lookup).
          if (r.kind?.tagged) {
            searchAll(query, ctrl.signal, nearRef.current, true)
              .then((full) => { if (full.places.length) setFound({ ...full, query }) })
              .catch(() => {})
          }
        })
        .catch((e) => {
          if (e.name === 'AbortError') return
          // Every source failed. Keep trying quietly a few times before asking you to.
          if (attempt < 3) {
            setError('retrying')
            retry = window.setTimeout(() => setAttempt((a) => a + 1), 1500 * 2 ** attempt)
          } else {
            setError('offline')
          }
        })
    }, attempt ? 0 : 250)
    return () => { window.clearTimeout(timer); window.clearTimeout(retry); ctrl.abort() }
    // choose only uses refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, wantSearch, attempt])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!places.length) return
      e.preventDefault()
      setOpen(true)
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % places.length : (a <= 0 ? places.length : a) - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (places.length) choose(places[Math.max(active, 0)])
      else if (query.length >= 2) {
        enterPending.current = true; setOpen(true)
        if (error === 'offline') { setError('retrying'); setAttempt((a) => a + 1) }
      }
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
          onFocus={(e) => { setOpen(true); e.target.select(); onFocus?.() }}
          onBlur={() => window.setTimeout(() => { setOpen(false); enterPending.current = false }, 150)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setText(e.target.value); setOpen(true); setActive(-1); setError(null); setAttempt(0)
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
          {error === 'retrying' && <li className="search-note" aria-live="polite">Search is slow right now. Still trying…</li>}
          {error === 'offline' && (
            <li className="search-note search-offline" aria-live="polite">
              <span>Can't reach the map search at the moment. Check your connection, or try again.</span>
              <button type="button" className="secondary" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setError('retrying'); setAttempt((a) => a + 1) }}>Try again</button>
            </li>
          )}
          {loading && <li className="search-note" aria-live="polite">Searching…</li>}
          {wantSearch && !loading && !error && places.length === 0 && (
            <li className="search-note">No matches near you. Check the spelling or try a street, town or business name.</li>
          )}
          {places.map((r, i) => (
            <li key={`${r.name}-${r.coords.join()}`}>
              {i === 0 && !r.far && <div className="search-group">{found?.kind ? `${found.kind.icon} ${found.kind.label} near you` : 'Near you'}</div>}
              {r.far && !places[i - 1]?.far && <div className="search-group">Farther away</div>}
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
