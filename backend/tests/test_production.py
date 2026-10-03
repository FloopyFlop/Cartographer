from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException

from cartographer import production


@pytest.fixture
def built_client(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "cesium" / "Workers").mkdir(parents=True)
    (dist / "index.html").write_text('<html><div id="root">Built Cartographer</div><script src="/assets/app.js"></script></html>')
    (dist / "assets" / "app.js").write_text("window.cartographer = 'built';")
    (dist / "assets" / "app.css").write_text("body { color: white; }")
    (dist / "cesium" / "Workers" / "worker.js").write_text("self.onmessage = () => {};")
    api = Flask(__name__, static_folder=None)

    @api.get("/api/health")
    def health():
        return jsonify({"status": "ok", "existingApi": True})

    @api.errorhandler(HTTPException)
    def error(error):
        return jsonify({"error": {"code": "not_found" if error.code == 404 else "method_not_allowed"}}), error.code

    monkeypatch.setattr(production, "create_app", lambda: api)
    return dist, production.create_production_app(dist).test_client()


def test_built_index_and_static_cesium_assets_share_one_application(built_client):
    dist, client = built_client
    assert client.get("/").get_data(as_text=True) == (dist / "index.html").read_text()
    assert client.get("/assets/app.js").get_data(as_text=True) == "window.cartographer = 'built';"
    assert client.get("/assets/app.css").mimetype == "text/css"
    assert client.get("/cesium/Workers/worker.js").get_data(as_text=True) == "self.onmessage = () => {};"


def test_existing_api_and_unknown_api_paths_never_return_spa_html(built_client):
    _, client = built_client
    assert client.get("/api/health").get_json() == {"status": "ok", "existingApi": True}
    for path in ("/api", "/api/unknown", "/api/unknown/nested"):
        response = client.get(path, headers={"Accept": "text/html"})
        assert response.status_code == 404
        assert response.get_json()["error"]["code"] == "not_found"
        assert b"Built Cartographer" not in response.data


@pytest.mark.parametrize("path", ["/assets/missing.js", "/cesium/Workers/missing.js", "/missing.svg"])
def test_missing_assets_are_real_404s(built_client, path):
    _, client = built_client
    response = client.get(path, headers={"Accept": "text/html"})
    assert response.status_code == 404
    assert b"Built Cartographer" not in response.data


def test_spa_fallback_is_limited_to_browser_navigation(built_client):
    dist, client = built_client
    assert client.get("/saved/example", headers={"Accept": "text/html"}).data == (dist / "index.html").read_bytes()
    assert client.get("/saved/example", headers={"Accept": "application/json"}).status_code == 404


def test_dotfiles_traversal_and_symlinks_cannot_expose_outside_files(built_client):
    dist, client = built_client
    (dist / ".private").write_text("private")
    outside = dist.parent / "private.txt"
    outside.write_text("outside")
    (dist / "escape.txt").symlink_to(outside)
    for path in ("/.private", "/%2e%2e/private.txt", "/assets/%2e%2e/%2e%2e/private.txt", "/escape.txt"):
        assert client.get(path, headers={"Accept": "text/html"}).status_code == 404


def test_missing_build_fails_before_database_or_credentials_are_loaded(tmp_path, monkeypatch):
    factory = Mock()
    monkeypatch.setattr(production, "create_app", factory)
    with pytest.raises(RuntimeError, match="npm run build"):
        production.create_production_app(tmp_path / "missing-dist")
    factory.assert_not_called()


def test_entrypoint_uses_waitress_and_closes_backend_resources(tmp_path, monkeypatch):
    api = Flask(__name__)
    api.config["MAX_CONTENT_LENGTH"] = 64 * 1024
    searches, store = SimpleNamespace(shutdown=Mock()), SimpleNamespace(close=Mock())
    api.extensions.update({"search_service": searches, "persistent_store": store})
    server = Mock()
    monkeypatch.setattr(production, "PROJECT_DIRECTORY", tmp_path)
    monkeypatch.setattr(production, "create_production_app", lambda: api)
    monkeypatch.setattr(production, "serve", server)
    monkeypatch.setattr(production.tempfile, "tempdir", None)
    monkeypatch.setenv("CARTOGRAPHER_HOST", "127.0.0.1")
    monkeypatch.setenv("CARTOGRAPHER_PORT", "5051")
    production.main()
    server.assert_called_once_with(api, host="127.0.0.1", port=5051, threads=8, outbuf_overflow=8 * 1024 * 1024, max_request_body_size=64 * 1024, expose_tracebacks=False)
    searches.shutdown.assert_called_once()
    store.close.assert_called_once()
    assert Path(production.tempfile.tempdir).is_relative_to(tmp_path)
