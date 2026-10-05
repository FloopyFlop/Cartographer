# Cartographer API

Flask provides the search boundary for the React/Cesium client. The recommended
launcher, run from the repository root, starts the project-local portable MongoDB server,
performs any legacy-cache migration, and starts the API:

```sh
npm run dev:backend
```

`npm run dev` also starts the React client. For API-only execution with MongoDB
already running, use this backend directory:

```sh
uv sync
uv run python -m cartographer.migrate
uv run python -m cartographer
```

The API listens on `127.0.0.1:5050`. The frontend proxies `/api` to this address.
`CARTOGRAPHER_HOST` and `CARTOGRAPHER_PORT` override the address. The development
launcher disables the Flask reloader so it cannot duplicate search workers.

Run the deterministic tests with the local MongoDB running, without any external
imagery or paid model requests:

```sh
uv run pytest -q
```

## Search behavior

Environment templates and existing installations use **Google Street View**.
Sample mode runs without provider credentials; live searches need your own
Google Maps and OpenAI keys. Provider imagery and service terms remain separate
from Cartographer's MIT code license.

- `auto` uses real visual analysis when an OpenAI key and a supported imagery
  provider are available. Otherwise it uses the clearly labeled demonstration
  provider.
- `live` requires a configured imagery and vision provider and returns a failed
  job with a useful explanation when unavailable.
- `precomputed` loads the finite synthetic Cornell sample layers. These samples
  are illustrative locations, not surveyed assets or actual vision results.

The default live imagery source for this local prototype is **Google Street
View Static API**. The acquisition service adapts the shared backend's panorama
workflow while retaining real OpenAI analysis, injected credentials, bounded
spending, and memory-only Google images. It first probes the exact selected
center, then surrounding positions, with at most twelve free metadata lookups.
The default source includes available pedestrian panoramas. Each distinct
camera is inspected in four cardinal directions (0°, 90°, 180°, 270°), with a
90° field of view. Searches analyze **16 successful views by default**; the user
may choose **4–48**. Missing imagery, duplicate cameras, and rejected distant
cameras do not consume the successful-image allowance.

A small landmark area can use a camera up to **250 meters outside its boundary**
to inspect nearby streets. This does not resize the user's selection or establish
that an observed object lies inside it. Frames and detections retain their real
camera position, `cameraInSearchArea`, `distanceToSearchAreaMeters`, and
`objectInSearchArea: "unknown"`. Camera positions are approximations, not object
coordinates. Every successfully analyzed view appears in `frames`, including
views with zero detections, so users can inspect what the model actually saw.
Neither completion nor zero detections implies comprehensive coverage.

Google source pixels stay in memory only. A temporary, opaque
`/api/imagery/google-<id>` preview serves the already-fetched pixels without
another provider request. Previews expire after ten minutes and are bounded to
64 entries, 32 MiB total, and 5 MiB per image. Responses use
`Cache-Control: no-store`. An expired or unavailable preview returns HTTP 410
with `error.code = "imagery_expired"`; its key-free Google Maps viewer reference
remains available. Changing the object query can reuse an unexpired camera view
without another Google image charge. Completed job-cache hits do not refresh
expired pixels or make new paid calls.

An explicit preview reload uses
`POST /api/searches/<jobId>/imagery/<frameId>` and returns `{imageUrl}`. It can
reload only a Google camera view already recorded in that job, including a
legacy detection's saved preview ID. An available in-memory view is reused
free; an expired view requires one Google image request under the existing
spending cap. It never reruns visual analysis or rewrites the saved search.
Simultaneous reloads share one image request. Missing recorded frames return
404; non-Google or incomplete references return 409. Uncertain requests retain
their spending reservation, and the original Google viewer link remains an
alternative to refetching pixels.

