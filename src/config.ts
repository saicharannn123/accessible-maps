// Central settings for the prototype. PILOT_CITY is where the map opens when
// the browser can't share your location. Change it to move the whole app.
export const PILOT_CITY = {
  name: 'Seattle',
  center: [-122.3321, 47.6062] as [number, number],
  zoom: 15,
}

// Free, keyless map style (OpenFreeMap, built on OpenStreetMap data).
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'

// Free, keyless geocoder built on OpenStreetMap.
export const GEOCODER_URL = 'https://photon.komoot.io/api/'

// The website's name, shown in the header and browser tab.
export const APP_NAME = 'BM Locator'

// Overpass API for nearby places, restrooms, lighting, steps and other OSM details.
// The second server is a backup for when the first is busy.
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
export const OVERPASS_URL = OVERPASS_URLS[0]

// OpenRouteService gives real step-free (wheelchair) routing. It needs a free key:
// sign up at https://openrouteservice.org/dev/#/signup and put it in .env.local as
// VITE_ORS_KEY=your_key
export const ORS_KEY: string | undefined = import.meta.env.VITE_ORS_KEY || undefined
export const ORS_URL = 'https://api.openrouteservice.org/v2/directions'

// Without a key we fall back to plain walking directions and warn about steps ourselves.
export const FALLBACK_FOOT_ROUTER_URL =
  'https://routing.openstreetmap.de/routed-foot/route/v1/foot'

// How long a user report stays on the map before it needs re-confirming.
export const REPORT_LIFETIME_DAYS = 7
