"""Local destinations and explicitly submitted, metered remote geocoding.

Remote service use is deliberately configured, never silently enabled against a
public endpoint. The UI must call remote lookup on explicit search submission,
not autocomplete. The endpoint, identifying User-Agent, timeout and cache are
independent of the UI so the provider can be changed without client changes.
"""

import copy
import hashlib
import json
import math
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from .errors import ApiError
from .storage import PersistentStore, database_operation


GOOGLE_GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json"
GOOGLE_GEOCODING_RESERVATION_MICRO = 10_000
GOOGLE_GEOCODING_CHARGE_MICRO = 5_000
GOOGLE_LOCATION_CACHE_SECONDS = 86_400


def normalize_query(query: str) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", query.casefold()).split())


def coordinate_location(query: str) -> dict | None:
    parts = query.split(",")
    if len(parts) != 2:
        return None
    try:
        latitude, longitude = (float(part.strip()) for part in parts)
    except ValueError:
        return None
    if not math.isfinite(latitude) or not math.isfinite(longitude) or not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ApiError("invalid_location_coordinates", "Use latitude between -90 and 90, followed by longitude between -180 and 180.", field="q")
    return {"id": f"coordinates-{latitude}-{longitude}", "label": "Map coordinates",
            "description": f"{latitude:.6f}, {longitude:.6f}",
            "position": {"longitude": longitude, "latitude": latitude}, "source": "coordinates"}


LOCAL_LOCATIONS = [
    {
        "id": "cornell",
        "label": "Cornell University",
        "description": "Ithaca, New York",
        "position": {"longitude": -76.4830, "latitude": 42.4483},
        "bounds": {"west": -76.4900, "south": 42.4410, "east": -76.4720, "north": 42.4535},
        "source": "local",
        "aliases": ["cornell", "cornell university", "cornell campus"],
    },
    {
        "id": "duffield-hall",
        "label": "Duffield Hall, Cornell University",
        "description": "343 Campus Road · Ithaca, New York",
        # Cornell's official place listing publishes these GeoCoordinates.
        # https://events.cornell.edu/duffield_hall
        "position": {"longitude": -76.48278, "latitude": 42.444862},
        "source": "local",
        "referenceUrl": "https://events.cornell.edu/duffield_hall",
        "aliases": ["duffield", "duffield hall", "duffield cornell", "duffield hall cornell",
                    "duffield hall cornell university", "cornell duffield hall", "cornell university duffield hall",
                    "duffield hall at cornell", "duffield hall at cornell university",
                    "duffield hall cornell university ithaca", "343 campus road", "343 campus rd"],
    },
    {
        "id": "ithaca",
        "label": "Ithaca, New York",
        "description": "United States",
        "position": {"longitude": -76.5019, "latitude": 42.4440},
        "bounds": {"west": -76.5300, "south": 42.4200, "east": -76.4600, "north": 42.4700},
        "source": "local",
        "aliases": ["ithaca", "ithaca new york"],
    },
    {
        "id": "new-york",
        "label": "New York City",
        "description": "New York, United States",
        "position": {"longitude": -73.9857, "latitude": 40.7484},
        "bounds": {"west": -74.0400, "south": 40.6800, "east": -73.9300, "north": 40.8200},
        "source": "local",
        "aliases": ["new york", "new york city", "nyc", "manhattan"],
    },
    {
        "id": "london",
        "label": "London",
        "description": "United Kingdom",
        "position": {"longitude": -0.1276, "latitude": 51.5074},
        "bounds": {"west": -0.1900, "south": 51.4700, "east": -0.0600, "north": 51.5450},
        "source": "local",
        "aliases": ["london", "london uk", "london england"],
    },
    {
        "id": "san-francisco",
        "label": "San Francisco",
        "description": "California, United States",
        "position": {"longitude": -122.4194, "latitude": 37.7749},
        "bounds": {"west": -122.5100, "south": 37.7100, "east": -122.3600, "north": 37.8200},
        "source": "local",
        "aliases": ["san francisco", "sf", "san francisco california"],
    },
]


