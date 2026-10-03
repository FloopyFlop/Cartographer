import base64
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from flask import Flask, jsonify
from pymongo.errors import ConnectionFailure

from cartographer import create_app, production
from cartographer.errors import ApiError
from cartographer.storage import PersistentStore


def authorization(username, password):
    value = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": "Basic " + value}


@pytest.fixture
def protected_client(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("Private Cartographer")
    (dist / "app.js").write_text("private asset")
    api = Flask(__name__)
    api.config.update(AUTH_REQUIRED=True, AUTH_USERNAME="owner", AUTH_PASSWORD="private-password")

    @api.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    @api.post("/api/searches")
    def search():
        return jsonify({"started": True})

    @api.get("/api/locations")
    def locations():
        return jsonify({"locations": []})

    monkeypatch.setattr(production, "create_app", lambda: api)
    return production.create_production_app(dist).test_client()


def test_production_protects_ui_assets_and_paid_api_routes_but_exempts_readiness(protected_client):
    client = protected_client
    for method, path in [("get", "/"), ("get", "/app.js"), ("get", "/api/locations?remote=1"), ("post", "/api/searches"), ("post", "/api/searches/job/imagery/frame")]:
        response = getattr(client, method)(path)
        assert response.status_code == 401
        assert response.headers["WWW-Authenticate"] == 'Basic realm="Cartographer", charset="UTF-8"'
        assert response.get_json()["error"]["code"] == "authentication_required"
        assert response.headers["Cache-Control"] == "no-store"
        assert "private-password" not in response.get_data(as_text=True)
    assert client.get("/api/health").get_json() == {"status": "ok"}
    assert client.get("/").status_code == 401
    assert client.get("/", headers=authorization("owner", "private-password")).data == b"Private Cartographer"
    assert client.post("/api/searches", headers={**authorization("owner", "private-password"), "X-Cartographer-Request": "1"}).get_json() == {"started": True}
    for username, password in [("owner", "wrong"), ("wrong", "private-password"), ("øwner", "pässword")]:
        assert client.get("/", headers=authorization(username, password)).status_code == 401


@pytest.mark.parametrize("username,password", [(None, None), ("", "secret"), ("owner", ""), ("owner", "   "), ("invalid:owner", "secret")])
def test_required_auth_fails_closed_for_missing_credentials(tmp_path, monkeypatch, username, password):
    (tmp_path / "index.html").write_text("interface")
    api = Flask(__name__)
    api.config.update(AUTH_REQUIRED=True, AUTH_USERNAME=username, AUTH_PASSWORD=password)
    searches, store = SimpleNamespace(shutdown=Mock()), SimpleNamespace(close=Mock())
    api.extensions.update(search_service=searches, persistent_store=store)
    monkeypatch.setattr(production, "create_app", lambda: api)
    with pytest.raises(RuntimeError, match="nonempty CARTOGRAPHER_AUTH_USERNAME") as error:
        production.create_production_app(tmp_path)
    assert "secret" not in str(error.value)
    searches.shutdown.assert_called_once()
    store.close.assert_called_once()


def test_optional_local_production_remains_open_when_credentials_exist(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("interface")
    api = Flask(__name__)
    api.config.update(AUTH_REQUIRED=False, AUTH_USERNAME="owner", AUTH_PASSWORD="secret")
    monkeypatch.setattr(production, "create_app", lambda: api)
    assert production.create_production_app(tmp_path).test_client().get("/").status_code == 200


def test_project_env_credentials_take_precedence_and_explicit_test_config_wins(tmp_path, mongo_settings, monkeypatch):
    import cartographer

    calls = []
    monkeypatch.setattr(cartographer, "load_dotenv", lambda path, **kwargs: calls.append(Path(path)))
    def values(path):
        if Path(path).parent.name == "backend":
            return {"OPENAI_API_KEY": "legacy-openai", "GOOGLE_MAPS_API_KEY": "legacy-google"}
        return {"OPENAI_API_KEY": "project-openai", "GOOGLE_MAPS_API_KEY": "project-google"}
    monkeypatch.setattr(cartographer, "dotenv_values", values)
    config = {"TESTING": True, "MONGODB_URI": mongo_settings["uri"], "MONGODB_DATABASE": mongo_settings["database"], "CACHE_DIRECTORY": tmp_path, "IMAGERY_MANIFEST": tmp_path / "manifest.json", "AUTH_REQUIRED": False}
    app = create_app(config)
    try:
        assert calls[0].parent.name != "backend" and calls[1].parent.name == "backend"
        assert app.extensions["live_provider"].openai_key == "project-openai"
        assert app.extensions["live_provider"].google_key == "project-google"
    finally:
        app.extensions["search_service"].shutdown()
        app.extensions["live_provider"].google_images.close()
        app.extensions["persistent_store"].close()
    app = create_app({**config, "OPENAI_API_KEY": None, "GOOGLE_MAPS_API_KEY": None})
    try:
        assert app.extensions["live_provider"].openai_key is None
        assert app.extensions["live_provider"].google_key is None
    finally:
        app.extensions["search_service"].shutdown()
        app.extensions["live_provider"].google_images.close()
        app.extensions["persistent_store"].close()


def test_live_readiness_checks_database_and_limits_production_payload(app, monkeypatch):
    client = app.test_client()
    store = app.extensions["persistent_store"]
    ping = Mock()
    monkeypatch.setattr(store, "ping", ping)
    assert client.get("/api/health").get_json()["status"] == "ok"
    ping.assert_called_once()
    app.config["HEALTH_MINIMAL"] = True
    assert client.get("/api/health").get_json() == {"status": "ok"}
    with monkeypatch.context() as patch:
        patch.setattr(store, "client", SimpleNamespace(admin=SimpleNamespace(command=Mock(side_effect=ConnectionFailure("database credentials remain private")))))
        patch.setattr(store, "ping", lambda: PersistentStore.ping(store))
        with pytest.raises(ApiError) as error:
            PersistentStore.ping(store)
        assert error.value.code == "database_unavailable"
        response = client.get("/api/health")
        assert response.status_code == 503
        assert response.get_json() == {"status": "unavailable"}
        assert "credentials" not in response.get_data(as_text=True)


def test_authenticated_health_preserves_search_configuration_while_public_probe_is_minimal(app, tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("interface")
    app.config.update(AUTH_REQUIRED=True, AUTH_USERNAME="owner", AUTH_PASSWORD="private-password")
    monkeypatch.setattr(production, "create_app", lambda: app)
    client = production.create_production_app(tmp_path).test_client()
    assert client.get("/api/health").get_json() == {"status": "ok"}
    assert client.get("/api/health", headers=authorization("owner", "wrong")).get_json() == {"status": "ok"}
    health = client.get("/api/health", headers=authorization("owner", "private-password")).get_json()
    assert health["status"] == "ok"
    assert health["provider"] == "demo"
    assert health["liveSearchAvailable"] is False
    assert "locationSearchConfigured" in health


def test_local_production_health_preserves_full_application_contract(app, tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("interface")
    app.config["AUTH_REQUIRED"] = False
    monkeypatch.setattr(production, "create_app", lambda: app)
    health = production.create_production_app(tmp_path).test_client().get("/api/health").get_json()
    assert health["status"] == "ok"
    assert health["provider"] == "demo"
    assert health["liveSearchAvailable"] is False


@pytest.mark.parametrize("header", [None, "0", "1, 1"])
def test_authenticated_paid_actions_require_valid_header_before_provider_calls(app, tmp_path, monkeypatch, header):
    (tmp_path / "index.html").write_text("interface")
    app.config.update(AUTH_REQUIRED=True, AUTH_USERNAME="owner", AUTH_PASSWORD="private-password")
    monkeypatch.setattr(production, "create_app", lambda: app)
    submit = Mock(return_value={"started": True})
    reload = Mock(return_value={"imageUrl": "/api/imagery/google-example"})
    locations = Mock(return_value={"locations": []})
    cancel = Mock(return_value={"status": "cancelled"})
    monkeypatch.setattr(app.extensions["search_service"], "submit", submit)
    monkeypatch.setattr(app.extensions["search_service"], "preview", reload)
    monkeypatch.setattr(app.extensions["search_service"], "cancel", cancel)
    monkeypatch.setattr(app.extensions["location_service"], "search", locations)
    client = production.create_production_app(tmp_path).test_client()
    headers = authorization("owner", "private-password")
    if header is not None:
        headers["X-Cartographer-Request"] = header
    usage_before = app.extensions["persistent_store"].usage()
    for method, path in [("post", "/api/searches"), ("post", "/api/searches/job/imagery/frame"), ("delete", "/api/searches/job"), ("get", "/api/locations?q=example&remote=1")]:
        response = getattr(client, method)(path, headers=headers, data="cross-site form body" if method == "post" else None)
        assert response.status_code == 403
        assert response.get_json()["error"]["code"] == "request_verification_required"
        assert "Access-Control-Allow-Origin" not in response.headers
    submit.assert_not_called()
    reload.assert_not_called()
    cancel.assert_not_called()
    locations.assert_not_called()
    assert app.extensions["persistent_store"].usage() == usage_before
    valid = {**headers, "X-Cartographer-Request": "1"}
    assert client.post("/api/searches", headers=valid, json={}).status_code == 202
    assert client.post("/api/searches/job/imagery/frame", headers=valid).status_code == 200
    assert client.delete("/api/searches/job", headers=valid).status_code == 200
    assert client.get("/api/locations?q=example&remote=1", headers=valid).status_code == 200
    submit.assert_called_once()
    reload.assert_called_once()
    cancel.assert_called_once()
    locations.assert_called_once()


def test_production_read_only_previews_and_local_mode_do_not_require_header(app, tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("interface")
    app.config.update(AUTH_REQUIRED=True, AUTH_USERNAME="owner", AUTH_PASSWORD="private-password")
    monkeypatch.setattr(production, "create_app", lambda: app)
    preview = Mock(return_value=SimpleNamespace(content=b"already fetched pixels", content_type="image/jpeg"))
    monkeypatch.setattr(app.extensions["live_provider"].google_images, "get", preview)
    client = production.create_production_app(tmp_path).test_client()
    headers = authorization("owner", "private-password")
    assert client.get("/api/imagery/google-example", headers=headers).data == b"already fetched pixels"
    assert client.get("/api/usage", headers=headers).status_code == 200
    assert client.get("/api/locations?q=cornell", headers=headers).status_code == 200
    assert client.get("/api/health").get_json() == {"status": "ok"}
    assert client.get("/api/health", headers=headers).get_json()["provider"] == "demo"


def test_local_mode_mutations_work_without_custom_header(app, tmp_path, monkeypatch, area):
    (tmp_path / "index.html").write_text("interface")
    app.config["AUTH_REQUIRED"] = False
    monkeypatch.setattr(production, "create_app", lambda: app)
    remote = Mock(return_value={"locations": []})
    monkeypatch.setattr(app.extensions["location_service"], "search", remote)
    client = production.create_production_app(tmp_path).test_client()
    assert client.post("/api/searches", json={"query": "benches", "area": area, "mode": "precomputed"}).status_code == 202
    assert client.get("/api/locations?q=example&remote=1").status_code == 200
    remote.assert_called_once()
