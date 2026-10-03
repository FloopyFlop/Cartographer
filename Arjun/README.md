# Cartographer

A map-first search engine for physical features. Built with React, TypeScript, shadcn/ui, CesiumJS, the provided Titanium renderer, and a Flask API. All application files live in this `Arjun` directory.

## Run locally

Prerequisites: Node.js 22.12+ and [uv](https://docs.astral.sh/uv/). The portable MongoDB installer supports Apple silicon and Intel macOS. On other platforms, set `CARTOGRAPHER_MONGOD_PATH` to a compatible local Community `mongod` binary, or set `CARTOGRAPHER_MONGODB_URI` to an existing MongoDB instance.

```sh
cd /Users/abm/XVOL/ABM/Projects/Code/Cartographer/Arjun
npm ci
npm run dev
```

Open [Cartographer](http://127.0.0.1:5173). The single npm command starts portable MongoDB, Vite, and the Flask API together. On first start it downloads the pinned official MongoDB Community archive, verifies its SHA-256 checksum, and extracts it inside `Arjun/.cache/mongodb`. MongoDB data lives in `backend/.cache/mongodb/data` and binds only to localhost on port 27018. There is no system installation, Homebrew service, Docker requirement, or Atlas account. Python dependencies and execution use uv, a backend-local virtual environment, and a local uv cache.

`npm run dev:frontend` and `npm run dev:backend` also run independently; the latter includes MongoDB startup. `npm run dev:db` starts just the portable database, and `npm run db:install` downloads it in advance. The frontend proxies `/api` to the local Flask server on port 5050. Stopping the combined launcher also stops processes it started; an existing database is left running.

## Use it

1. Navigate to a place. The location dialog includes Cornell, Ithaca, New York, London, and San Francisco. An administrator can connect a compatible geocoder for more places.
2. Choose a radius, the visible map, two opposite corners of a region, or a route corridor. Click the map to place geographic selections; route drawing has an explicit Done action.
3. Describe a feature in natural language and select **Search this area**. Command/Ctrl + Enter starts a search; Command/Ctrl + K opens location search.
4. Watch results arrive, select a marker or list row, inspect its source photograph, hide layers, or export GeoJSON. New searches retain your geographic view and existing layers.

The map defaults to a neutral dark style. **Titanium** opens real cel-shading and 2D/3D controls. The actual provided Titanium viewer and shaders are included under `src/vendor/titanium`, with their MIT license; they have not been recreated.

## Real searches and sample layers

**Automatic** uses live imagery when both the configured imagery source and OpenAI are available; otherwise it falls back to explicitly marked Cornell samples. **Live imagery** defaults to Google Street View Static API photographs and `gpt-4.1` visual analysis for this local prototype. The default search inspects at most four photographs. Candidates require visible structural evidence and a normalized image bounding box, shown on selection. This prototype does not perform an exhaustive survey.

Set `CARTOGRAPHER_IMAGERY_PROVIDER=panoramax` to use the optional publicly accessible [Panoramax](https://docs.panoramax.fr/how-to-contribute/use-panoramax/) source. It needs no imagery token and retains each photograph's attribution and license. Owned or separately licensed images can also be supplied through a manifest.

Results are explicitly **unverified visual matches** and mark the **camera position**, not an independently measured object position. Models can still make mistakes; review the source photograph. An empty result means the sampled images did not establish a match; it does not establish that a feature is absent. The model does not certify wheelchair accessibility.

**Sample layers** uses synthetic Cornell fixtures for bicycle racks, benches, curb ramps, crosswalks, fountains, and accessible entrances. They exercise progressive delivery, spatial filtering, layer selection, and empty states without calling paid providers.

The structured area is authoritative. Natural language is passed intact to visual analysis; object classification is returned separately. The prototype does not silently navigate or change an area mentioned inside a query.

## Credentials, caching, and spending

Copy `backend/.env.example` to `backend/.env`. For the default Google prototype, set `GOOGLE_MAPS_API_KEY` and `OPENAI_API_KEY`, enable the Street View Static API on the Google project, and keep `CARTOGRAPHER_IMAGERY_PROVIDER=google`. Credentials are read only by Flask, never bundled into React. The local configured `.env`, licensed image files, MongoDB binaries, and database files are ignored by Git.

The persistent ledger fixes this instance's ceilings at **$4 Google** and **$2 OpenAI**. Every paid call reserves conservative headroom atomically before sending; reservations survive timeouts and restarts. OpenAI calls have no automatic retries. Usage is available through **Usage & sources** in the application.

These are application-side ceilings, based on documented pricing, not provider-account limits. They cannot constrain another application using the same keys. A four-image Google search reserves at most $0.04 of Google and $0.16 of OpenAI headroom before actual usage is reconciled. Selecting Panoramax avoids Google imagery charges.

The local MongoDB `cartographer` database stores job snapshots, completed-run and per-image analysis caches, imagery discovery, source references, and the spending ledger. A provider's totals and reservations live in one document, so atomic spending enforcement works on a portable standalone server. Repeating a completed request reuses its analysis with no new paid requests; concurrent identical requests share one job. Source/model/prompt/sampling changes invalidate cache keys. Do not remove the database to refresh results: doing so also removes spend accounting.

Google photograph bytes stay in a bounded server-memory buffer for up to **10 minutes** and disappear on restart. They are not written to MongoDB or image files. The preview endpoint serves only already-fetched bytes with `Cache-Control: no-store`; opening it never initiates another Google request. An expired preview returns HTTP 410, while the cached analysis and key-free **Google Maps viewer link** remain available. The buffer holds at most 32 images or 16 MiB, so a preview may become unavailable sooner when it fills. Optional Panoramax photos are stored under `backend/.cache/images` with their attribution and individual licenses in MongoDB. Preserve the database, and those licensed photo files when used, when moving the project.

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

The backend is intended for one trusted local process. It binds to localhost, has bounded job concurrency, and uses a thread pool with persistent snapshots. Shared deployment would need authentication, a production WSGI server, a durable worker queue, shared cancellation/single-flight coordination, and account-scoped budgets.

## API

| Request | Purpose |
| --- | --- |
| `GET /api/health` | Availability and imagery provider |
| `GET /api/locations?q=...` | Local location search; configured remote search is explicit |
| `POST /api/searches` | Start `{query, area, mode}` and return a job |
| `GET /api/searches/:id` | Progressive status and detections |
| `DELETE /api/searches/:id` | Cancel before further paid calls; already-sent requests may finish |
| `GET /api/imagery/:id` | Temporary Google preview or registered licensed source imagery |
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
