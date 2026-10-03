import threading
from contextlib import contextmanager

from cartographer.panoramax import PanoramaxImagery
from cartographer.storage import PersistentStore
from test_live_and_storage import image_bytes


def feature(image_id, latitude, longitude, license_name="CC-BY-SA-4.0", asset_host="panoramax.openstreetmap.fr"):
    return {
        "id": image_id,
        "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
        "properties": {"license": license_name, "view:azimuth": 402, "geovisio:producer": "Test contributor", "datetime": "2025-10-31T12:00:00Z"},
        "providers": [{"name": "OpenStreetMap France"}],
        "assets": {"sd": {"href": f"https://{asset_host}/images/{image_id}.jpg"}},
        "links": [{"rel": "license", "href": "https://creativecommons.org/licenses/by-sa/4.0/"}],
    }


def test_discovery_filter_license_spatial_sample_and_persistent_image_cache(tmp_path, monkeypatch, area, mongo_settings):
    photos = [
        feature("close-a", 42.4483, -76.4830),
        feature("close-b", 42.44831, -76.4830),
        feature("distant-a", 42.4503, -76.4830),
        feature("distant-b", 42.4463, -76.4840),
        feature("outside", 44, -76.4830),
        feature("restricted", 42.4483, -76.4830, "proprietary"),
        feature("unsafe", 42.4483, -76.4830, asset_host="localhost"),
    ]
    calls = []
    class Response:
        headers = {"content-type": "image/jpeg"}
        def raise_for_status(self):
            pass
        def json(self):
            return {"features": photos}
        def iter_bytes(self):
            yield image_bytes()
    class Client:
        def __init__(self, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def get(self, url, **kwargs):
            calls.append(("metadata", url))
            return Response()
        @contextmanager
        def stream(self, method, url):
            calls.append(("image", url))
            yield Response()
    monkeypatch.setattr("cartographer.panoramax.httpx.Client", Client)
    store = PersistentStore(**mongo_settings)
    provider = PanoramaxImagery(store, max_images=3)
    records = provider.records(area, threading.Event())
    assert records[0]["id"] == "panoramax-close-a"
    assert {record["id"] for record in records} == {"panoramax-close-a", "panoramax-distant-a", "panoramax-distant-b"}
    assert records[0]["metadata"]["heading"] == 42
    assert records[0]["source"]["license"]["name"] == "CC-BY-SA-4.0"
    assert "Test contributor" in records[0]["source"]["attribution"]
    first = provider.image_bytes(records[0], threading.Event())
    cached_file = provider.image_path(records[0]["id"])
    assert cached_file.read_bytes() == first
    restarted = PanoramaxImagery(PersistentStore(**mongo_settings), max_images=3)
    assert restarted.records(area, threading.Event()) == records
    assert restarted.image_bytes(records[0], threading.Event()) == first
    assert [call[0] for call in calls] == ["metadata", "metadata", "metadata", "metadata", "image"]
    assert store.usage()["google"]["usedUsd"] == 0
    assert store.usage()["openai"]["usedUsd"] == 0
