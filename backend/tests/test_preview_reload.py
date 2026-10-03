from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import httpx
import pytest

from cartographer import create_app
from test_live_and_storage import image_bytes


@pytest.fixture
def preview_app(tmp_path, mongo_settings, monkeypatch, area):
    app = create_app({
        "TESTING": True, "MONGODB_URI": mongo_settings["uri"], "MONGODB_DATABASE": mongo_settings["database"],
        "CACHE_DIRECTORY": tmp_path, "OPENAI_API_KEY": None, "GOOGLE_MAPS_API_KEY": "private-google-test-key",
        "IMAGERY_PROVIDER": "google", "IMAGERY_MANIFEST": tmp_path / "manifest.json",
    })
    pixels = image_bytes((640, 640))
    calls = []

    class ImageResponse:
        status_code = 200
        headers = {"content-type": "image/jpeg"}

        def raise_for_status(self):
            pass

        def iter_bytes(self):
            yield pixels

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        @contextmanager
        def stream(self, method, url, params):
            assert params["pano"] == "recorded-camera"
            assert params["heading"] == 90
            assert params["key"] == "private-google-test-key"
            calls.append(dict(params))
            yield ImageResponse()

    monkeypatch.setattr("cartographer.live.httpx.Client", Client)
    monkeypatch.setattr(app.extensions["live_provider"], "_analyze", lambda *args: pytest.fail("Reload must never run visual analysis"))
    frame = {
        "id": "google-expired", "heading": 90, "position": dict(area["center"]), "capturedAt": "2025-09",
        "source": {"provider": "google", "attribution": "© Google", "imageUrl": "/api/imagery/google-expired", "referenceUrl": "https://www.google.com/maps/@?api=1&map_action=pano&pano=recorded-camera&heading=90"},
        "metadata": {"panoramaId": "recorded-camera", "heading": 90, "capturedAt": "2025-09"},
        "detectionsCount": 0, "status": "analyzed",
    }
    snapshot = {"id": "recorded-job", "status": "completed", "frames": [frame], "detections": [], "query": "bicycle racks", "area": area}
    app.extensions["persistent_store"].save_job("recorded-cache-key", snapshot)
    try:
        yield app, calls, pixels, snapshot
    finally:
        app.extensions["search_service"].shutdown()
        app.extensions["live_provider"].google_images.close()
        app.extensions["persistent_store"].close()


def test_explicit_reload_fetches_once_reuses_memory_and_preserves_completed_job(preview_app):
    app, calls, pixels, snapshot = preview_app
    client = app.test_client()
    endpoint = "/api/searches/recorded-job/imagery/google-expired"
    assert client.get("/api/imagery/google-expired").status_code == 410
    # Browser-supplied panorama/heading data cannot change the recorded view.
    response = client.post(endpoint, json={"panoramaId": "untrusted-camera", "heading": 270})
    assert response.status_code == 200
    restored = response.get_json()["imageUrl"]
    assert restored.startswith("/api/imagery/google-") and restored != "/api/imagery/google-expired"
    assert "private-google-test-key" not in restored
    preview = client.get(restored)
    assert preview.data == pixels and preview.headers["Cache-Control"] == "no-store"
    assert client.post(endpoint).get_json()["imageUrl"] == restored
    assert len(calls) == 1
    usage = app.extensions["persistent_store"].usage()
    assert usage["google"]["usedUsd"] == 0.007
    assert usage["google"]["reservedUsd"] == 0
    assert usage["openai"]["usedUsd"] == 0
    assert app.extensions["persistent_store"].get_job("recorded-job") == snapshot


def test_simultaneous_legacy_result_reloads_share_one_paid_image(preview_app):
    app, calls, _, snapshot = preview_app
    legacy = {**snapshot, "id": "legacy-job", "frames": [], "detections": [snapshot["frames"][0]]}
    app.extensions["persistent_store"].save_job("legacy-cache-key", legacy)
    endpoint = "/api/searches/legacy-job/imagery/google-expired"

    def reload():
        with app.test_client() as client:
            response = client.post(endpoint)
            assert response.status_code == 200
            return response.get_json()["imageUrl"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        urls = list(pool.map(lambda _: reload(), range(2)))
    assert urls[0] == urls[1]
    assert len(calls) == 1
    assert app.extensions["persistent_store"].usage()["google"]["usedUsd"] == 0.007


def test_reload_rejects_unknown_or_non_google_views_and_enforces_cap_before_network(preview_app):
    app, calls, _, snapshot = preview_app
    client = app.test_client()
    assert client.post("/api/searches/recorded-job/imagery/unrecorded-pano").status_code == 404
    assert client.post("/api/searches/unrecorded-job/imagery/google-expired").status_code == 404
    non_google = {**snapshot, "id": "owned-job", "frames": [{**snapshot["frames"][0], "source": {"provider": "owned", "imageUrl": "/api/imagery/owned-photo"}}]}
    store = app.extensions["persistent_store"]
    store.save_job("owned-cache-key", non_google)
    assert client.post("/api/searches/owned-job/imagery/google-expired").status_code == 409
    store.reserve("google", 4_000_000, "test_budget_exhaustion")
    response = client.post("/api/searches/recorded-job/imagery/google-expired")
    assert response.status_code == 402
    assert response.get_json()["error"]["code"] == "budget_exhausted"
    assert calls == []


def test_uncertain_reload_retains_reservation_without_returning_provider_secret(preview_app, monkeypatch):
    app, calls, _, _ = preview_app

    class FailingClient:
        def __init__(self, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        @contextmanager
        def stream(self, *args, **kwargs):
            raise httpx.ReadTimeout("private-google-test-key in raw network diagnostics")
            yield

    monkeypatch.setattr("cartographer.live.httpx.Client", FailingClient)
    response = app.test_client().post("/api/searches/recorded-job/imagery/google-expired")
    assert response.status_code == 503
    assert "private-google-test-key" not in response.get_data(as_text=True)
    assert app.extensions["persistent_store"].usage()["google"]["reservedUsd"] == 0.01
