import { useEffect, useRef, useState } from 'react'
import { createMap, findItem, nextMapName, removeItem, savePlace, updateMyMaps, useMyMaps, type SaveablePlace } from '../lib/myMaps'

/**
 * "Save" button for any place: search results, the selected place card, Related places rows.
 * Opens a small menu to pick which of your maps it goes in (or start a new one).
 */
export function SaveToMap({ place, compact = false }: { place: SaveablePlace; compact?: boolean }) {
  const state = useMyMaps()
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const savedIn = state.maps.filter((m) => findItem(m, place))

  // Close on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [open])

  const toggle = (mapId: string) => {
    const m = state.maps.find((x) => x.id === mapId)
    const item = m && findItem(m, place)
    if (item) updateMyMaps((s) => removeItem(s, mapId, item.id))
    else savePlace(place, mapId)
  }
  const makeMap = (name: string) => {
    let id = ''
    updateMyMaps((s) => { const r = createMap(s, name); id = r.id; return r.state })
    if (id) savePlace(place, id)
    setNaming(null)
  }

  const label = savedIn.length === 0 ? 'Save' : savedIn.length === 1 ? `Saved in ${savedIn[0].name}` : `Saved in ${savedIn.length} maps`
  return (
    <div className={`save-to-map${compact ? ' compact' : ''}`} ref={box}>
      <button type="button" className={`secondary save-btn${savedIn.length ? ' saved' : ''}`} aria-haspopup="menu" aria-expanded={open}
        title={savedIn.length ? label : `Save ${place.name} to My Maps`}
        aria-label={compact ? (savedIn.length ? `${place.name}: ${label}` : `Save ${place.name} to My Maps`) : undefined}
        onClick={() => { setOpen((o) => !o); setNaming(state.maps.length === 0 ? nextMapName(state) : null) }}>
        <span aria-hidden="true">{savedIn.length ? '★' : '☆'}</span>{!compact && <span className="save-label">{label}</span>}
      </button>
      {open && (
        <div className="save-menu" role="menu" aria-label="Save to which map">
          <div className="save-menu-head">Save to My Maps</div>
          {state.maps.map((m) => {
            const on = savedIn.includes(m)
            return (
              <button key={m.id} type="button" role="menuitemcheckbox" aria-checked={on} className={on ? 'on' : ''} onClick={() => toggle(m.id)}>
                <span className="save-check" aria-hidden="true">{on ? '✓' : ''}</span>
                <span className="save-map-name">{m.name}</span>
                <span className="muted small">{m.items.length}</span>
              </button>
            )
          })}
          {naming === null ? (
            <button type="button" role="menuitem" className="save-new" onClick={() => setNaming(nextMapName(state))}>＋ New map…</button>
          ) : (
            <form className="save-new-form" onSubmit={(e) => { e.preventDefault(); makeMap(naming) }}>
              <label className="sr-only" htmlFor="save-new-name">Map name</label>
              <input id="save-new-name" autoFocus value={naming} maxLength={80} placeholder="Name your map"
                onFocus={(e) => e.currentTarget.select()} onChange={(e) => setNaming(e.target.value)} />
              <button type="submit" className="primary">Create</button>
            </form>
          )}
          <p className="muted small save-device">Saved on this device only.</p>
        </div>
      )}
    </div>
  )
}
