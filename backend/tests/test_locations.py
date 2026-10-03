import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse

import pytest

from cartographer.errors import ApiError
from cartographer.locations import LocationService
from cartographer.storage import PersistentStore


class Response:
    def __init__(self, payload):
        self.data = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, limit):
        return self.data[:limit]


def google_response():
    return {"status": "OK", "results": [{
        "place_id": "example-place", "formatted_address": "Example Hall, Ithaca, NY, USA",
        "geometry": {"location": {"lat": 42.445, "lng": -76.48}, "viewport": {
            "southwest": {"lat": 42.444, "lng": -76.481}, "northeast": {"lat": 42.446, "lng": -76.479},
        }},
    }]}


@pytest.fixture
def store(mongo_settings):
    store = PersistentStore(**mongo_settings)
    yield store
    store.close()


def no_external_request(*_, **__):
    pytest.fail("A local or cached lookup reached an external provider")


@pytest.mark.parametrize("query", ["Duffield", "Duffield Hall Cornell", " DUFFIELD HALL, Cornell University ", "Duffield Hall at Cornell", "343 Campus Road"])
def test_duffield_is_a_verified_local_destination(query, monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", no_external_request)
    result = LocationService().search(query)["locations"]
    assert len(result) == 1
    assert result[0]["label"] == "Duffield Hall, Cornell University"
    assert result[0]["position"] == {"longitude": -76.48278, "latitude": 42.444862}
    assert result[0]["referenceUrl"] == "https://events.cornell.edu/duffield_hall"
    assert "aliases" not in result[0]


def test_google_does_not_spend_for_typing_or_local_places(store, monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", no_external_request)
    service = LocationService(google_key="test-key", store=store)
    assert service.configured is True
    assert service.search("An arbitrary building")["locations"] == []
    assert service.search("Duffield Hall Cornell", remote=True)["locations"][0]["id"] == "duffield-hall"
    assert store.usage()["google"]["usedUsd"] == 0
    assert store.usage()["google"]["reservedUsd"] == 0


@pytest.mark.parametrize(("query", "latitude", "longitude"), [
    ("42.44515275699593, -76.48293788666092", 42.44515275699593, -76.48293788666092),
    ("  +42.44515 , -76.48294  ", 42.44515, -76.48294),
    ("0, 0", 0, 0),
    ("-90, 180", -90, 180),
])
def test_decimal_coordinates_are_free_navigation_with_full_precision(query, latitude, longitude, monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", no_external_request)
    result = LocationService().search(query, remote=True)
    assert len(result["locations"]) == 1
    location = result["locations"][0]
    assert location["label"] == "Map coordinates"
    assert location["position"] == {"longitude": longitude, "latitude": latitude}
    assert location["description"] == f"{latitude:.6f}, {longitude:.6f}"
    assert location["source"] == "coordinates"
    assert "detections" not in result
    assert "featureType" not in location


@pytest.mark.parametrize("query", ["91, -76", "-90.01, 0", "42, 180.01", "0, -181", "NaN, 0", "0, Infinity"])
def test_invalid_coordinate_ranges_are_clear_local_errors(query, monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", no_external_request)
    with pytest.raises(ApiError) as error:
        LocationService().search(query, remote=True)
    assert error.value.code == "invalid_location_coordinates"
    assert "latitude between -90 and 90" in error.value.message
    assert "longitude between -180 and 180" in error.value.message


def test_coordinate_navigation_never_uses_a_configured_google_budget(store, monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", no_external_request)
    service = LocationService(google_key="test-key", store=store)
    service.search("42.44515275699593, -76.48293788666092", remote=True)
    with pytest.raises(ApiError, match="latitude between"):
        service.search("91, -76", remote=True)
    assert store.usage()["google"]["usedUsd"] == 0
    assert store.usage()["google"]["reservedUsd"] == 0
    assert store.db.location_queries.count_documents({}) == 0


def test_place_names_with_commas_still_use_the_local_catalog(monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", no_external_request)
    result = LocationService().search("Ithaca, New York")
    assert result["locations"][0]["id"] == "ithaca"


def test_google_reserves_before_call_and_reuses_mongo_cache_after_service_restart(store, monkeypatch):
    calls = []

    def request(request, timeout):
        calls.append(request)
        assert timeout == 3
        assert store.usage()["google"]["reservedUsd"] == 0.01
        parameters = parse_qs(urlparse(request.full_url).query)
        assert parameters == {"address": ["Example Hall"], "key": ["private-test-key"]}
        return Response(google_response())

    monkeypatch.setattr("cartographer.locations.urlopen", request)
    first = LocationService(google_key="private-test-key", store=store).search("Example Hall", remote=True)
    second = LocationService(google_key="private-test-key", store=store).search(" example hall ", remote=True)
    assert second == first
    assert len(calls) == 1
    assert first["locations"][0]["source"] == "google"
    assert first["locations"][0]["bounds"] == {"south": 42.444, "north": 42.446, "west": -76.481, "east": -76.479}
    assert "private-test-key" not in json.dumps(first)
    assert store.usage()["google"] == {"limitUsd": 4, "usedUsd": 0.005, "reservedUsd": 0, "remainingUsd": 3.995}
    assert store.usage()["openai"]["usedUsd"] == 0
    assert store.db.location_queries.index_information()["expires_at_1"]["expireAfterSeconds"] == 0
    second["locations"][0]["position"]["latitude"] = 0
    assert LocationService(google_key="private-test-key", store=store).search("Example Hall", remote=True) == first


def test_expired_location_cache_is_refreshed_instead_of_used(store, monkeypatch):
    calls = []
    monkeypatch.setattr("cartographer.locations.urlopen", lambda *args, **kwargs: calls.append(args) or Response(google_response()))
    service = LocationService(google_key="test-key", store=store)
    service.search("Example Hall", remote=True)
    store.db.location_queries.update_many({}, {"$set": {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}})
    service.search("Example Hall", remote=True)
    assert len(calls) == 2
    assert store.usage()["google"]["usedUsd"] == 0.01


def test_simultaneous_identical_submissions_share_one_paid_lookup(store, monkeypatch):
    calls = []
    monkeypatch.setattr("cartographer.locations.urlopen", lambda *args, **kwargs: calls.append(args) or Response(google_response()))
    service = LocationService(google_key="test-key", store=store)
    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(service.search, "Example Hall", remote=True)
        second = workers.submit(service.search, "Example Hall", remote=True)
        assert first.result() == second.result()
    assert len(calls) == 1
    assert store.usage()["google"]["usedUsd"] == 0.005


def test_google_empty_response_is_cached_and_bounded(store, monkeypatch):
    calls = []
    monkeypatch.setattr("cartographer.locations.urlopen", lambda *args, **kwargs: calls.append(args) or Response({"status": "ZERO_RESULTS", "results": []}))
    service = LocationService(google_key="test-key", store=store)
    assert service.search("A nonexistent destination", remote=True)["locations"] == []
    assert service.search("A nonexistent destination", remote=True)["locations"] == []
    assert len(calls) == 1
    assert store.usage()["google"]["usedUsd"] == 0.005


def test_budget_failure_prevents_the_geocoding_request(store, monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", no_external_request)
    store.reserve("google", 3_995_000, "Earlier uncertain spending")
    with pytest.raises(ApiError) as error:
        LocationService(google_key="test-key", store=store).search("Example Hall", remote=True)
    assert error.value.code == "budget_exhausted"


def test_uncertain_failure_keeps_reservation_and_never_retries_or_leaks_key(store, monkeypatch):
    calls = []

    def request(*args, **kwargs):
        calls.append(args)
        raise URLError("private-test-key appeared in a provider diagnostic")

    monkeypatch.setattr("cartographer.locations.urlopen", request)
    with pytest.raises(ApiError) as error:
        LocationService(google_key="private-test-key", store=store).search("Example Hall", remote=True)
    assert error.value.code == "location_provider_unavailable"
    assert "private-test-key" not in error.value.message
    assert len(calls) == 1
    assert store.usage()["google"]["reservedUsd"] == 0.01
    assert store.db.location_queries.count_documents({}) == 0


def test_denied_geocoding_explains_enabled_api_without_leaking_provider_diagnostics(store, monkeypatch):
    monkeypatch.setattr("cartographer.locations.urlopen", lambda *args, **kwargs: Response({"status": "REQUEST_DENIED", "error_message": "private-test-key is rejected", "results": []}))
    with pytest.raises(ApiError) as error:
        LocationService(google_key="private-test-key", store=store).search("Example Hall", remote=True)
    assert error.value.code == "google_geocoding_unavailable"
    assert "Enable the Geocoding API" in error.value.message
    assert "private-test-key" not in error.value.message
    assert store.usage()["google"]["usedUsd"] == 0
    assert store.usage()["google"]["reservedUsd"] == 0


def test_invalid_provider_coordinates_are_not_returned_or_cached(store, monkeypatch):
    payload = google_response()
    payload["results"][0]["geometry"]["location"]["lat"] = 91
    monkeypatch.setattr("cartographer.locations.urlopen", lambda *args, **kwargs: Response(payload))
    with pytest.raises(ApiError) as error:
        LocationService(google_key="test-key", store=store).search("Example Hall", remote=True)
    assert error.value.code == "location_provider_unavailable"
    assert store.db.location_queries.count_documents({}) == 0
    assert store.usage()["google"]["reservedUsd"] == 0.01


def test_explicit_nominatim_configuration_takes_priority_and_never_spends_google(store, monkeypatch):
    calls = []

    def request(request, timeout):
        calls.append(request)
        assert request.full_url.startswith("https://geocoder.example/search?")
        return Response([{"place_id": 1, "name": "Example Hall", "display_name": "Example Hall, Ithaca", "lat": "42.445", "lon": "-76.48"}])

    monkeypatch.setattr("cartographer.locations.urlopen", request)
    service = LocationService(endpoint="https://geocoder.example/search", google_key="test-key", store=store)
    assert service.search("Example Hall")["locations"] == []
    assert service.search("Example Hall", remote=True)["locations"][0]["source"] == "nominatim"
    assert len(calls) == 1
    assert store.usage()["google"]["usedUsd"] == 0


def test_google_cannot_be_configured_without_persistent_accounting():
    with pytest.raises(ValueError, match="persistent spending ledger"):
        LocationService(google_key="test-key")
