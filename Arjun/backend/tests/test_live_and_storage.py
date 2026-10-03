import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from PIL import Image

from cartographer import create_app
from cartographer.errors import ApiError
from cartographer.live import LiveProvider, normalize_image, validate_vision_output
from cartographer.sampling import sample_area
from cartographer.storage import PersistentStore
from test_api import finish


def image_bytes(size=(1000, 900)):
    output = io.BytesIO()
    Image.new("RGB", size, "gray").save(output, format="JPEG")
    return output.getvalue()


def detection():
    return {"title": "Bench", "description": "Visible seating beside a path", "featureType": "bench", "confidence": 0.88, "attributes": {"material": "wood", "covered": False, "accessible": None, "notes": None}, "visualEvidence": "A complete wooden seat, backrest and legs are visible beside the path.", "imageBoundingBox": {"x": 0.2, "y": 0.3, "width": 0.25, "height": 0.2}}


def test_budget_reservations_are_atomic_and_survive_restart(mongo_settings):
    store = PersistentStore(**mongo_settings)
    def reserve():
        try:
            return store.reserve("openai", 1_000_000, "concurrent-test")
        except ApiError as error:
            assert error.code == "budget_exhausted"
            return None
    with ThreadPoolExecutor(max_workers=3) as executor:
        reservations = list(executor.map(lambda _: reserve(), range(3)))
    successful = [item for item in reservations if item]
    assert len(successful) == 2
    restarted = PersistentStore(**mongo_settings)
    assert restarted.usage()["openai"]["reservedUsd"] == 2
    assert restarted.usage()["openai"]["remainingUsd"] == 0
    restarted.settle(successful[0], 100)
    assert restarted.usage()["openai"]["usedUsd"] == 0.0001
    assert restarted.usage()["openai"]["reservedUsd"] == 1
    assert restarted.usage()["google"]["remainingUsd"] == 4


def test_owned_live_pipeline_cache_restart_and_safe_image_route(tmp_path, monkeypatch, area, mongo_settings):
    photograph = tmp_path / "source.jpg"
    photograph.write_bytes(image_bytes())
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([{"id": "owned-photo", "position": area["center"], "path": str(photograph), "attribution": "Test-owned photograph"}]))
    calls = []
    class FakeOpenAI:
        def __init__(self, **kwargs):
            assert kwargs["max_retries"] == 0
            self.responses = self
        def create(self, **kwargs):
            calls.append(kwargs)
            assert kwargs["model"] == "gpt-4.1"
            assert kwargs["max_output_tokens"] == 1200
            assert kwargs["text"]["format"]["strict"] is True
            return SimpleNamespace(status="completed", output_text=json.dumps({"detections": [detection()]}), usage=SimpleNamespace(input_tokens=100, output_tokens=50))
        def close(self):
            pass
    monkeypatch.setattr("cartographer.live.OpenAI", FakeOpenAI)
    config = {"TESTING": True, "MONGODB_URI": mongo_settings["uri"], "MONGODB_DATABASE": mongo_settings["database"], "CACHE_DIRECTORY": mongo_settings["cache_directory"], "OPENAI_API_KEY": "test-key", "GOOGLE_MAPS_API_KEY": None, "IMAGERY_PROVIDER": "none", "IMAGERY_MANIFEST": manifest, "SEARCH_STEP_SECONDS": 0.001}
    app = create_app(config)
    try:
        client = app.test_client()
        assert client.get("/api/health").get_json()["liveSearchAvailable"] is True
        job = client.post("/api/searches", json={"query": "find benches", "area": area}).get_json()
        completed = finish(client, job["id"])
        assert completed["status"] == "completed"
        assert completed["mode"] == "live"
        result = completed["detections"][0]
        assert result["position"] == area["center"]
        assert result["metadata"]["positionAccuracy"] == "camera-location"
        assert result["metadata"]["uncertaintyMeters"] == 50
        assert result["source"]["provider"] == "owned"
        assert client.get("/api/imagery/owned-photo").data == photograph.read_bytes()
        assert client.get("/api/imagery/arbitrary-file").status_code == 404
        assert client.get("/api/usage").get_json()["openai"]["usedUsd"] == 0.0006
        repeat = client.post("/api/searches", json={"query": "find benches", "area": area}).get_json()
        assert repeat["cacheHit"] is True
        assert len(calls) == 1
    finally:
        app.extensions["search_service"].shutdown()
        app.extensions["persistent_store"].close()
    restarted = create_app(config)
    try:
        repeated = restarted.test_client().post("/api/searches", json={"query": "find benches", "area": area}).get_json()
        assert repeated["cacheHit"] is True
        assert len(calls) == 1
        assert restarted.test_client().get("/api/usage").get_json()["openai"]["usedUsd"] == 0.0006
    finally:
        restarted.extensions["search_service"].shutdown()
        restarted.extensions["persistent_store"].close()


def test_uncertain_vision_failure_keeps_reservation(tmp_path, monkeypatch, mongo_settings):
    class FailingOpenAI:
        def __init__(self, **kwargs):
            self.responses = self
        def create(self, **kwargs):
            raise TimeoutError("remote response uncertain")
        def close(self):
            pass
    monkeypatch.setattr("cartographer.live.OpenAI", FailingOpenAI)
    store = PersistentStore(**mongo_settings)
    provider = LiveProvider(store, "test-key", None, tmp_path / "manifest.json")
    with pytest.raises(ApiError, match="uncertain spending"):
        provider._analyze("benches", image_bytes(), {"longitude": 0, "latitude": 0}, {"provider": "owned"}, {}, threading.Event())
    assert PersistentStore(**mongo_settings).usage()["openai"]["reservedUsd"] == 0.04
    assert store.usage()["openai"]["usedUsd"] == 0


def test_cancel_before_analysis_makes_no_paid_call(tmp_path, monkeypatch, mongo_settings):
    def forbidden(*args, **kwargs):
        pytest.fail("Cancelled analysis reached the paid provider")
    monkeypatch.setattr("cartographer.live.OpenAI", forbidden)
    store = PersistentStore(**mongo_settings)
    provider = LiveProvider(store, "test-key", None, tmp_path / "manifest.json")
    cancellation = threading.Event()
    cancellation.set()
    assert provider._analyze("benches", image_bytes(), {"longitude": 0, "latitude": 0}, {}, {}, cancellation) == []
    assert store.usage()["openai"]["remainingUsd"] == 2


def test_google_is_ready_with_keys_for_local_prototype(tmp_path, mongo_settings):
    provider = LiveProvider(PersistentStore(**mongo_settings), "test-key", "google-test-key", tmp_path / "manifest.json")
    assert provider.imagery_provider == "google"
    assert provider.available is True
    provider.require_available()
    assert provider.store.usage()["google"]["remainingUsd"] == 4


def test_normalization_schema_and_sampling(area):
    normalized = normalize_image(image_bytes())
    with Image.open(io.BytesIO(normalized)) as image:
        assert image.width <= 1024 and image.height <= 1024
    assert validate_vision_output({"detections": [detection()]})[0]["attributes"] == {"material": "wood", "covered": False}
    invented_coordinates = {**detection(), "latitude": 42}
    with pytest.raises(ValueError):
        validate_vision_output({"detections": [invented_coordinates]})
    assert len(sample_area(area)) == 6
    from cartographer.geography import contains
    assert all(contains(area, sample) for sample in sample_area(area))