**Panoramax** remains an alternative configured with
`CARTOGRAPHER_IMAGERY_PROVIDER=panoramax`. Its search discovers at most
100 candidate street photos per tile, across at most **4 metadata probes**, and chooses up to the per-search limit of **spatially
dispersed images**. It retains only photos whose individual licenses permit the
implemented use. It filters camera positions against the actual radius,
rectangle, or route corridor before analyzing them. This is a sparse sample;
neither no detections nor a completed search implies comprehensive coverage.
Discovery prioritizes a center tile and then probes the remaining bounding
area so a dense road at a rectangle's corner cannot consume the whole candidate
sample. Empty discovery reports that the bounded sample found no matching
imagery, rather than claiming that the area has no street-photo coverage.

The OpenAI Responses API uses `gpt-4.1`, a strict JSON schema, images
downscaled to a maximum of 1024 × 1024 pixels, and at most 1200 output tokens.
Automatic SDK retries are disabled. The model describes visible matches and
cannot return invented geographic coordinates. Each result uses its source
camera location, with `metadata.positionAccuracy = "camera-location"` and
`uncertaintyMeters = 50`. Results remain unverified. Visual appearance alone
does not establish accessibility certification.
Candidates require concrete `visualEvidence` and a normalized
`imageBoundingBox`, retained in detection metadata for inspection. Low-confidence
proposals are omitted. These measures improve inspectability; they do not prove
that a candidate is correct or make the model's confidence a calibrated measure.
Named buildings require readable identifying signs or distinctive features supplied
by the user; camera proximity alone is insufficient for a name match.

## Configuration

Create a private, gitignored `.env` in this backend directory. Keys remain on
the server and are never returned by the API:

```dotenv
OPENAI_API_KEY=your_key
GOOGLE_MAPS_API_KEY=your_google_key
CARTOGRAPHER_IMAGERY_PROVIDER=google
CARTOGRAPHER_MAX_IMAGES=48
CARTOGRAPHER_MONGODB_URI=mongodb://127.0.0.1:27018
CARTOGRAPHER_MONGODB_DATABASE=cartographer
```

The model is deliberately fixed to GPT-4.1 so the request envelope and
spending estimate remain consistent. `CARTOGRAPHER_MAX_IMAGES` sets the server
ceiling, clamped to 1–48; its default is 48. Each search supplies
`configuration.maxImages` between 4 and 48, defaulting to 16; the effective
limit cannot exceed the server ceiling. Setting `CARTOGRAPHER_IMAGERY_PROVIDER=none` disables
remote imagery and leaves demonstration mode available.

The portable launcher downloads its pinned official MongoDB Community binary
into `.cache/mongodb` and keeps database files in
`backend/.cache/mongodb/data`. It binds to localhost on port 27018 and requires
no system service, Homebrew installation, Docker, or Atlas account. The API
reads `CARTOGRAPHER_MONGODB_URI` and `CARTOGRAPHER_MONGODB_DATABASE` when using
another MongoDB instance. `CARTOGRAPHER_CACHE_DIRECTORY` optionally changes the
image-cache directory; its default is this backend's `.cache`.

Owned or separately licensed imagery can be supplied in
`.cache/imagery-manifest.json`, or at `CARTOGRAPHER_IMAGERY_MANIFEST`. This
administrator-authored manifest contains records like:

```json
[
  {
    "id": "campus-path-1",
    "position": {"longitude": -76.483, "latitude": 42.4483},
    "path": "images/campus-path-1.jpg",
    "heading": 180,
    "capturedAt": "2026-09-01T12:00:00Z",
    "attribution": "Photo provided by its owner"
  }
]
```

Relative image paths resolve from the manifest directory. Supplying a nonempty
manifest makes these photos the live source. `GET /api/imagery/<id>` serves only
registered source images, never arbitrary caller-provided file paths.

Google Street View requires `GOOGLE_MAPS_API_KEY`, with the Street View Static
API enabled, and the OpenAI key for analysis. Keys stay on the backend.
Source references and temporary preview URLs contain no API keys. The selected
provider is returned as `imageryProvider` by `/api/usage`.

## Persistent cache and spending limits

