"""Bounded, expiring memory-only previews for already-fetched Google images."""

import copy
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass

from .errors import ApiError


TTL_SECONDS = 600
MAX_ENTRIES = 64
MAX_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class TransientImage:
    id: str
    cache_key: str
    content: bytes
    content_type: str
    metadata: dict
    expires_at: float


class TransientImageryCache:
    def __init__(self, ttl_seconds=TTL_SECONDS, max_entries=MAX_ENTRIES, max_bytes=MAX_BYTES, clock=time.monotonic):
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._clock = clock
        self._lock = threading.RLock()
        self._images: OrderedDict[str, TransientImage] = OrderedDict()
        self._keys: dict[str, str] = {}
        self._timers: dict[str, threading.Timer] = {}
        self._bytes = 0

    def _discard(self, image_id: str) -> None:
        with self._lock:
            image = self._images.pop(image_id, None)
            timer = self._timers.pop(image_id, None)
            if timer:
                timer.cancel()
            if image:
                self._bytes -= len(image.content)
                if self._keys.get(image.cache_key) == image_id:
                    self._keys.pop(image.cache_key, None)

    def _expire(self) -> None:
        for image_id, image in list(self._images.items()):
            if image.expires_at <= self._clock():
                self._discard(image_id)

    def lookup(self, cache_key: str) -> TransientImage | None:
        with self._lock:
            self._expire()
            image_id = self._keys.get(cache_key)
            return self._images.get(image_id) if image_id else None

    def get(self, image_id: str) -> TransientImage:
        with self._lock:
            self._expire()
            image = self._images.get(image_id)
            if image is None:
                raise ApiError("imagery_expired", "This temporary street image has expired. Open its Street View reference to inspect the location.", 410)
            return image

    def put(self, cache_key: str, content: bytes, content_type: str, metadata: dict) -> TransientImage:
        if len(content) > MAX_IMAGE_BYTES or len(content) > self.max_bytes:
            raise ApiError("invalid_imagery", "The source image exceeds the temporary preview size limit.", 503)
        with self._lock:
            self._expire()
            existing = self.lookup(cache_key)
            if existing:
                return existing
            while self._images and (len(self._images) >= self.max_entries or self._bytes + len(content) > self.max_bytes):
                self._discard(next(iter(self._images)))
            image = TransientImage("google-" + uuid.uuid4().hex, cache_key, content, content_type, copy.deepcopy(metadata), self._clock() + self.ttl_seconds)
            self._images[image.id] = image
            self._keys[cache_key] = image.id
            self._bytes += len(content)
            timer = threading.Timer(self.ttl_seconds, self._discard, args=(image.id,))
            timer.daemon = True
            self._timers[image.id] = timer
            timer.start()
            return image

    def close(self) -> None:
        with self._lock:
            for image_id in list(self._images):
                self._discard(image_id)
