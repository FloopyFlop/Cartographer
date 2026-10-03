import time

import pytest

from cartographer.geography import contains, validate_area


def finish(client, job_id):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        job = client.get(f"/api/searches/{job_id}").get_json()
        if job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.002)
    pytest.fail("Search did not finish")


def test_progressive_demo_contract(client, area):
    response = client.post("/api/searches", json={"query": "Find bicycle racks within one mile of Cornell University", "area": area})
    assert response.status_code == 202
    started = response.get_json()
    assert started["status"] == "queued"
    assert started["mode"] == "demo"
    intermediate = []
    while True:
        job = client.get("/api/searches/" + started["id"]).get_json()
        intermediate.append(len(job["detections"]))
        if job["status"] == "completed":
            break
        time.sleep(0.002)
    assert any(0 < count < 12 for count in intermediate)
    assert len(job["detections"]) == 12
    assert job["progress"]["completed"] == job["progress"]["total"]
    for detection in job["detections"]:
        assert detection["searchId"] == job["id"]
        assert detection["source"]["provider"] == "demo"
        assert detection["metadata"]["confidenceIsIllustrative"] is True
        assert contains(area, detection["position"])
    repeat = client.post("/api/searches", json={"query": job["query"], "area": {**area, "label": "Renamed area"}}).get_json()
    assert repeat["id"] == started["id"]
    assert repeat["cacheHit"] is True


def test_cancel_is_idempotent_and_stops_results(client, area):
    job = client.post("/api/searches", json={"query": "benches", "area": area}).get_json()
    cancelled = client.delete("/api/searches/" + job["id"]).get_json()
    assert cancelled["status"] == "cancelled"
    time.sleep(0.07)
    assert client.get("/api/searches/" + job["id"]).get_json() == cancelled
    assert client.delete("/api/searches/" + job["id"]).get_json() == cancelled


def test_cancellation_retains_progressive_partial_results(client, area):
    started = client.post("/api/searches", json={"query": "bicycle racks", "area": area}).get_json()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        job = client.get("/api/searches/" + started["id"]).get_json()
        if job["detections"]:
            break
        time.sleep(0.002)
    cancelled = client.delete("/api/searches/" + started["id"]).get_json()
    assert cancelled["status"] == "cancelled"
    assert 0 < len(cancelled["detections"]) < 12
    time.sleep(0.06)
    assert client.get("/api/searches/" + started["id"]).get_json()["detections"] == cancelled["detections"]


def test_unknown_object_is_honest_empty_state(client, area):
    started = client.post("/api/searches", json={"query": "purple umbrellas", "area": area}).get_json()
    job = finish(client, started["id"])
    assert job["status"] == "completed"
    assert job["detections"] == []
    assert "No demonstration layer" in job["progress"]["stage"]


def test_far_area_does_not_move_or_manufacture_samples(client):
    area = {"kind": "radius", "center": {"longitude": -0.1276, "latitude": 51.5074}, "radiusMeters": 1000}
    started = client.post("/api/searches", json={"query": "benches", "area": area}).get_json()
    assert finish(client, started["id"])["detections"] == []


def test_singleflight_same_search(client, area):
    body = {"query": "benches", "area": area}
    first = client.post("/api/searches", json=body).get_json()
    second = client.post("/api/searches", json=body).get_json()
    assert first["id"] == second["id"]


def test_active_queue_limit_is_bounded(area):
    from cartographer.errors import ApiError
    from cartographer.searches import SearchService
    service = SearchService(step_seconds=0.5, max_active=1)
    try:
        job = service.submit({"query": "benches", "area": area})
        with pytest.raises(ApiError) as error:
            service.submit({"query": "bicycle racks", "area": area})
        assert error.value.code == "too_many_searches"
        service.cancel(job["id"])
        assert service.submit({"query": "bicycle racks", "area": area})["status"] == "queued"
    finally:
        service.shutdown()


@pytest.mark.parametrize("change", [
    {"query": ""}, {"query": "x" * 1001}, {"mode": "invalid"}, {"area": None},
    {"area": {"kind": {}}},
    {"area": {"kind": "radius", "center": {"longitude": False, "latitude": 10}, "radiusMeters": 100}},
    {"area": {"kind": "radius", "center": {"longitude": 0, "latitude": float("nan")}, "radiusMeters": 100}},
    {"area": {"kind": "radius", "center": {"longitude": 0, "latitude": 10}, "radiusMeters": 0}},
    {"area": {"kind": "region", "bounds": {"west": -180, "east": 180, "south": -90, "north": 90}}},
    {"area": {"kind": "route", "coordinates": [{"longitude": 0, "latitude": 0}], "corridorMeters": 10}},
])
def test_invalid_requests_are_structured_400(client, area, change):
    response = client.post("/api/searches", json={"query": "benches", "area": area, **change})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"]


def test_unknown_and_invalid_json_endpoints(client):
    assert client.get("/api/searches/missing").status_code == 404
    assert client.delete("/api/searches/missing").status_code == 404
    response = client.post("/api/searches", data="{broken", content_type="application/json")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_json"
    assert client.post("/api/searches", json=[]).status_code == 400
    assert client.post("/api/usage/reset").status_code == 404


def test_health_usage_and_local_locations(client):
    health = client.get("/api/health").get_json()
    assert health["provider"] == "demo"
    assert health["liveSearchAvailable"] is False
    usage = client.get("/api/usage").get_json()
    assert usage["google"]["limitUsd"] == 4
    assert usage["openai"]["limitUsd"] == 2
    assert client.get("/api/locations?q=cornell").get_json()["locations"][0]["label"] == "Cornell University"
    assert len(client.get("/api/locations").get_json()["locations"]) == 6
    assert client.get("/api/locations?q=unconfigured-place").get_json()["locations"] == []


def test_geographic_filter_supports_route_and_antimeridian():
    route = validate_area({"kind": "route", "coordinates": [{"longitude": 0, "latitude": 0}, {"longitude": 0.01, "latitude": 0}], "corridorMeters": 30})
    assert contains(route, {"longitude": 0.005, "latitude": 0.0001})
    assert not contains(route, {"longitude": 0.005, "latitude": 0.001})
    assert not contains(route, {"longitude": -0.001, "latitude": 0})
    wrapped = validate_area({"kind": "region", "bounds": {"west": 179.99, "east": -179.99, "south": -0.01, "north": 0.01}})
    assert contains(wrapped, {"longitude": -179.995, "latitude": 0})
    assert contains(wrapped, {"longitude": 179.995, "latitude": 0})
    assert not contains(wrapped, {"longitude": 0, "latitude": 0})
