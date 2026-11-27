import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as maplibregl from 'maplibre-gl'
import { loadBaseStyle } from './MapView'
import type { MapStyleId } from '../config'
import { postalCodeName } from '../lib/address'
import type { DetailTarget, PlaceFacts } from '../lib/details'
import { openStatus } from '../lib/hours'
import type { Wheelchair } from '../lib/places'
import { safeWebUrl, telHref } from '../lib/safeUrl'
import type { LngLat } from '../lib/types'

const ACCESS_LINE: Record<Wheelchair, string> = {
  yes: '♿ Wheelchair accessible',
  limited: '♿ Partly wheelchair accessible',
  no: 'Not wheelchair accessible',
  unknown: 'Accessibility unknown',
}

interface Props {
  target: DetailTarget
  /** Null while the lookup for this target is still running. */
  facts: PlaceFacts | null
  mapLook: MapStyleId
  now: Date
  /** e.g. "Selected place" or "Related place". */
  kicker?: string
  /** A small line above the card, e.g. "← All results". */
  back?: ReactNode
  onClose?: () => void
  onDirections: () => void
  onShowOnMap: () => void
  save: ReactNode
  /** Extra links under the details (related places, edit on OpenStreetMap). */
  footer?: ReactNode
}

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

/** The details card for one selected place: photo (or map preview), overview, details and actions. */
export function PlaceDetails({ target, facts, mapLook, now, kicker = 'Selected place', back, onClose, onDirections, onShowOnMap, save, footer }: Props) {
  const loading = facts == null
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const photo = facts?.photo && facts.photo.src !== failedSrc ? facts.photo : undefined
  const kind = facts?.kind ?? target.kind
  const street = facts?.street ?? target.street
  const area = facts?.area ?? target.area
  const oneLine = !street && !area ? target.address : undefined
  const postcode = facts?.postcode ?? target.postcode
  const country = facts?.country ?? target.country
  const hours = facts?.hours ?? target.hours
  const status = openStatus(hours, now)
  const website = facts?.website ?? safeWebUrl(target.website)
  const phone = facts?.phone ?? target.phone
  const wc: Wheelchair = facts?.wheelchair ?? target.wheelchair ?? 'unknown'
  const isAddress = kind === 'Address' || (!kind && !!street && target.name === street)
  const showName = target.name

  return (
    <article className="place-card details-card" aria-busy={loading} aria-labelledby="details-title">
      {back && <div className="details-back">{back}</div>}
      <div className="details-media">
        {loading ? (
          <div className="details-photo skeleton" role="status" aria-label="Loading place details" />
        ) : photo ? (
          <figure className="details-figure">
            <img key={photo.src} className="details-photo" src={photo.src} alt={`Photo of ${showName}`} referrerPolicy="no-referrer"
              onError={() => setFailedSrc(photo.src)} />
            <figcaption className="photo-credit">
              Photo: <a href={photo.page} target="_blank" rel="noreferrer">{photo.author}</a>
              {photo.license && <> · {photo.licenseUrl ? <a href={photo.licenseUrl} target="_blank" rel="noreferrer">{photo.license}</a> : photo.license}</>}
              {' '}· Wikimedia Commons
            </figcaption>
          </figure>
        ) : (
          <div className="details-nophoto">
            <MiniMap at={target.coords} look={mapLook} />
            <span className="nophoto-badge">No photo available</span>
          </div>
        )}
        {onClose && <button type="button" className="pin-close" aria-label="Clear the selected place" onClick={onClose}>✕</button>}
      </div>

      <div className="details-body">
        <span className="selected-kicker">{kicker}</span>
        <h2 id="details-title">{target.icon ? <span aria-hidden="true">{target.icon} </span> : null}{showName}</h2>
        {kind && <span className="details-kind">{kind}</span>}

        <div className="details-address">
          {street && street !== showName && <p>{street}</p>}
          {area && <p>{area}</p>}
          {oneLine && <p>{oneLine}</p>}
          {!street && !area && !oneLine && !loading && <p className="muted small">No street address listed</p>}
          {postcode && showName !== postcode && (
            <p className="postal-line"><span aria-hidden="true">📮 </span>{postalCodeName(country)} <strong>{postcode}</strong></p>
          )}
        </div>

        {loading ? (
          <div className="details-lines" aria-hidden="true"><span className="skeleton line" /><span className="skeleton line short" /></div>
        ) : facts.about ? (
          <p className="details-about">
            {facts.about.text}{' '}
            <span className="about-source">
              Source: {facts.about.url ? <a href={facts.about.url} target="_blank" rel="noreferrer">{facts.about.source}</a> : facts.about.source}
            </span>
          </p>
        ) : isAddress ? (
          <p className="muted small">No public place information is listed for this address.</p>
        ) : null}

        <dl className="details-facts">
          <div>
            <dt><span aria-hidden="true">🕒</span> Hours</dt>
            <dd>
              {status ? <><b className={status.open ? 'is-open' : 'is-closed'}>{status.open ? 'Open' : 'Closed'}</b>{status.detail !== 'Closed' && <> · {status.detail}</>}</> : null}
              {hours ? <span className="muted small hours-raw">{hours}</span> : loading ? <span className="skeleton line short" /> : <span className="muted">Not listed</span>}
            </dd>
          </div>
          {(website || loading) && (
            <div>
              <dt><span aria-hidden="true">🌐</span> Website</dt>
              <dd>{website ? <a href={website} target="_blank" rel="noreferrer">{host(website)}</a> : <span className="skeleton line short" />}</dd>
            </div>
          )}
          {phone && telHref(phone) && (
            <div>
              <dt><span aria-hidden="true">📞</span> Phone</dt>
              <dd><a href={telHref(phone)}>{phone}</a></dd>
            </div>
          )}
          <div>
            <dt><span aria-hidden="true">♿</span> Access</dt>
            <dd>
              {loading && !target.wheelchair ? <span className="skeleton line short" /> : <>
                <span className={`wc wc-${wc}`}>{ACCESS_LINE[wc]}</span>
                {wc === 'unknown' && <span className="muted small"> · not yet verified</span>}
                {facts?.wheelchairNote && <span className="muted small access-note">{facts.wheelchairNote}</span>}
                {facts?.toiletsWheelchair === 'yes' && <span className="muted small access-note">Accessible restroom</span>}
              </>}
            </dd>
          </div>
        </dl>

        <div className="actions">
          <button type="button" className="primary" onClick={onDirections}>Directions</button>
          <button type="button" className="secondary" onClick={onShowOnMap}>Show on map</button>
          {save}
        </div>
        {facts?.partial && <p className="muted small">Some details couldn't be loaded right now.</p>}
        <p className="muted small details-coords">{target.coords[1].toFixed(5)}, {target.coords[0].toFixed(5)}</p>
        {footer}
      </div>
    </article>
  )
}

/** A small, still map centered on the pin, for places without a confirmed photo. */
function MiniMap({ at, look }: { at: LngLat; look: MapStyleId }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const marker = useRef<maplibregl.Marker | null>(null)
  const atRef = useRef(at)
  atRef.current = at

  useEffect(() => {
    let gone = false
    loadBaseStyle(look).then((style) => {
      if (gone || !box.current) return
      try {
        const m = new maplibregl.Map({
          container: box.current, style, center: atRef.current, zoom: 16, interactive: false,
          attributionControl: { compact: true },
        })
        const el = document.createElement('div')
        el.className = 'mini-pin'
        marker.current = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(atRef.current).addTo(m)
        map.current = m
        // The card may still be settling its size when the map starts.
        m.once('load', () => { m.resize(); m.jumpTo({ center: atRef.current }) })
      } catch {
        // No WebGL: the badge alone still says there's no photo.
      }
    })
    return () => { gone = true; map.current?.remove(); map.current = null; marker.current = null }
  }, [look])

  const [lng, lat] = at
  useEffect(() => {
    map.current?.jumpTo({ center: [lng, lat] })
    marker.current?.setLngLat([lng, lat])
  }, [lng, lat])

  return <div ref={box} className="mini-map" role="img" aria-label="Map preview of the selected spot" />
}
