import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { formatDistance, distanceMeters } from '../lib/geo'
import {
  createMap, deleteMap, exportJson, itemTitle, mergeImport, myMapsSaved, parseMyMaps, PIN_COLORS, removeItem, renameMap,
  setActive, updateItem, updateMyMaps, useMyMaps, MAX_NOTE, type MapItem, type MyMap,
} from '../lib/myMaps'
import type { LngLat } from '../lib/types'

const SOURCE_TEXT: Record<MapItem['source'], string> = { search: 'From search', related: 'From Related places', pin: 'Your pin' }

interface Props {
  /** The map that's open (its pins are on the map), or null for the list of maps. */
  openId: string | null
  onOpen: (id: string | null) => void
  /** The highlighted item, picked in the list or on the map. */
  focusId: string | null
  onFocus: (id: string | null) => void
  /** Waiting for a tap on the map to drop a pin. */
  dropping: boolean
  onDropPin: () => void
  onShow: (at: LngLat) => void
  onFit: (points: LngLat[]) => void
  onDirections: (item: MapItem) => void
  myLocation: LngLat | null
}

export function MyMapsPanel({ openId, onOpen, focusId, onFocus, dropping, onDropPin, onShow, onFit, onDirections, myLocation }: Props) {
  const state = useMyMaps()
  const map = state.maps.find((m) => m.id === openId) ?? null
  const [newName, setNewName] = useState('')

  // A map deleted in another tab closes here too.
  useEffect(() => { if (openId && !map) onOpen(null) }, [openId, map, onOpen])

  if (map) {
    return <OpenMap map={map} onBack={() => { onOpen(null); onFocus(null) }} focusId={focusId} onFocus={onFocus}
      dropping={dropping} onDropPin={onDropPin} onShow={onShow} onFit={onFit} onDirections={onDirections} myLocation={myLocation} />
  }

  const create = () => {
    let id = ''
    updateMyMaps((s) => { const r = createMap(s, newName); id = r.id; return r.state })
    setNewName('')
    if (id) onOpen(id)
  }

  return (
    <section className="my-maps">
      <DeviceNote />
      <form className="mm-new" onSubmit={(e) => { e.preventDefault(); create() }}>
        <label className="sr-only" htmlFor="mm-new-name">New map name</label>
        <input id="mm-new-name" value={newName} maxLength={80} placeholder="Name a new map, e.g. Himalayan Trip" onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" className="primary">Create map</button>
      </form>
      {state.maps.length === 0 ? (
        <div className="mm-empty">
          <span aria-hidden="true">🗺️</span>
          <p><strong>No maps yet.</strong></p>
          <p className="muted small">Create a map, then save places with ☆ Save on any place card or Related places row, or drop your own pins.</p>
        </div>
      ) : (
        <ul className="mm-list">
          {state.maps.map((m) => (
            <li key={m.id}>
              <button type="button" className="mm-open" onClick={() => { onOpen(m.id); updateMyMaps((s) => setActive(s, m.id)) }}>
                <span className="mm-swatches" aria-hidden="true">
                  {(m.items.length ? m.items.slice(0, 4) : [{ color: '#d6d0f5', id: 'x' }]).map((i) => <i key={i.id} style={{ background: i.color }} />)}
                </span>
                <span className="res-text">
                  <strong>{m.name}</strong>
                  <span>{m.items.length} {m.items.length === 1 ? 'place' : 'places'} · edited {new Date(m.updatedAt).toLocaleDateString()}</span>
                </span>
                {state.activeId === m.id && <span className="mm-badge" title="New saves go here first">Default</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Backup />
    </section>
  )
}

function DeviceNote() {
  return (
    <p className="mm-device" role="note">
      <span aria-hidden="true">🔒</span>
      <span><strong>Saved on this device only.</strong> Your maps live in this browser and aren't uploaded, so other devices won't see them. Clearing this site's data deletes them; download a backup to keep a copy.
        {!myMapsSaved() && <b className="error"> This browser is blocking storage right now, so changes may not be kept.</b>}</span>
    </p>
  )
}

function OpenMap({ map, onBack, focusId, onFocus, dropping, onDropPin, onShow, onFit, onDirections, myLocation }:
  Omit<Props, 'openId' | 'onOpen'> & { map: MyMap; onBack: () => void }) {
  // The name while you're typing it; null shows the saved name.
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)

  // A pin tapped on the map: bring its entry into view.
  useEffect(() => {
    if (!focusId) return
    listRef.current?.querySelector(`[data-item="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusId])

  const saveName = () => { if (draft?.trim() && draft !== map.name) updateMyMaps((s) => renameMap(s, map.id, draft)); setDraft(null) }

  return (
    <section className="my-maps">
      <button type="button" className="back link" onClick={onBack}>← All my maps</button>
      <label className="mm-title">
        <span className="sr-only">Map name</span>
        <input value={draft ?? map.name} maxLength={80} onChange={(e) => setDraft(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        <span className="mm-edit" aria-hidden="true">✎</span>
      </label>
      <p className="muted small">{map.items.length} {map.items.length === 1 ? 'place' : 'places'} · saved on this device only</p>
      <div className="actions">
        <button type="button" className={`primary${dropping ? ' armed' : ''}`} aria-pressed={dropping} onClick={onDropPin}>
          {dropping ? 'Tap the map to drop it… (cancel)' : '📌 Drop a pin'}
        </button>
        <button type="button" className="secondary" disabled={!map.items.length} onClick={() => onFit(map.items.map((i) => i.coords))}>Show all</button>
      </div>
      {map.items.length === 0 ? (
        <p className="muted small mm-hint">Nothing here yet. Use ☆ Save on a search result or a Related places row, or drop a pin.</p>
      ) : (
        <ul className="mm-items" ref={listRef}>
          {map.items.map((i) => (
            <MapItemRow key={i.id} map={map} item={i} open={focusId === i.id} myLocation={myLocation}
              onToggle={() => { const next = focusId === i.id ? null : i.id; onFocus(next); if (next) onShow(i.coords) }}
              onShow={() => onShow(i.coords)} onDirections={() => onDirections(i)} />
          ))}
        </ul>
      )}
      <div className="mm-danger">
        {confirmDelete ? (
          <p>Delete “{map.name}” and its {map.items.length} places?{' '}
            <button type="button" className="link danger" onClick={() => { updateMyMaps((s) => deleteMap(s, map.id)); onBack() }}>Delete</button>{' · '}
            <button type="button" className="link" onClick={() => setConfirmDelete(false)}>Keep it</button></p>
        ) : (
          <button type="button" className="link danger" onClick={() => setConfirmDelete(true)}>Delete this map</button>
        )}
      </div>
    </section>
  )
}

function MapItemRow({ map, item, open, myLocation, onToggle, onShow, onDirections }:
  { map: MyMap; item: MapItem; open: boolean; myLocation: LngLat | null; onToggle: () => void; onShow: () => void; onDirections: () => void }) {
  const set = (patch: Parameters<typeof updateItem>[3]) => updateMyMaps((s) => updateItem(s, map.id, item.id, patch))
  const title = itemTitle(item)
  const osmUrl = item.osmId?.startsWith('wd:') ? `https://www.wikidata.org/wiki/${item.osmId.slice(3)}`
    : item.osmId ? `https://www.openstreetmap.org/${item.osmId}` : null
  return (
    <li data-item={item.id} className={open ? 'open' : ''} style={{ '--pin': item.color } as CSSProperties}>
      <button type="button" className="mm-item" aria-expanded={open} onClick={onToggle}>
        <span className="mm-dot" aria-hidden="true">{item.icon ?? (item.source === 'pin' ? '📌' : '')}</span>
        <span className="res-text">
          <strong>{title}</strong>
          <span>{item.label && item.label.trim() !== item.name ? `${item.name} · ` : ''}{item.kind ?? SOURCE_TEXT[item.source]}</span>
          {item.note && !open && <span className="mm-note-peek">{item.note}</span>}
        </span>
        {myLocation && <span className="res-dist" title="Straight-line distance from you">{formatDistance(distanceMeters(myLocation, item.coords))}</span>}
      </button>
      {open && (
        <div className="mm-edit-box">
          <label className="field">
            <span>Label</span>
            <input value={item.label ?? ''} maxLength={80} placeholder={item.name} onChange={(e) => set({ label: e.target.value })} />
          </label>
          <div className="field">
            <span>Color</span>
            <div className="mm-colors" role="radiogroup" aria-label="Pin color">
              {PIN_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={item.color === c} aria-label={c} style={{ background: c }}
                  className={item.color === c ? 'on' : ''} onClick={() => set({ color: c })} />
              ))}
            </div>
          </div>
          <label className="field">
            <span>Notes</span>
            <textarea rows={3} maxLength={MAX_NOTE} value={item.note ?? ''} placeholder="Add a note: opening times, who to meet, step-free entrance…"
              onChange={(e) => set({ note: e.target.value })} />
          </label>
          <p className="muted small">{SOURCE_TEXT[item.source]} · {item.coords[1].toFixed(5)}, {item.coords[0].toFixed(5)}
            {item.source === 'pin' && ' · drag the pin on the map to move it'}
            {osmUrl && <> · <a href={osmUrl} target="_blank" rel="noreferrer">Source</a></>}</p>
          <div className="actions">
            <button type="button" className="primary" onClick={onDirections}>Directions</button>
            <button type="button" className="secondary" onClick={onShow}>Show on map</button>
            <button type="button" className="secondary danger" onClick={() => updateMyMaps((s) => removeItem(s, map.id, item.id))}>Remove</button>
          </div>
        </div>
      )}
    </li>
  )
}

function Backup() {
  const [msg, setMsg] = useState<string | null>(null)
  const state = useMyMaps()
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportJson(state)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `bm-locator-my-maps-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const restore = async (f: File | undefined) => {
    if (!f) return
    try {
      const incoming = parseMyMaps(JSON.parse(await f.text()))
      if (!incoming.maps.length) { setMsg('No maps found in that file.'); return }
      updateMyMaps((s) => mergeImport(s, incoming))
      setMsg(`Restored ${incoming.maps.length} ${incoming.maps.length === 1 ? 'map' : 'maps'}.`)
    } catch {
      setMsg("That file isn't a BM Locator maps backup.")
    }
  }
  return (
    <div className="mm-backup">
      <button type="button" className="link" disabled={!state.maps.length} onClick={download}>Download a backup</button>
      <label className="link">Restore from a backup<input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void restore(e.target.files?.[0]); e.target.value = '' }} /></label>
      {msg && <p className="muted small" role="status">{msg}</p>}
    </div>
  )
}
