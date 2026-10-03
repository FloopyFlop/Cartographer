import json
import threading
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
import pytest
from bson import json_util

from cartographer import create_app
from cartographer.errors import ApiError
from cartographer.live import LiveProvider
from cartographer.storage import PersistentStore
from cartographer.transient_imagery import TransientImageryCache
from test_api import finish
from test_live_and_storage import detection, image_bytes


def test_google_live_sampling_free_preview_cache_and_secret_boundary(tmp_path, mongo_settings, monkeypatch, area):
    secret = "google-test-secret-must-never-be-returned"
    pixels = image_bytes((640, 640))
    calls = {"metadata": 0, "images": 0, "vision": 0}

    class MetadataResponse:
        def __init__(self, value):
            self.value = value
        def raise_for_status(self):
            pass
        def json(self):
            return self.value

    class ImageResponse:
        headers = {"content-type": "image/jpeg"}
        def raise_for_status(self):
            pass
        def iter_bytes(self):
            yield pixels

    class GoogleClient:
        def __init__(self, **kwargs):
            self.probe = 0
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def get(self, url, params):
            assert url.endswith("/metadata")
            assert params["key"] == secret
            calls["metadata"] += 1
            self.probe += 1
            if self.probe == 1:
                return MetadataResponse({"status": "ZERO_RESULTS"})
            if self.probe == 2:
                return MetadataResponse({"status": "OK", "pano_id": "outside", "location": {"lat": 45, "lng": -76}, "date": "2024-01"})
            panorama = "camera-a" if self.probe in (3, 4) else "camera-b"
            return MetadataResponse({"status": "OK", "pano_id": panorama, "location": {"lat": area["center"]["latitude"], "lng": area["center"]["longitude"]}, "date": "2025-09", "copyright": "© Google"})
        @contextmanager
        def stream(self, method, url, params):
            assert method == "GET"
            assert params["key"] == secret
            assert params["size"] == "640x640"
            calls["images"] += 1
            yield ImageResponse()

    class VisionClient:
        def __init__(self, **kwargs):
            assert kwargs["max_retries"] == 0
            self.responses = self
        def create(self, **kwargs):
            calls["vision"] += 1
            return SimpleNamespace(status="completed", output_text=json.dumps({"detections": [detection()]}), usage=SimpleNamespace(input_tokens=100, output_tokens=50))
        def close(self):
            pass

    monkeypatch.setattr("cartographer.live.httpx.Client", GoogleClient)
    monkeypatch.setattr("cartographer.live.OpenAI", VisionClient)
    app = create_app({"TESTING": True, "MONGODB_URI": mongo_settings["uri"], "MONGODB_DATABASE": mongo_settings["database"], "CACHE_DIRECTORY": tmp_path, "OPENAI_API_KEY": "openai-test-key", "GOOGLE_MAPS_API_KEY": secret, "IMAGERY_PROVIDER": "google", "IMAGERY_MANIFEST": tmp_path / "manifest.json", "SEARCH_STEP_SECONDS": 0.001, "MAX_IMAGES": 4})
    try:
        client = app.test_client()
        request = {"query": "find benches", "area": area, "mode": "live"}
        job = client.post("/api/searches", json=request).get_json()
        completed = finish(client, job["id"])
        assert completed["status"] == "completed"
        assert len(completed["detections"]) == 4
        assert calls == {"metadata": 3, "images": 4, "vision": 1}
        assert len(completed["frames"]) == 4
        assert {frame["heading"] for frame in completed["frames"]} == {0, 90, 180, 270}
        usage = client.get("/api/usage").get_json()
        assert usage["imageryProvider"] == "google"
        assert usage["google"]["usedUsd"] == 0.028
        assert usage["google"]["reservedUsd"] == 0
        assert usage["openai"]["usedUsd"] == 0.0006
        for result in completed["detections"]:
            assert result["source"]["provider"] == "google"
            assert result["source"]["imageUrl"].startswith("/api/imagery/google-")
            assert "key=" not in result["source"]["referenceUrl"]
            assert result["metadata"]["capturedAt"] == "2025-09"
            preview = client.get(result["source"]["imageUrl"])
            assert preview.status_code == 200
            assert preview.data == pixels
            assert preview.headers["Cache-Control"] == "no-store"
        assert client.get("/api/usage").get_json() == usage
        repeat = client.post("/api/searches", json=request).get_json()
        assert repeat["cacheHit"] is True
        assert calls["images"] == 4
        # A different object query can reuse the same already-fetched views.
        second = client.post("/api/searches", json={**request, "query": "find wooden benches"}).get_json()
        assert finish(client, second["id"])["status"] == "completed"
        assert calls["images"] == 4
        assert calls["vision"] == 2
        store = app.extensions["persistent_store"]
        assert store.db.source_images.count_documents({}) == 0
        for collection in store.db.list_collection_names():
            assert secret not in json_util.dumps(list(store.db[collection].find({})))
        assert not list((tmp_path / "images").iterdir())
        app.extensions["live_provider"].google_images.close()
        expired = client.get(completed["detections"][0]["source"]["imageUrl"])
        assert expired.status_code == 410
        assert expired.get_json()["error"]["code"] == "imagery_expired"
        assert calls["images"] == 4
        assert client.post("/api/searches", json=request).get_json()["cacheHit"] is True
    finally:
        app.extensions["search_service"].shutdown()
        app.extensions["live_provider"].google_images.close()
        app.extensions["persistent_store"].close()


def test_google_uncertain_request_keeps_reservation_and_cancellation_avoids_call(tmp_path, mongo_settings):
    store = PersistentStore(**mongo_settings)
    provider = LiveProvider(store, "openai-test-key", "google-test-key", tmp_path / "manifest.json")
    class FailingClient:
        @contextmanager
        def stream(self, *args, **kwargs):
            raise httpx.ReadTimeout("secret raw diagnostics must remain private")
            yield
    cancellation = threading.Event()
    cancellation.set()
    assert provider._google_image(FailingClient(), "camera", 0, {}, {"longitude": 0, "latitude": 0}, cancellation) is None
    assert store.usage()["google"]["remainingUsd"] == 4
    cancellation.clear()
    with pytest.raises(ApiError) as error:
        provider._google_image(FailingClient(), "camera", 0, {}, {"longitude": 0, "latitude": 0}, cancellation)
    assert "secret" not in error.value.message
    assert store.usage()["google"]["reservedUsd"] == 0.01
    provider.google_images.close()
    store.close()


def test_transient_preview_count_byte_and_expiry_limits():
    clock = [0]
    cache = TransientImageryCache(ttl_seconds=600, max_entries=2, max_bytes=10, clock=lambda: clock[0])
    try:
        first = cache.put("one", b"12345", "image/jpeg", {})
        second = cache.put("two", b"67890", "image/jpeg", {})
        third = cache.put("three", b"abcde", "image/jpeg", {})
        with pytest.raises(ApiError) as error:
            cache.get(first.id)
        assert error.value.status == 410
        assert cache.get(second.id).content == b"67890"
        assert cache.get(third.id).content == b"abcde"
        clock[0] = 601
        assert cache.lookup("two") is None
        with pytest.raises(ApiError):
            cache.get(third.id)
    finally:
        cache.close()
