# Accessible Maps

A walking map built for the people Google Maps and Apple Maps leave out: wheelchair users, parents with strollers, older people, and anyone walking at night.

This is the first prototype (version 1). It runs in any browser, including on phones.

## What it does

- **Step-free routes.** Pick a start and a destination, choose a mobility profile (wheelchair, stroller, cane or walker, night walking), and get a route that avoids steps and steep slopes.
- **Warnings along the route.** Steps, raised curbs, problems other people reported, and (for night walking) streets mapped as unlit.
- **Accessible restrooms.** Shown on the map with wheelchair access, fee and changing-table details, plus the nearest accessible restroom to your destination.
- **Street lighting layer.** Lit streets in yellow, unlit streets dashed.
- **Report a problem.** Drop a pin for a broken elevator, blocked sidewalk, missing curb cut or closed restroom. Reports fade after 7 days.
- **Profile.** Save your mobility profile and the steepest slope you can manage. No account needed.

All map data is free and open, from [OpenStreetMap](https://www.openstreetmap.org/) contributors.

## Run it on your computer

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm run dev
```

Then open the address it prints (usually http://localhost:5173).

### Turn on true step-free routing (free)

Without a key, the app uses plain walking directions and warns you about steps it can see. For real wheelchair routing:

1. Sign up for a free key at [openrouteservice.org](https://openrouteservice.org/dev/#/signup).
2. Copy `.env.example` to `.env.local` and paste your key after `VITE_ORS_KEY=`.
3. Restart `npm run dev`.

### Change the pilot city

Edit `PILOT_CITY` in `src/config.ts`. It is set to Seattle as a placeholder because its sidewalk data in OpenStreetMap is good.

## Other commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs the unit tests |
| `npm run lint` | Checks the code for common mistakes |
| `npm run build` | Builds the site into `dist/` for hosting (Vercel, Netlify, GitHub Pages) |

## How it's built

| Part | Tool |
| --- | --- |
| App | React + TypeScript, built with Vite |
| Map | MapLibre GL JS with free OpenFreeMap tiles |
| Search | Photon (OpenStreetMap geocoder) |
| Step-free routing | OpenRouteService wheelchair profile (with a free key), else OSRM walking directions |
| Restrooms, lighting, steps | OpenStreetMap via the Overpass API |
| Problem reports | Saved in your browser for now |

## Known limits of version 1

- Reports are saved only in your own browser. Sharing them with everyone (via Supabase) is the next step.
- How good the routes and warnings are depends on how well OpenStreetMap covers sidewalks, curbs and lighting in your city.
- The free public services used here have rate limits, so this is for testing, not a public launch.
