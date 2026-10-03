import threading
from contextlib import contextmanager

import pytest

from cartographer.live import LiveProvider
from cartographer.sampling import HEADINGS, MAX_VIEWPOINTS, distance_from_area, sample_imagery_locations
from cartographer.storage import PersistentStore
from test_live_and_storage import image_bytes


class JsonResponse:
    def __init__(self, value):
        self.value = value

    def raise_for_status(self):
        pass

    def json(self):
        return self.value


def mocked_google(monkeypatch, camera, calls):
    pixels = image_bytes((640, 640))

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

        def get(self, url, params):
            assert params["source"] == "default"
            assert params["radius"] == 250
            calls["metadata"].append(dict(params))
            return JsonResponse({"status": "OK", "pano_id": f"pano-{len(calls['metadata'])}", "location": {"lat": camera["latitude"], "lng": camera["longitude"]}, "date": "2024-11"})

        @contextmanager
        def stream(self, method, url, params):
            assert params["fov"] == 90
            assert params["heading"] in HEADINGS
            calls["images"].append(dict(params))
            yield ImageResponse()

    monkeypatch.setattr("cartographer.live.httpx.Client", Client)


@pytest.mark.parametrize("limit", [4, 16, 48])
def test_each_job_limit_acquires_complete_cardinal_views_and_retains_empty_evidence(tmp_path, mongo_settings, monkeypatch, area, limit):
    calls = {"metadata": [], "images": []}
    mocked_google(monkeypatch, area["center"], calls)
    store = PersistentStore(**mongo_settings)
    provider = LiveProvider(store, "test-openai-key", "test-google-key", tmp_path / "manifest.json")
    monkeypatch.setattr(provider, "_analyze", lambda *args: [])
    updates = []
    try:
        assert provider.signature(area)["maxImages"] == 16
        assert provider.signature(area, max_images=limit)["maxImages"] == limit
        provider.search("bicycle racks", area, threading.Event(), lambda *args: updates.append(args), max_images=limit)
        frames = [frame for update in updates if len(update) == 5 for frame in update[4]]
        assert len(frames) == limit
        assert len(calls["images"]) == limit
        assert len(calls["metadata"]) == limit // 4
        assert [call["heading"] for call in calls["images"]] == list(HEADINGS) * (limit // 4)
        assert calls["metadata"][0]["location"] == f"{area['center']['latitude']},{area['center']['longitude']}"
        assert all(frame["detectionsCount"] == 0 and frame["status"] == "analyzed" for frame in frames)
        assert all(frame["metadata"]["objectInSearchArea"] == "unknown" for frame in frames)
        assert updates[-1][:2] == (limit, limit)
        # A 48-view job keeps its first and last typical-size previews within
        # the bounded memory cache, without any persistent Google pixels.
        assert provider.google_images.get(frames[0]["id"]).content
        assert provider.google_images.get(frames[-1]["id"]).content
        assert store.db.source_images.count_documents({}) == 0
        assert store.usage()["google"]["usedUsd"] == pytest.approx(limit * 0.007)
        assert store.usage()["openai"]["usedUsd"] == 0
    finally:
        provider.google_images.close()
        store.close()


def test_tiny_landmark_area_can_inspect_nearby_camera_without_claiming_object_coordinates(tmp_path, mongo_settings, monkeypatch, area):
    selected = {**area, "radiusMeters": 25}
    camera = {**area["center"], "latitude": area["center"]["latitude"] + 0.0007}
    assert 0 < distance_from_area(selected, camera) < 250
    calls = {"metadata": [], "images": []}
    mocked_google(monkeypatch, camera, calls)
    store = PersistentStore(**mongo_settings)
    provider = LiveProvider(store, "test-openai-key", "test-google-key", tmp_path / "manifest.json")
    received = []
    monkeypatch.setattr(provider, "_analyze", lambda *args: received.append(args) or [])
    updates = []
    try:
        provider.search("bicycle racks", selected, threading.Event(), lambda *args: updates.append(args), max_images=4)
        frames = [frame for update in updates if len(update) == 5 for frame in update[4]]
        assert len(frames) == 4
        assert all(frame["position"] == camera for frame in frames)
        assert all(frame["metadata"]["cameraInSearchArea"] is False for frame in frames)
        assert all(frame["metadata"]["distanceToSearchAreaMeters"] > 0 for frame in frames)
        assert all(frame["metadata"]["objectInSearchArea"] == "unknown" for frame in frames)
        assert all(call[2] == camera for call in received)
        assert selected["radiusMeters"] == 25
        assert sample_imagery_locations(selected)[0] == selected["center"]
    finally:
        provider.google_images.close()
        store.close()


def test_faraway_cameras_are_rejected_and_metadata_probe_count_is_bounded(tmp_path, mongo_settings, monkeypatch, area):
    selected = {**area, "radiusMeters": 25}
    camera = {**area["center"], "latitude": area["center"]["latitude"] + 0.01}
    calls = {"metadata": [], "images": []}
    mocked_google(monkeypatch, camera, calls)
    store = PersistentStore(**mongo_settings)
    provider = LiveProvider(store, "test-openai-key", "test-google-key", tmp_path / "manifest.json")
    try:
        provider.search("bicycle racks", selected, threading.Event(), lambda *args: None, max_images=48)
        assert len(calls["metadata"]) == MAX_VIEWPOINTS
        assert calls["images"] == []
        assert store.usage()["google"]["remainingUsd"] == 4
    finally:
        provider.google_images.close()
        store.close()