The actual MongoDB `cartographer` database contains every job snapshot, completed run cache,
validated per-image vision results, open-imagery discovery records, source-image
licenses, and the spending ledger. Panoramax source images are stored in
`.cache/images/` with original attribution and license metadata. Returned
detection metadata retains the source license as its output license. Google
image bytes are never written to MongoDB or disk. Google panorama IDs, headings,
capture dates, camera positions, and the application's job/detection records
can persist; preview pixels are held only in the bounded temporary memory cache.

Collections are `jobs`, `vision_cache`, `source_queries`, `source_images`, `location_queries`,
`panorama_ids`, `budgets`, and `migrations`. Source-image paths under the cache
directory are stored relative to that directory so the project can be moved.
Preserve both MongoDB's data directory and `.cache/images` when moving it.

If the original `.cache/cartographer.sqlite3` exists, the launcher runs
`uv run python -m cartographer.migrate` before the API starts. This is a one-time,
read-only import format, not an active storage engine. The migration copies old
jobs, per-image analyses, discovery, image references, charged usage, and unknown
reservations to MongoDB. It leaves the old file intact. Per-provider atomic
import markers prevent repeated or interrupted migration from double-counting
legacy spending; imports add to any existing MongoDB spending without resetting
it. Cache-model and prompt changes still invalidate reuse normally while
preserving the earlier results in history.

Completed identical searches reuse the same job without another imagery or
vision call. The run key includes the normalized query, geographic geometry,
source, model, prompt version, and sampling configuration; display labels are
excluded. Owned-image content hashes invalidate completed runs when photos
change. Concurrent identical requests share one running job. Different searches
of an identical image/query/model also reuse its validated vision result.

The fixed local ceilings are **$4 for Google** and **$2 for OpenAI**, across
restarts. They are initialized once in MongoDB and cannot be reset or raised
through the HTTP API or environment budget variables. Amounts are integer
microdollars. Every paid request atomically reserves a pessimistic amount before
it starts:

- Google Static Street View: $0.01 reserved per image; a conservative $0.007
  spending estimate recorded after a successful request. The estimate ignores
  free-tier credits; metadata requests do not incur image charges.
- OpenAI vision: $0.04 reserved per image; successful reported token usage is
  recorded at $2 per million input tokens and $8 per million output tokens.

Uncertain requests, such as network timeouts or process interruptions, retain
their reservation rather than assuming they were free. No automatic retry is
made. Cancellation prevents subsequent paid calls; a request already in flight
may complete and be billed. Panoramax discovery/downloads have no provider fee.
These local limits govern requests issued by this backend, not unrelated usage
of the same account keys. Preserve the database to preserve cache and ledger.
Each provider's totals and reservation records share one MongoDB document.
Conditional single-document updates atomically reserve remaining budget and
settle a request once, with journaled acknowledgement before paid calls begin.
This works on the portable standalone server without replica-set transactions.

## API contract

All JSON uses camelCase. HTTP errors are
`{"error":{"code":"...","message":"...","field":"optional"}}`.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/health` | Provider availability, live readiness, geocoder status |
| `GET /api/usage` | Model, imagery provider, readiness, and each provider's limit/used/reserved/remaining dollars |
| `POST /api/searches` | `{query, area, mode, configuration?: {maxImages: 4–48}}` → a SearchJob, HTTP 202 |
| `GET /api/searches/<id>` | Current or persisted SearchJob snapshot |
| `DELETE /api/searches/<id>` | Idempotent cancellation; retains partial results |
| `GET /api/locations?q=...` | Local Cornell/Ithaca/New York/London/San Francisco destinations |
| `GET /api/imagery/<id>` | Registered source image or an already-fetched, expiring Google preview |
| `POST /api/searches/<jobId>/imagery/<frameId>` | Explicitly reload a recorded Google preview; returns `{imageUrl}` without vision analysis |

Search areas:

```ts
type SearchArea =
  | { kind: "radius"; center: Position; radiusMeters: number; label?: string }
  | { kind: "viewport" | "region"; bounds: Bounds; label?: string }
  | { kind: "route"; coordinates: Position[]; corridorMeters: number; label?: string }
