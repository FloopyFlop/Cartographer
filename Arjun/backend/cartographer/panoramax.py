"""Open street imagery, cached with its individual license and attribution."""

import math
import re
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .errors import ApiError
from .geography import contains, haversine, longitude_delta, position
from .storage import PersistentStore


SEARCH_URL = "https://explore.panoramax.fr/api/search"
DISCOVERY_VERSION = "panoramax-tiled100-v2"
DISCOVERY_LIMIT = 100
ALLOWED_LICENSES = {"CC-BY-SA-4.0", "CC-BY-4.0", "CC0-1.0", "etalab-2.0", "ODbL-1.0"}
LICENSE_URLS = {
    "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
    "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
    "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
    "etalab-2.0": "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
    "ODbL-1.0": "https://opendatacommons.org/licenses/odbl/1-0/",
}


def area_bounds(area: dict) -> dict:
    if area["kind"] in {"viewport", "region"}:
        return area["bounds"]
    if area["kind"] == "radius":
        center = area["center"]
        latitude_delta = area["radiusMeters"] / 111_000
        longitude_radius = min(180, latitude_delta / max(0.001, math.cos(math.radians(center["latitude"]))))
        return {"west": longitude_delta(center["longitude"] - longitude_radius), "east": longitude_delta(center["longitude"] + longitude_radius), "south": max(-90, center["latitude"] - latitude_delta), "north": min(90, center["latitude"] + latitude_delta)}
    padding = area["corridorMeters"] / 111_000
    from .sampling import sample_area
    coordinates = area["coordinates"] + sample_area(area)
    center_latitude = sum(point["latitude"] for point in coordinates) / len(coordinates)
    longitude_padding = padding / max(0.001, math.cos(math.radians(center_latitude)))
    first_longitude = coordinates[0]["longitude"]
    unwrapped = [first_longitude + longitude_delta(point["longitude"] - first_longitude) for point in coordinates]
    return {
        "west": longitude_delta(min(unwrapped) - longitude_padding),
        "east": longitude_delta(max(unwrapped) + longitude_padding),
        "south": max(-90, min(point["latitude"] for point in coordinates) - padding),
        "north": min(90, max(point["latitude"] for point in coordinates) + padding),
    }


def discovery_boxes(bounds: dict) -> list[tuple[float, float, float, float]]:
    """At most four probes, prioritizing the center over bbox corner frames.

Catalog search is bounded and does not advertise complete coverage. A dense
road in one corner can otherwise fill the entire result page while the actual
circle or route has no candidates in that page.
"""
    west, south, east, north = (bounds[key] for key in ("west", "south", "east", "north"))
    middle_latitude = (south + north) / 2
    if west > east:
        return [
            (west, south, 180, middle_latitude), (west, middle_latitude, 180, north),
            (-180, south, east, middle_latitude), (-180, middle_latitude, east, north),
        ]
    middle_longitude = (west + east) / 2
    longitude_inset, latitude_inset = (east - west) * 0.3, (north - south) * 0.3
    return [
        (west + longitude_inset, south + latitude_inset, east - longitude_inset, north - latitude_inset),
        (west, south, middle_longitude, north),
        (middle_longitude, middle_latitude, east, north),
        (middle_longitude, south, east, middle_latitude),
    ]


