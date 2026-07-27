# Safety Planner

Downloads, indexes, and visualizes footage/GPS data from a DDPAI dashcam.
Protocol client in `apps/poller` is ported from
[hansaya/ddpai_downloader](https://github.com/hansaya/ddpai_downloader) (MIT).

## Structure

- `apps/web` — Vite/React dashboard: connection status, recordings, journeys/map (Leaflet + OSM), live vehicle tracking (`/live`)
- `apps/poller` — Node/TS service that polls the camera's CGI API, downloads files to `storage/`, and writes metadata into Convex
- `convex/` — Convex schema and functions (shared backend)
- `storage/` — local file storage for videos/thumbnails/GPS files (S3 migration to be reviewed later)

## First-time setup

```bash
npm install
npx convex dev   # interactive login; provisions a dev deployment and generates convex/_generated
```

Copy `.env.example` to `.env` in both `apps/web` and `apps/poller`, filling in the
`CONVEX_URL` / `VITE_CONVEX_URL` printed by `npx convex dev`, and your camera's
`CAM_URL` (default `http://193.168.0.1`).

## Running

```bash
npm run dev:convex    # keep running: syncs schema/functions
npm run dev:web       # Vite dev server
npm run dev:poller    # camera polling + download loop
```

## Running with Docker

`docker-compose.yaml` builds and runs web (nginx-served static build),
poller, and mqtt-ingest. Convex stays external (dev deployment or cloud),
reached via `CONVEX_URL`.

```bash
cp .env.example .env   # fill in Convex/Clerk/MQTT values
docker compose up -d --build
```

Notes:

- The web `VITE_*` values are **build** args (Vite inlines them into the
  bundle) — changing them needs `docker compose build web`, not a restart.
- `storage/` is bind-mounted into poller and mqtt-ingest; Docker Desktop
  must have this repo's path under Settings → Resources → File Sharing.
- To reach services on the host Mac from inside a container (local
  `npx convex dev`, local broker), use `host.docker.internal`, not
  `localhost`.

## Known gaps / next steps

- GPS sidecar file format is undocumented upstream — treated as an opaque
  blob for now. Needs a spike against a real camera sample to reverse-engineer
  the format before `gpsFixes` can be populated and journeys/map rendering
  becomes meaningful.
- Journey derivation (grouping recordings + GPS fixes into trips) isn't
  implemented yet — depends on the GPS spike above.
- Event classification (impact vs. parking vs. manual) currently defaults to
  `"other"`; the camera's event API response likely carries a type field to
  map once samples are available.
