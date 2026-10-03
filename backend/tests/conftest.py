import os
import uuid

import pytest
from pymongo import MongoClient

from cartographer import create_app


@pytest.fixture
def mongo_settings(tmp_path):
    uri = os.environ.get("CARTOGRAPHER_TEST_MONGODB_URI", "mongodb://127.0.0.1:27018")
    database = "cartographer_test_" + uuid.uuid4().hex
    client = MongoClient(uri, serverSelectionTimeoutMS=3000)
    client.admin.command("ping")
    yield {"uri": uri, "database": database, "cache_directory": tmp_path}
    assert database.startswith("cartographer_test_")
    client.drop_database(database)
    client.close()


@pytest.fixture
def app(tmp_path, mongo_settings):
    app = create_app({
        "TESTING": True,
        "MONGODB_URI": mongo_settings["uri"],
        "MONGODB_DATABASE": mongo_settings["database"],
        "CACHE_DIRECTORY": mongo_settings["cache_directory"],
        "OPENAI_API_KEY": None,
        "GOOGLE_MAPS_API_KEY": None,
        "IMAGERY_PROVIDER": "none",
        "IMAGERY_MANIFEST": tmp_path / "manifest.json",
        "GEOCODER_URL": None,
        "SEARCH_STEP_SECONDS": 0.012,
        "SEARCH_STEPS": 4,
    })
    yield app
    app.extensions["search_service"].shutdown()
    app.extensions["persistent_store"].close()


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def area():
    return {"kind": "radius", "center": {"longitude": -76.483, "latitude": 42.4483}, "radiusMeters": 1600, "label": "Cornell University"}