class PanoramaxImagery:
    def __init__(self, store: PersistentStore, max_images: int = 4):
        self.store = store
        self.max_images = min(12, max(1, max_images))
        self.image_directory = store.cache_directory / "images"
        self.image_directory.mkdir(parents=True, exist_ok=True)

    def records(self, area: dict, cancelled) -> list[dict]:
        import hashlib
        import json
        canonical = {key: value for key, value in area.items() if key != "label"}
        cache_key = hashlib.sha256(json.dumps({"area": canonical, "provider": DISCOVERY_VERSION, "maxImages": self.max_images}, sort_keys=True).encode()).hexdigest()
        cached = self.store.source_query(cache_key)
        if cached is not None:
            return cached
        bounds = area_bounds(area)
        boxes = discovery_boxes(bounds)
        records, seen = [], set()
        with httpx.Client(timeout=15, follow_redirects=False, headers={"User-Agent": "Cartographer/0.1 (licensed street imagery search)"}) as client:
            for bbox in boxes:
                if cancelled.is_set():
                    return []
                try:
                    response = client.get(SEARCH_URL, params={"bbox": ",".join(map(str, bbox)), "limit": DISCOVERY_LIMIT})
                    response.raise_for_status()
                    features = response.json()["features"]
                    if not isinstance(features, list):
                        raise ValueError("Invalid imagery search")
                except (httpx.HTTPError, ValueError, KeyError, TypeError):
                    raise ApiError("imagery_provider_unavailable", "Open street imagery could not be searched. Please try again.", 503) from None
                for feature in features:
                    try:
                        coordinates = feature["geometry"]["coordinates"]
                        camera = position({"longitude": coordinates[0], "latitude": coordinates[1]}, "camera")
                        properties = feature["properties"]
                        license_name = properties.get("license")
                        if license_name not in ALLOWED_LICENSES or not contains(area, camera):
                            continue
                        item_id = str(feature["id"])
                        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", item_id):
                            continue
                        if item_id in seen:
                            continue
                        seen.add(item_id)
                        assets = feature["assets"]
                        asset_url = next(assets[key]["href"] for key in ("sd", "hd", "thumb") if key in assets)
                        if not isinstance(asset_url, str):
                            continue
                        parsed = urlparse(asset_url)
                        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                            continue
                        trusted_hosts = ("panoramax.fr", "panoramax.xyz", "openstreetmap.fr", "panoramax.ign.fr")
                        if not any(parsed.hostname == host or parsed.hostname.endswith("." + host) for host in trusted_hosts):
                            continue
                        license_url = next((link["href"] for link in feature.get("links", []) if link.get("rel") == "license"), LICENSE_URLS[license_name])
                        if not isinstance(license_url, str):
                            continue
                        if urlparse(license_url).scheme != "https":
                            continue
                        producer = str(properties.get("geovisio:producer") or "Panoramax contributor")[:300]
                        providers = ", ".join(str(provider.get("name", "")) for provider in feature.get("providers", []))[:300]
                        records.append({
                            "id": "panoramax-" + item_id,
                            "position": camera,
                            "assetUrl": asset_url,
                            "source": {"provider": "panoramax", "attribution": f"© {producer} · {providers or 'Panoramax'} · {license_name}", "imageUrl": "/api/imagery/panoramax-" + item_id, "referenceUrl": "https://explore.panoramax.fr/#focus=pic&pic=" + item_id, "license": {"name": license_name, "url": license_url}},
                            "metadata": {"imageId": item_id, "heading": float(properties.get("view:azimuth") or 0) % 360, "capturedAt": properties.get("datetime"), "license": license_name, "licenseUrl": license_url, "discovery": DISCOVERY_VERSION},
                        })
                    except (KeyError, ValueError, TypeError, IndexError, StopIteration, AttributeError, ApiError):
                        continue
        # Nearby consecutive road frames often repeat the same objects. Keep a
        # small spatially dispersed sample instead of the first four frames.
        if records:
            candidates, records = records[1:], records[:1]
            while candidates and len(records) < self.max_images:
                selected = max(candidates, key=lambda candidate: min(haversine(candidate["position"], existing["position"]) for existing in records))
                records.append(selected)
                candidates.remove(selected)
        self.store.cache_source_query(cache_key, records)
        return records

    def image_bytes(self, record: dict, cancelled) -> bytes:
        import hashlib
        cached = self.store.source_image(record["id"])
        if cached and Path(cached["path"]).is_file():
            return Path(cached["path"]).read_bytes()
        if cancelled.is_set():
            return b""
        try:
            with httpx.Client(timeout=20, follow_redirects=False) as client:
                with client.stream("GET", record["assetUrl"]) as response:
                    response.raise_for_status()
                    if not response.headers.get("content-type", "").startswith("image/"):
                        raise ValueError("Not an image")
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        if cancelled.is_set():
                            return b""
                        size += len(chunk)
                        if size > 20 * 1024 * 1024:
                            raise ValueError("Image too large")
                        chunks.append(chunk)
                    data = b"".join(chunks)
            from .live import normalize_image
            normalize_image(data)
        except (httpx.HTTPError, ValueError):
            raise ApiError("imagery_provider_unavailable", "An open street image could not be retrieved.", 503) from None
        image_path = self.image_directory / (hashlib.sha256(record["id"].encode()).hexdigest() + ".jpg")
        temporary_path = self.image_directory / (uuid.uuid4().hex + ".tmp")
        temporary_path.write_bytes(data)
        temporary_path.replace(image_path)
        self.store.cache_source_image(record["id"], record, image_path)
        return data

    def image_path(self, image_id: str) -> Path:
        cached = self.store.source_image(image_id)
        if cached is None:
            raise ApiError("imagery_not_found", "This source image is unavailable.", 404)
        path = Path(cached["path"]).resolve()
        if path.parent != self.image_directory.resolve() or not path.is_file():
            raise ApiError("imagery_not_found", "This source image is unavailable.", 404)
        return path