class LocationService:
    @database_operation
    def __init__(self, endpoint: str | None = None, user_agent: str | None = None, timeout_seconds: float = 3,
                 *, google_key: str | None = None, store: PersistentStore | None = None):
        if endpoint and urlparse(endpoint).scheme not in {"http", "https"}:
            raise ValueError("CARTOGRAPHER_GEOCODER_URL must be an HTTP(S) Nominatim-compatible search endpoint.")
        self.endpoint = endpoint
        self.user_agent = user_agent or "CartographerDevelopment/0.1 (local Cartographer application)"
        self.timeout_seconds = timeout_seconds
        self.google_key = google_key
        self.store = store
        if google_key and store is None:
            raise ValueError("Google location search requires the persistent spending ledger.")
        if google_key and store is not None and not endpoint:
            store.db.location_queries.create_index("expires_at", expireAfterSeconds=0)
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, list[dict]]] = {}
        self._last_request = 0.0

    @property
    def configured(self) -> bool:
        return bool(self.endpoint or (self.google_key and self.store))

    def search(self, query: str, remote: bool = False) -> dict:
        query = query.strip()
        if len(query) > 160:
            raise ApiError("invalid_location_query", "Keep the location name under 160 characters.", field="q")
        coordinates = coordinate_location(query)
        if coordinates is not None:
            return {"locations": [coordinates]}
        normalized = normalize_query(query)
        local = [
            {key: copy.deepcopy(value) for key, value in item.items() if key != "aliases"}
            for item in LOCAL_LOCATIONS
            if not normalized or any(normalized in normalize_query(alias) for alias in item["aliases"])
        ]
        if local:
            return {"locations": local}
        if remote and self.endpoint and len(query) >= 2:
            return {"locations": self._remote_search(query), "attribution": "© OpenStreetMap contributors"}
        if remote and self.google_key and self.store is not None and len(query) >= 2:
            return {"locations": self._google_search(query), "attribution": "Google Maps"}
        return {
            "locations": [],
            "message": "Submit the place name to search more locations." if self.configured else "Try Duffield Hall, Cornell University, Ithaca, New York City, London, or San Francisco. Additional locations require a configured geocoding provider.",
        }

    @database_operation
    def _google_search(self, query: str) -> list[dict]:
        cache_key = hashlib.sha256(("google-geocoding-v1:" + normalize_query(query)).encode()).hexdigest()
        with self._lock:
            collection = self.store.db.location_queries
            now = datetime.now(timezone.utc)
            cached = collection.find_one({"_id": cache_key})
            if cached:
                expires_at = cached.get("expires_at")
                if isinstance(expires_at, datetime) and expires_at.replace(tzinfo=timezone.utc) > now:
                    return copy.deepcopy(cached["locations"])
                collection.delete_one({"_id": cache_key})
            reservation = self.store.reserve("google", GOOGLE_GEOCODING_RESERVATION_MICRO, "Google Geocoding")
            request = Request(GOOGLE_GEOCODING_URL + "?" + urlencode({"address": query, "key": self.google_key}),
                              headers={"Accept": "application/json"})
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    data = response.read(1_048_577)
                    if len(data) > 1_048_576:
                        raise ValueError("Geocoder response too large")
                    payload = json.loads(data)
                if not isinstance(payload, dict):
                    raise ValueError("Invalid geocoder response")
                status = payload.get("status")
                if status in {"REQUEST_DENIED", "INVALID_REQUEST", "OVER_DAILY_LIMIT", "OVER_QUERY_LIMIT"}:
                    self.store.settle(reservation, 0)
                    raise ApiError("google_geocoding_unavailable", "Google location search is unavailable. Enable the Geocoding API and check the Google key's API restrictions, billing, and quota.", 503)
                if status not in {"OK", "ZERO_RESULTS"} or not isinstance(payload.get("results"), list):
                    raise ValueError("Invalid geocoder response")
                results = [] if status == "ZERO_RESULTS" else [self._google_location(row, query, index) for index, row in enumerate(payload["results"][:5])]
            except ApiError:
                raise
            except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, TypeError, AttributeError):
                # An uncertain request may have been billed. Retain its durable
                # reservation and omit provider diagnostics containing the key.
                raise ApiError("location_provider_unavailable", "Google location search could not finish. Try a local destination; uncertain spending remains reserved.", 503) from None
            self.store.settle(reservation, GOOGLE_GEOCODING_CHARGE_MICRO)
            collection.replace_one({"_id": cache_key}, {"_id": cache_key, "locations": copy.deepcopy(results),
                "created_at": now, "expires_at": now + timedelta(seconds=GOOGLE_LOCATION_CACHE_SECONDS)}, upsert=True)
            return copy.deepcopy(results)

    @staticmethod
    def _google_location(row: dict, query: str, index: int) -> dict:
        geometry = row["geometry"]
        position = geometry["location"]
        longitude, latitude = position["lng"], position["lat"]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (longitude, latitude)) or not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise ValueError("Invalid geocoder coordinates")
        address = str(row.get("formatted_address") or query)[:500]
        result = {"id": f"google-{row.get('place_id', index)}", "label": address[:160], "description": address,
                  "position": {"longitude": longitude, "latitude": latitude}, "source": "google", "attribution": "Google Maps"}
        viewport = geometry.get("viewport")
        if isinstance(viewport, dict):
            northeast, southwest = viewport.get("northeast", {}), viewport.get("southwest", {})
            north, south, east, west = northeast.get("lat"), southwest.get("lat"), northeast.get("lng"), southwest.get("lng")
            values = (north, south, east, west)
            if all(not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) for value in values) and -90 <= south < north <= 90 and -180 <= west <= 180 and -180 <= east <= 180 and west != east:
                result["bounds"] = {"south": south, "north": north, "west": west, "east": east}
        return result

    def _remote_search(self, query: str) -> list[dict]:
        key = query.casefold()
        with self._lock:
            now = time.monotonic()
            cached = self._cache.get(key)
            if cached and now - cached[0] < 1800:
                return copy.deepcopy(cached[1])
            if now - self._last_request < 1:
                raise ApiError("location_search_rate_limited", "Wait a moment before searching another location.", 429)
            self._last_request = now
            joiner = "&" if "?" in self.endpoint else "?"
            request = Request(
                self.endpoint + joiner + urlencode({"q": query, "format": "jsonv2", "limit": 5}),
                headers={"User-Agent": self.user_agent, "Accept": "application/json"},
            )
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    data = response.read(1_048_577)
                    if len(data) > 1_048_576:
                        raise ValueError("Geocoder response too large")
                    rows = json.loads(data)
                if not isinstance(rows, list):
                    raise ValueError("Invalid geocoder response")
                results = []
                for row in rows[:5]:
                    longitude, latitude = float(row["lon"]), float(row["lat"])
                    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
                        raise ValueError("Invalid geocoder coordinates")
                    display_name = str(row.get("display_name", query))[:500]
                    item = {
                        "id": f"geocoder-{row.get('place_id', len(results))}",
                        "label": str(row.get("name") or display_name.split(",")[0])[:160],
                        "description": display_name,
                        "position": {"longitude": longitude, "latitude": latitude},
                        "source": "nominatim",
                        "attribution": "© OpenStreetMap contributors",
                    }
                    bbox = row.get("boundingbox")
                    if isinstance(bbox, list) and len(bbox) == 4:
                        south, north, west, east = map(float, bbox)
                        if -90 <= south < north <= 90 and -180 <= west <= east <= 180:
                            item["bounds"] = {"south": south, "north": north, "west": west, "east": east}
                    results.append(item)
            except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, TypeError):
                raise ApiError("location_provider_unavailable", "The location provider is unavailable. Try again or choose a local destination.", 503) from None
            if len(self._cache) >= 200:
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = (now, results)
            return copy.deepcopy(results)