```

Positions are WGS84 `{longitude, latitude}`. Bounds are `{west, south, east,
north}` and support crossing the antimeridian. A route corridor extends
`corridorMeters` on each side of the route. Geographic filtering uses spherical
distance, including distance to the great-circle route segments.

Jobs expose `queued`, `running`, `completed`, `cancelled`, or `failed` status,
`progress`, incremental `detections` and analyzed `frames`, the authoritative `area`, timestamps,
provider `mode`, interpretation, and optional structured `error`. Cached POST
responses additionally expose `cacheHit: true`. The selected geometry is
authoritative; natural-language text is passed to the vision provider, not used
to silently move or resize the user's map selection.

The application bounds requests to 1,000 query characters, 64 KB request bodies,
radius 25–50,000 meters, bounding areas under 10,000 km², routes with 2–500 points
and length 1 meter–100 kilometers, and corridor 5–5,000 meters. Four workers and
eight active jobs bound local concurrency; the in-memory snapshot window is
100 jobs, while persistent history remains cached.

## Location provider

Duffield Hall, Cornell University, Ithaca, New York City, London, and San
Francisco are genuine local navigation destinations. Duffield's position comes
from [Cornell's official place listing](https://events.cornell.edu/duffield_hall),
and aliases include `Duffield Hall Cornell`. Local lookups do not call a provider.

When `GOOGLE_MAPS_API_KEY` is configured, an explicitly submitted location search
with `remote=1` uses Google's Geocoding API. Enable that API for the key's project;
Street View API access alone does not establish Geocoding availability. The
adapter has a 3-second timeout and no automatic retries. It reserves $0.01 in
the existing Google ledger before a request and records a conservative $0.005
after a successful response, including zero results. Uncertain outcomes retain
their reservation. MongoDB's `location_queries` collection caches responses for
24 hours with an expiry index; repeated and simultaneous identical submissions
reuse the cache. No credentials or raw provider diagnostics are returned.

`CARTOGRAPHER_GEOCODER_URL` overrides Google with a self-hosted or approved
Nominatim-compatible search endpoint. Set an identifying
`CARTOGRAPHER_GEOCODER_USER_AGENT` as appropriate. Only `remote=1` calls the
remote adapter; typing suggestions stays local. The Nominatim adapter uses a
30-minute in-memory cache and a one-request-per-second rate limit. The public
Nominatim endpoint is not silently configured; its
[usage policy](https://operations.osmfoundation.org/policies/nominatim/)
requires deliberate provider selection and prohibits autocomplete.

## Architecture and limitations

`geography.py` validates geometry and performs spatial filtering. `providers.py`
isolates synthetic fixtures. `live.py`, `imagery_service.py`, `panoramax.py`, `transient_imagery.py`, and `sampling.py` own the
imagery/vision boundary. `storage.py` owns cache and atomic reservations.
`searches.py` owns cancellable progressive jobs. `__init__.py` contains the Flask
routes; React does not need provider-specific HTTP code.

This is a local, single-process application. MongoDB makes spending atomic and
cache durable, but in-flight job coordination lives in process memory. Use one
server process; move orchestration to a shared task queue before deploying with
multiple server processes. After a crash, old in-flight snapshots are returned
as interrupted; their cached image analyses and spending reservations survive.

Relevant primary sources:
[Panoramax federation licenses](https://docs.panoramax.fr/federated-catalog/),
[CC BY-SA 4.0 license](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en),
[GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1),
[vision input](https://developers.openai.com/api/docs/guides/images-vision), and
[structured output](https://developers.openai.com/api/docs/guides/structured-outputs),
[MongoDB atomic updates](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), and
[journaled acknowledgement](https://www.mongodb.com/docs/manual/reference/write-concern/).
