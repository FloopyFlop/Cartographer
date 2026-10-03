"""Serve the built React/Cesium client and Flask API through Waitress."""

import os
import hmac
import tempfile
from pathlib import Path

from flask import abort, g, jsonify, request, send_from_directory
from waitress import serve

from . import create_app


PROJECT_DIRECTORY = Path(__file__).resolve().parents[2]


def create_production_app(dist_directory: str | Path | None = None):
    dist = Path(dist_directory or PROJECT_DIRECTORY / "dist").resolve()
    index = dist / "index.html"
    if not index.is_file() or not index.resolve().is_relative_to(dist):
        raise RuntimeError("The built Cartographer interface is missing. Run npm run build from the project directory before npm start.")
    app = create_app()
    app.config["HEALTH_MINIMAL"] = bool(app.config.get("AUTH_REQUIRED", False))
    if app.config.get("AUTH_REQUIRED", False):
        username = app.config.get("AUTH_USERNAME")
        password = app.config.get("AUTH_PASSWORD")
        if not isinstance(username, str) or not username.strip() or ":" in username or not isinstance(password, str) or not password.strip():
            if app.extensions.get("search_service"):
                app.extensions["search_service"].shutdown()
            if app.extensions.get("persistent_store"):
                app.extensions["persistent_store"].close()
            raise RuntimeError("Production access protection requires a nonempty CARTOGRAPHER_AUTH_USERNAME and CARTOGRAPHER_AUTH_PASSWORD.")

        @app.before_request
        def require_access():
            authorization = request.authorization
            supplied_username = authorization.username if authorization and authorization.type.casefold() == "basic" else ""
            supplied_password = authorization.password if authorization and authorization.type.casefold() == "basic" else ""
            user_matches = hmac.compare_digest((supplied_username or "").encode(), username.encode())
            password_matches = hmac.compare_digest((supplied_password or "").encode(), password.encode())
            if user_matches and password_matches:
                g.cartographer_authenticated = True
                mutating_api = request.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}
                remote_lookup = request.path == "/api/locations" and request.args.get("remote") == "1"
                if (mutating_api or remote_lookup) and request.headers.get("X-Cartographer-Request") != "1":
                    # Cross-site forms and image requests can carry cached
                    # Basic credentials, but cannot set this custom header.
                    # Same-origin image previews and result reads stay usable.
                    response = jsonify({"error": {"code": "request_verification_required", "message": "Send this request from the Cartographer application."}})
                    response.status_code = 403
                    response.headers["Cache-Control"] = "no-store"
                    return response
                return None
            # Unauthenticated probes expose only readiness. Authenticated UI
            # health calls retain the provider/search availability contract.
            if request.path == "/api/health" and request.method in {"GET", "HEAD"}:
                return None
            response = jsonify({"error": {"code": "authentication_required", "message": "Sign in to access Cartographer."}})
            response.status_code = 401
            response.headers["WWW-Authenticate"] = 'Basic realm="Cartographer", charset="UTF-8"'
            response.headers["Cache-Control"] = "no-store"
            return response

    @app.get("/")
    def client_index():
        return send_from_directory(dist, "index.html")

    @app.get("/<path:asset_path>")
    def client_asset(asset_path: str):
        if asset_path == "api" or asset_path.startswith("api/"):
            abort(404)
        if any(part.startswith(".") for part in Path(asset_path).parts):
            abort(404)
        target = (dist / asset_path).resolve()
        if not target.is_relative_to(dist):
            abort(404)
        if target.is_file():
            return send_from_directory(dist, asset_path)
        # Missing assets and API requests must retain their real HTTP errors.
        if Path(asset_path).suffix or "text/html" not in request.headers.get("Accept", ""):
            abort(404)
        return send_from_directory(dist, "index.html")

    return app


def main() -> None:
    # Waitress may spill large responses to temporary files. Keep those files
    # inside the user's workspace as well as MongoDB and the uv cache.
    temporary_directory = PROJECT_DIRECTORY / "backend" / ".cache" / "tmp"
    temporary_directory.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(temporary_directory)
    app = create_production_app()
    host = os.environ.get("CARTOGRAPHER_HOST", "127.0.0.1")
    port = int(os.environ.get("CARTOGRAPHER_PORT", "5050"))
    print(f"Starting Cartographer's built application and API at http://{host}:{port}", flush=True)
    try:
        serve(app, host=host, port=port, threads=8, outbuf_overflow=8 * 1024 * 1024,
              max_request_body_size=app.config.get("MAX_CONTENT_LENGTH", 64 * 1024), expose_tracebacks=False)
    finally:
        app.extensions["search_service"].shutdown()
        app.extensions["persistent_store"].close()


if __name__ == "__main__":
    main()
