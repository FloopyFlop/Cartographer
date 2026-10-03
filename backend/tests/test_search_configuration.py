import time

import pytest

from cartographer.errors import ApiError
from cartographer.searches import SearchService, validate_request
from cartographer.storage import PersistentStore


@pytest.mark.parametrize("configuration", [None, [], {"maxImages": True}, {"maxImages": 0}, {"maxImages": 49}, {"maxImages": 4.5}, {"maxImages": "16"}])
def test_rejects_invalid_image_limits(area, configuration):
    with pytest.raises(ApiError) as error:
        validate_request({"query": "bicycle racks", "area": area, "configuration": configuration})
    assert error.value.code == "invalid_configuration"


def test_radius_accepts_arbitrary_distances_and_expanded_range(area):
    _, validated, _, limit = validate_request({"query": "bicycle racks", "area": {**area, "radiusMeters": 321.75}})
    assert validated["radiusMeters"] == 321.75
    assert limit == 16
    assert validate_request({"query": "benches", "area": {**area, "radiusMeters": 50_000}})[1]["radiusMeters"] == 50_000


def test_frames_are_progressive_durable_and_image_limits_partition_cache(mongo_settings, area):
    store = PersistentStore(**mongo_settings)
    calls = []

    class Live:
        available = True

        def require_available(self):
            pass

        def signature(self, area, max_images=None):
            return {"source": "google-test", "maxImages": max_images}

        def search(self, query, area, cancelled, update, max_images=None):
            calls.append(max_images)
            frame = {"id": "frame-1", "position": area["center"], "heading": 90, "source": {"provider": "google", "attribution": "Test imagery", "imageUrl": "/api/imagery/test"}, "detectionsCount": 0, "status": "analyzed"}
            update(1, 2, "Analyzed first photo", [], [frame])
            cancelled.wait(0.04)
            update(2, 2, "Analyzed second photo", [], [frame])

    service = SearchService(store=store, live_provider=Live(), step_seconds=0)
    try:
        payload = {"query": "benches", "area": area, "mode": "live", "configuration": {"maxImages": 8}}
        started = service.submit(payload)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            job = service.get(started["id"])
            if job["frames"]:
                break
            time.sleep(0.002)
        assert job["status"] == "running"
        assert job["frames"][0]["heading"] == 90
        assert store.get_job(started["id"])["frames"] == job["frames"]
        while time.monotonic() < deadline and job["status"] == "running":
            time.sleep(0.002)
            job = service.get(started["id"])
        assert job["status"] == "completed"
        assert len(job["frames"]) == 1
        assert job["detections"] == []
        assert job["configuration"]["maxImages"] == 8
        assert service.submit(payload)["cacheHit"] is True
        assert service.submit({**payload, "configuration": {"maxImages": 12}})["id"] != started["id"]
        assert calls[0] == 8
    finally:
        service.shutdown()
        store.close()
