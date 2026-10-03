"""Street View acquisition adapted from the shared backend's 360° service.

Credentials are injected by Cartographer's application. Images remain in bounded
temporary memory, and every image request uses the durable spending ledger.
"""

import hashlib
import io
import json
import threading

import httpx
from PIL import Image, UnidentifiedImageError

from .errors import ApiError
from .geography import position
from .sampling import HEADINGS, MAX_CAMERA_OFFSET_METERS
from .transient_imagery import MAX_IMAGE_BYTES


class GoogleStreetViewService:
    def __init__(self, key, store, images):
        self.key = key
        self.store = store
        self.images = images
        self._metadata_lock = threading.Lock()
        self._image_lock = threading.Lock()

    def find_panorama(self, client, viewpoint, cancelled):
        if cancelled.is_set():
            return None
        try:
            with self._metadata_lock:
                if cancelled.is_set():
                    return None
                response = client.get("https://maps.googleapis.com/maps/api/streetview/metadata", params={
                    "location": f"{viewpoint['latitude']},{viewpoint['longitude']}",
                    "radius": MAX_CAMERA_OFFSET_METERS, "source": "default", "key": self.key,
                })
            response.raise_for_status()
            metadata = response.json()
        except (httpx.HTTPError, ValueError):
            raise ApiError("imagery_provider_unavailable", "Street imagery is unavailable. Please try again.", 503) from None
        if not isinstance(metadata, dict):
            raise ApiError("invalid_imagery_metadata", "The imagery provider returned invalid location information.", 503)
        if metadata.get("status") == "ZERO_RESULTS":
            return None
        if metadata.get("status") != "OK":
            raise ApiError("imagery_provider_error", "The street imagery provider rejected the request. Check its enabled API and credentials.", 503)
        try:
            location = metadata["location"]
            camera = position({"longitude": location.get("lng"), "latitude": location.get("lat")}, "camera")
            panorama_id = metadata["pano_id"]
            if not isinstance(panorama_id, str) or not panorama_id or len(panorama_id) > 300:
                raise ValueError("Invalid panorama")
        except (ApiError, KeyError, AttributeError, ValueError):
            raise ApiError("invalid_imagery_metadata", "The imagery provider returned invalid location information.", 503) from None
        return metadata, camera, panorama_id

    def get_street_view_image(self, client, panorama_id, heading, metadata, camera, cancelled):
        key_value = {"panorama": panorama_id, "heading": heading, "pitch": 0, "fov": 90, "size": "640x640"}
        cache_key = hashlib.sha256(json.dumps(key_value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        # Different object queries share a fetched camera view without paying
        # again while its temporary preview is available.
        with self._image_lock:
            if cancelled.is_set():
                return None
            cached = self.images.lookup(cache_key)
            if cached:
                return cached
            reservation = self.store.reserve("google", 10_000, "street_view_static")
            if cancelled.is_set():
                self.store.settle(reservation, 0)
                return None
            try:
                with client.stream("GET", "https://maps.googleapis.com/maps/api/streetview", params={
                    **{key: value for key, value in key_value.items() if key != "panorama"},
                    "pano": panorama_id, "return_error_code": "true", "key": self.key,
                }) as response:
                    if getattr(response, "status_code", 200) == 404:
                        # A definitively unavailable image does not consume a
                        # successful-image slot. Its uncertain charge stays
                        # reserved rather than silently refunding a sent call.
                        return None
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").split(";", 1)[0]
                    if not content_type.startswith("image/"):
                        raise ValueError("Not an image")
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > MAX_IMAGE_BYTES:
                            raise ValueError("Image too large")
                        chunks.append(chunk)
                    content = b"".join(chunks)
            except (httpx.HTTPError, ValueError):
                raise ApiError("imagery_provider_unavailable", "A street image could not be retrieved. Its spending reservation is retained until reconciled.", 503) from None
            self.store.settle(reservation, 7_000)
            try:
                with Image.open(io.BytesIO(content)) as image:
                    image.verify()
            except (OSError, UnidentifiedImageError, Image.DecompressionBombError):
                raise ApiError("invalid_imagery", "The imagery provider returned an unreadable image.", 503) from None
            return self.images.put(cache_key, content, content_type, {
                "camera": dict(camera), "panoramaId": panorama_id, "heading": heading,
                "capturedAt": metadata.get("date"), "attribution": str(metadata.get("copyright", "© Google")),
            })

    def acquire_360_panorama(self, client, panorama_id, metadata, camera, cancelled, max_images=4):
        """Yield four cardinal, 90° views without storing image files.

As in the shared service, an unavailable first view abandons that camera.
Yielding one view at a time permits cancellation and progressive analysis.
"""
        for index, heading in enumerate(HEADINGS[:max_images]):
            if cancelled.is_set():
                return
            image = self.get_street_view_image(client, panorama_id, heading, metadata, camera, cancelled)
            if image is None:
                if index == 0 or cancelled.is_set():
                    return
                continue
            yield heading, image
