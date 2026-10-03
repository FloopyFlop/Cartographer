"""Local destinations with an opt-in Nominatim-compatible geocoding adapter.

Remote service use is deliberately configured, never silently enabled against a
public endpoint. The UI must call remote lookup on explicit search submission,
not autocomplete. The endpoint, identifying User-Agent, timeout and cache are
independent of the UI so the provider can be changed without client changes.
"""

import copy
import json
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from .errors import ApiError


LOCAL_LOCATIONS = [
    {
        "id": "cornell",
        "label": "Cornell University",
        "description": "Ithaca, New York · demonstration area",
        "position": {"longitude": -76.4830, "latitude": 42.4483},
        "bounds": {"west": -76.4900, "south": 42.4410, "east": -76.4720, "north": 42.4535},
        "source": "local",
        "aliases": ["cornell", "cornell university", "cornell campus"],
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
    def __init__(self, endpoint: str | None = None, user_agent: str | None = None, timeout_seconds: float = 3):
        if endpoint and urlparse(endpoint).scheme not in {"http", "https"}:
            raise ValueError("CARTOGRAPHER_GEOCODER_URL must be an HTTP(S) Nominatim-compatible search endpoint.")
        self.endpoint = endpoint
        self.user_agent = user_agent or "CartographerDevelopment/0.1 (local Cartographer application)"
        self.timeout_seconds = timeout_seconds
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, list[dict]]] = {}
        self._last_request = 0.0

    @property
    def configured(self) -> bool:
        return bool(self.endpoint)

    def search(self, query: str, remote: bool = False) -> dict:
        query = query.strip()
        if len(query) > 160:
            raise ApiError("invalid_location_query", "Keep the location name under 160 characters.", field="q")
        normalized = query.casefold()
        local = [
            {key: copy.deepcopy(value) for key, value in item.items() if key != "aliases"}
            for item in LOCAL_LOCATIONS
            if not normalized or any(normalized in alias for alias in item["aliases"])
        ]
        if local:
            return {"locations": local}
        if remote and self.endpoint and len(query) >= 2:
            return {"locations": self._remote_search(query), "attribution": "© OpenStreetMap contributors"}
        return {
            "locations": [],
            "message": "Try Cornell University, Ithaca, New York City, London, or San Francisco. Additional locations require a configured geocoding provider.",
        }

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
