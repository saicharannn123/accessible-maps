import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { formatDistance } from '../lib/geo'
import { GROUP_LOOK, WHEELCHAIR_LINE, type AnchorKind, type RelatedGroup, type RelatedResult, type RelatedSpot } from '../lib/related'
import type { LngLat } from '../lib/types'

/** What a "Save to map" button needs (the My Maps section provides the button). */
export interface SaveablePlace {
  name: string
  coords: LngLat
  kind?: string
  icon?: string
  source?: 'search' | 'related' | 'pin'
  osmId?: string
}

const KIND_WORD: Record<AnchorKind, string> = { mountain: 'a mountain', park: 'a park', city: 'a city', other: 'this kind of place' }
const SHOW_FIRST = 10

interface Props {
  anchorName: string
  status: 'loading' | 'done' | 'error'
  result: RelatedResult | null
  activeId: string | null
  /** The active spot was picked on the map: scroll its row into view. */
  scrollKey: number
  onActivate: (s: RelatedSpot) => void
  onExplore: (s: RelatedSpot) => void
  onDirections: (s: RelatedSpot) => void
  onRetry: () => void
  saveSlot?: (p: SaveablePlace) => ReactNode
}

/** "Related places": spots linked to the selected place first, then relevant spots nearby. */
export function RelatedPlaces({ anchorName, status, result, activeId, scrollKey, onActivate, onExplore, onDirections, onRetry, saveSlot }: Props) {
  const [showAll, setShowAll] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => setShowAll(false), [result])

  const spots = result?.spots ?? []
  const activeIndex = spots.findIndex((s) => s.id === activeId)
  // A pin tapped on the map may be further down the list: open the list up to it, then scroll there.
  useEffect(() => {
    if (!activeId || !scrollKey) return
    if (activeIndex >= SHOW_FIRST) setShowAll(true)
    const t = window.setTimeout(() => {
      listRef.current?.querySelector(`[data-spot="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 60)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey])

  const shown = showAll ? spots : spots.slice(0, SHOW_FIRST)
  const direct = shown.filter((s) => s.direct)
  const nearby = shown.filter((s) => !s.direct)
  const groups = [...new Set(spots.map((s) => s.group))]

  return (
    <section className="related" aria-labelledby="related-title" ref={listRef}>
      <div className="related-head">
        <h2 id="related-title">Related places</h2>
        {status === 'done' && spots.length > 0 && <span className="muted small">{spots.length} spots</span>}
      </div>

      {status === 'loading' && (
        <div className="related-loading" role="status">
          <span className="spinner" aria-hidden="true" /> Finding spots linked to {anchorName}…
        </div>
      )}
      {status === 'error' && (
        <p className="error" role="alert">Couldn't load related places right now. <button type="button" className="link" onClick={onRetry}>Try again</button></p>
      )}
      {status === 'done' && result && spots.length === 0 && (
        <div className="related-empty">
          <strong>No related spots found</strong>
          <p className="muted small">OpenStreetMap and Wikidata list nothing linked to {anchorName}, and nothing relevant within {formatDistance(result.radius)}. Pick a category below to search around it anyway.</p>
        </div>
      )}
      {status === 'done' && result && spots.length > 0 && (
        <>
          <p className="muted small related-note">
            Distances are straight-line from {anchorName}, not by road or trail. Linked spots come from Wikidata and OpenStreetMap.
            {result.partial && ' One data source did not answer, so the list may be incomplete.'}
          </p>
          {groups.length > 1 && (
            <ul className="related-legend" aria-label="Icon key">
              {groups.map((g) => <li key={g} style={{ '--g': GROUP_LOOK[g].color } as CSSProperties}><span aria-hidden="true">{GROUP_LOOK[g].icon}</span>{GROUP_LOOK[g].label}</li>)}
            </ul>
          )}
          {direct.length > 0 && <>
            <h3 className="related-sub">Linked to {anchorName}</h3>
            <SpotList spots={direct} {...{ activeId, onActivate, onExplore, onDirections, saveSlot }} />
          </>}
          {nearby.length > 0 && <>
            <h3 className="related-sub">Nearby, useful around {KIND_WORD[result.kind]}</h3>
            <SpotList spots={nearby} {...{ activeId, onActivate, onExplore, onDirections, saveSlot }} />
          </>}
          {spots.length > SHOW_FIRST && (
            <button type="button" className="link related-more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${spots.length}`}
            </button>
          )}
        </>
      )}
    </section>
  )
}

function SpotList({ spots, activeId, onActivate, onExplore, onDirections, saveSlot }: Pick<Props, 'activeId' | 'onActivate' | 'onExplore' | 'onDirections' | 'saveSlot'> & { spots: RelatedSpot[] }) {
  return (
    <ul className="related-list">
      {spots.map((s) => {
        const look = GROUP_LOOK[s.group as RelatedGroup]
        const on = s.id === activeId
        return (
          <li key={s.id} data-spot={s.id} className={on ? 'active' : ''}>
            <button type="button" className="related-main" aria-pressed={on} onClick={() => onActivate(s)}>
              <span className="rel-icon" style={{ '--g': look.color } as CSSProperties} aria-hidden="true">{look.icon}</span>
              <span className="res-text">
                <strong>{s.name}</strong>
                <span>{s.kind} · {formatDistance(s.distance)} straight-line</span>
                <span className="rel-reason">{s.reason}</span>
                <span className={`wc wc-${s.wheelchair}`}>{WHEELCHAIR_LINE[s.wheelchair]}</span>
              </span>
            </button>
            {on && (
              <div className="related-actions">
                <button type="button" className="chip" onClick={() => onExplore(s)}>Explore around it</button>
                <button type="button" className="chip" onClick={() => onDirections(s)}>Directions</button>
                {s.osm && <a className="chip" href={`https://www.openstreetmap.org/${s.osm}`} target="_blank" rel="noreferrer">OpenStreetMap</a>}
                {!s.osm && s.wikidata && <a className="chip" href={`https://www.wikidata.org/wiki/${s.wikidata}`} target="_blank" rel="noreferrer">Wikidata</a>}
                {saveSlot?.({ name: s.name, coords: s.coords, kind: s.kind, icon: look.icon, source: 'related', osmId: s.osm ?? (s.wikidata ? `wd:${s.wikidata}` : undefined) })}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
