# Cartographer

A map-first search engine for physical features. Built with React, TypeScript, shadcn/ui, CesiumJS, the provided Titanium renderer, and a Flask API. The application lives at the repository root.

For Coolify, choose the **Docker Compose** build pack, base directory `/`, and `/docker-compose.yaml`. Supply the Google/OpenAI keys and deployment password as runtime variables, and route your HTTPS domain to the `cartographer` service on port 5050. See [the deployment guide](docs/deployment.md) for exact steps and persistent data handling.

`npm run build:release` produces an organized deployment folder at `build/cartographer/` and a distributable `build/cartographer-release.tar.gz`. It includes the compiled `dist/`, source, locked dependencies, Docker/Compose configuration, and deployment instructions. Keys and database/cache contents are excluded. `dist/` remains the client output used by the production server and Docker image.

## Run locally

Prerequisites: Node.js 22.12+ and [uv](https://docs.astral.sh/uv/). The portable MongoDB installer supports Apple silicon and Intel macOS. On other platforms, set `CARTOGRAPHER_MONGOD_PATH` to a compatible local Community `mongod` binary, or set `CARTOGRAPHER_MONGODB_URI` to an existing MongoDB instance.

```sh
git clone https://github.com/FloopyFlop/Cartographer.git
cd Cartographer
npm ci
cp .env.example .env
npm run dev
```

Choose **Sample data** to try the search workflow without provider credentials.
For live searches, add your own Google Maps and OpenAI keys to the private
`.env`, enable Street View Static API, and keep
`CARTOGRAPHER_IMAGERY_PROVIDER=google`. This uses the same Street View imagery,
visual analysis, interface, and caching workflow as the prototype.

Open [Cartographer](http://127.0.0.1:5173). The single npm command starts portable MongoDB, Vite, and the Flask API together. On first start it downloads the pinned official MongoDB Community archive, verifies its SHA-256 checksum, and extracts it inside `.cache/mongodb`. MongoDB data lives in `backend/.cache/mongodb/data` and binds only to localhost on port 27018. There is no system installation, Homebrew service, Docker requirement, or Atlas account. Python dependencies and execution use uv, a backend-local virtual environment, and a local uv cache.

`npm run dev:frontend` and `npm run dev:backend` also run independently; the latter includes MongoDB startup. `npm run dev:db` starts just the portable database, and `npm run db:install` downloads it in advance. The frontend proxies `/api` to the local Flask server on port 5050. Stopping the combined launcher also stops processes it started; an existing database is left running.

## Run the production build

```sh
npm run build
npm start
```

Open [Cartographer's production build](http://127.0.0.1:5050). The launcher starts or reuses portable MongoDB, performs the existing cache migration, and runs [Waitress](https://docs.pylonsproject.org/projects/waitress/en/stable/usage.html). Waitress serves the built React interface, Cesium assets, and Flask API on one port; Vite is not started. Build again after changing frontend files. Starting without a built `dist/index.html` gives a clear setup error.

The default address is `127.0.0.1:5050`. If the development API is already running, choose a separate port with `CARTOGRAPHER_PORT=5051 npm start`. The same backend configuration, actual imagery/vision pipeline, MongoDB caches, and spending ceilings apply in both modes. The database and temporary server files remain inside the project. For server hosting, use the password-protected Docker Compose deployment described in [the Coolify guide](docs/deployment.md).

## Use it

1. Navigate to a place. The location dialog includes Duffield Hall, Cornell, Ithaca, New York, London, and San Francisco. Submit another place or address to use Google location search when the backend key has the Geocoding API enabled. Local suggestions are free and remain available without credentials.
2. Choose a radius from 25 meters to 50 kilometers, the visible map, two opposite corners of a region, or a route corridor. Click the map to place geographic selections; route drawing has an explicit Done action.
3. Describe a feature in natural language and select **Search this area**. Command/Ctrl + Enter starts a search; Command/Ctrl + K opens location search.
4. Watch results arrive, select a marker or list row, inspect its source photograph, hide layers, or export GeoJSON. New searches retain your geographic view and existing layers.

The map defaults to a neutral dark style and an angled 3D globe. **Map view** opens real cel-shading and 2D/3D controls. The actual provided Titanium viewer and shaders are included under `src/vendor/titanium`, with their MIT license; they have not been recreated.

## Real searches and sample layers

**Automatic** uses live imagery when both the configured imagery source and OpenAI are available; otherwise it falls back to explicitly marked Cornell samples. **Street View search** defaults to Google Street View Static API photographs and real `gpt-4.1` visual analysis for this local prototype. Searches use up to **16 images by default**, configurable from **4 to 48**. Street View panoramas are inspected at four compass headings, within the selected image limit. Looking around sampled cameras does not establish complete coverage of the selected geographic area.

Imagery acquisition and visual analysis are separate stages. New object queries can reuse available source views; OpenAI then analyzes the requested feature, or reuses the matching per-image analysis cache. Source frames remain inspectable when a photograph contains no detections. Candidates require visible structural evidence and a normalized image bounding box, shown on selection. The pipeline's imagery acquisition and model calls are real; **Sample data** is the explicit synthetic mode.

Set `CARTOGRAPHER_IMAGERY_PROVIDER=panoramax` to use the optional publicly accessible [Panoramax](https://docs.panoramax.fr/how-to-contribute/use-panoramax/) source. It needs no imagery token and retains each photograph's attribution and license. Owned or separately licensed images can also be supplied through a manifest.

Results are explicitly **unverified visual matches** and mark the **camera position**, not an independently measured object position. Models can still make mistakes; review the source photograph. An empty result means the sampled images did not establish a match; it does not establish that a feature is absent. The model does not certify wheelchair accessibility.

**Sample data** uses synthetic Cornell fixtures for bicycle racks, benches, curb ramps, crosswalks, fountains, and accessible entrances. They exercise progressive delivery, spatial filtering, layer selection, and empty states without calling paid providers.

The structured area is authoritative. Natural language is passed intact to visual analysis; object classification is returned separately. The prototype does not silently navigate or change an area mentioned inside a query.

## Credentials, caching, and spending

The backend reads `.env` first and supports `backend/.env` as a fallback. For a new setup, copy `.env.example` to `.env`, set your own `GOOGLE_MAPS_API_KEY` and `OPENAI_API_KEY`, and keep `CARTOGRAPHER_IMAGERY_PROVIDER=google`. Enable Street View Static API on the Google project, and enable Geocoding API for arbitrary Google location navigation. Credentials are read only by Flask, never bundled into React. Private environment files, image caches, MongoDB files, backups, and local demo recordings are ignored by Git.

The persistent ledger fixes this instance's ceilings at **$4 Google** and **$2 OpenAI**. Every paid call reserves conservative headroom atomically before sending; reservations survive timeouts and restarts. OpenAI calls have no automatic retries. Usage is available through **Usage & sources** in the application.

These are application-side ceilings, based on documented pricing, not provider-account limits. They cannot constrain another application using the same keys. A default 16-image Google search can reserve up to $0.16 of Google and $0.64 of OpenAI across its individual requests before actual usage is reconciled; cached views and analyses avoid their respective paid calls. Selecting Panoramax avoids Google imagery charges.

The local MongoDB `cartographer` database stores job snapshots, completed-run and per-image analysis caches, imagery discovery, source references, and the spending ledger. A provider's totals and reservations live in one document, so atomic spending enforcement works on a portable standalone server. Repeating a completed request reuses its analysis with no new paid requests; concurrent identical requests share one job. Source/model/prompt/sampling changes invalidate cache keys. Do not remove the database to refresh results: doing so also removes spend accounting.

Submitted Google location queries share the same Google spending ledger: each reserves $0.01 and records a conservative $0.005 after a successful response. MongoDB reuses the result for 24 hours and expires it automatically. Typing local suggestions does not call Google, and missing Geocoding API access produces a useful error rather than a fabricated place. An explicitly configured Nominatim-compatible endpoint remains available as an alternative.

Google photograph bytes stay in a bounded server-memory buffer for up to **10 minutes** and disappear on restart. They are not written to MongoDB or image files. The preview endpoint serves only already-fetched bytes with `Cache-Control: no-store`; opening it never initiates another Google request. An expired preview returns HTTP 410, while the cached analysis and key-free **Google Maps viewer link** remain available. The buffer holds at most 64 images or 32 MiB, so a preview may become unavailable sooner when it fills. Optional Panoramax photos are stored under `backend/.cache/images` with their attribution and individual licenses in MongoDB. Preserve the database, and those licensed photo files when used, when moving the project.

If the earlier prototype's SQLite file exists, the launcher performs a one-time, read-only import into MongoDB before starting the API. It preserves previous jobs, cached analyses, images, and paid or uncertain usage. The old file remains available as a backup; active storage is MongoDB.

Google is enabled as the requested local prototype source without a software permission flag. That implementation choice and the user's authorization do not establish a legal exemption or grant reuse rights. Google's standard terms restrict deriving an object index from Street View and displaying its imagery alongside non-Google maps; temporary pixels do not resolve those restrictions. Education and accessibility do not automatically create an exception. See the [documented source terms and alternatives](docs/imagery-sources.md#google-street-view-and-separately-licensed-imagery).

See [imagery investigation](docs/imagery-sources.md) and [backend configuration](backend/README.md).

## Architecture

- `src/App.tsx`: workflow, geographic selection, and responsive workspace.
- `src/components/ui`: installed shadcn components, using one neutral design system.
- `src/components/search`, `results`, `layout`: conventional React interface.
- `src/components/map/MapCanvas.tsx`: React/Cesium lifecycle boundary.
- `src/map`: camera, geographic tools, area visualization, incremental marker updates, clustering, and selection.
- `src/vendor/titanium`: provided Cesium renderer and original cel/edge shaders.
- `src/types`: extensible area, search, layer, detection, metadata, and imagery models.
- `src/services/api.ts`: typed API boundary, structured errors, validation, cancellation, and timeouts.
- `src/hooks/useSearches.ts`: progressive polling, retry/backoff, retained layers, cancellation, and race protection.
- `backend/cartographer`: Flask endpoints, spatial validation, asynchronous workers, sample/live providers, durable caching, and budgets.

The UI is inspired by SkyShadow's Geist typography, neutral dark surfaces, soft borders, and rounded shadcn controls. Only neutral colors are used.

The map opens in Cesium 3D with an angled camera and Titanium's supplied cel/edge shaders. The primary dark basemap uses [OpenFreeMap](https://openfreemap.org/) vector geometry and labels, rendered into 1024 px Cesium textures at each requested zoom level, up to level 22. Two reusable MapLibre renderers and a 32 MiB pixel cache limit adapter overhead. This preserves close-zoom sharpness without another provider key or paid map calls. Initial vector and font loading can take a few seconds. The ellipsoid globe has no terrain or 3D building dataset configured.

Visible corner credits identify the current map provider and linked OpenMapTiles/OpenStreetMap attribution. The public dark style is adapted to remove missing decorative sprite references; its [license](src/vendor/titanium/OpenFreeMap-Dark-LICENSE.md) and design credit are retained. If vector rendering fails, the map switches to the Esri dark raster base and reference labels; that fallback retains its native zoom-16 detail limit.

The backend uses one process with bounded job concurrency and persistent snapshots. The local launcher binds to localhost; the Docker deployment serves through Waitress with shared password protection. Organization accounts or multiple replicas would require account-scoped permissions and budgets, a durable worker queue, and shared cancellation/single-flight coordination.

## API

| Request | Purpose |
| --- | --- |
| `GET /api/health` | Availability and imagery provider |
| `GET /api/locations?q=...` | Free local location suggestions; add `remote=1` for a submitted Google or configured geocoder search |
| `POST /api/searches` | Start `{query, area, mode}` and return a job |
| `GET /api/searches/:id` | Progressive status and detections |
| `DELETE /api/searches/:id` | Cancel before further paid calls; already-sent requests may finish |
| `GET /api/imagery/:id` | Temporary Google preview or registered licensed source imagery |
| `POST /api/searches/:id/imagery/:frameId` | Reload a recorded Google preview within the remaining budget, without repeating vision |
| `GET /api/usage` | Spending, reservations, ceilings, and live availability |

Search areas cover radius, viewport/rectangle bounds, and routes with a corridor width expressed as distance **either side**. The job contract supports queued, running, completed, cancelled, and failed states. Backend errors have a consistent `{error:{code,message}}` shape.

## Check the application

```sh
npm run build
npm test
npm run test:backend
npm audit
```

These checks make no paid provider requests. A manually invoked `node scripts/smoke-live.mjs` performs a bounded real search and verifies the repeated-run cache; it can spend a small amount of the local Google and OpenAI budgets with the default source and is deliberately excluded from automated tests.

Browser checks cover the dark desktop/mobile layout, sample search progression, selection, layer controls, geographic drawing, location navigation, map appearance, and usage dialog. The supplied `.gitignore` excludes browser artifacts.

## Contributions and third-party materials

Cartographer is licensed under [MIT](LICENSE), copyright 2026 Cartographer
contributors. Third-party software, imagery, map data, and remote services
retain their own licenses and terms.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and
[SECURITY.md](SECURITY.md) for private vulnerability reports and credential
handling. Use your own runtime credentials; no keys, database backups, cached
imagery, or local recordings are included in this repository or its release.

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) identifies the supplied Titanium
source, map style, copied interface components, fonts, and dependencies. Every
build preserves their original license texts in `dist/licenses/`, including in
Docker and release bundles. Imagery, map data, and remote services retain their
separate licenses and terms.
