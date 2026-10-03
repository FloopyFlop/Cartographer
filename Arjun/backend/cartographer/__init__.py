"""Flask API boundary for the Cartographer React application."""

import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_file
from werkzeug.exceptions import HTTPException

from .errors import ApiError
from .locations import LocationService
from .searches import SearchService
from .live import LiveProvider
from .storage import PersistentStore


def create_app(config: dict | None = None) -> Flask:
    backend_directory = Path(__file__).resolve().parent.parent
    load_dotenv(backend_directory / ".env", override=False)
    app = Flask(__name__)
    app.config.from_mapping(
        MAX_CONTENT_LENGTH=64 * 1024,
        SEARCH_STEP_SECONDS=0.45,
        SEARCH_STEPS=8,
        SEARCH_MAX_ACTIVE=8,
        SEARCH_MAX_WORKERS=4,
        GEOCODER_URL=os.environ.get("CARTOGRAPHER_GEOCODER_URL"),
        GEOCODER_USER_AGENT=os.environ.get("CARTOGRAPHER_GEOCODER_USER_AGENT"),
        GEOCODER_TIMEOUT_SECONDS=3,
        MONGODB_URI=os.environ.get("CARTOGRAPHER_MONGODB_URI", "mongodb://127.0.0.1:27018"),
        MONGODB_DATABASE=os.environ.get("CARTOGRAPHER_MONGODB_DATABASE", "cartographer"),
        CACHE_DIRECTORY=os.environ.get("CARTOGRAPHER_CACHE_DIRECTORY", str(backend_directory / ".cache")),
        OPENAI_API_KEY=os.environ.get("OPENAI_API_KEY"),
        GOOGLE_MAPS_API_KEY=os.environ.get("GOOGLE_MAPS_API_KEY"),
        IMAGERY_MANIFEST=os.environ.get("CARTOGRAPHER_IMAGERY_MANIFEST", str(backend_directory / ".cache" / "imagery-manifest.json")),
        IMAGERY_PROVIDER=os.environ.get("CARTOGRAPHER_IMAGERY_PROVIDER", "google"),
        MAX_IMAGES=int(os.environ.get("CARTOGRAPHER_MAX_IMAGES", "4")),
    )
    if config:
        app.config.update(config)
    app.json.sort_keys = False
    store = PersistentStore(uri=app.config["MONGODB_URI"], database=app.config["MONGODB_DATABASE"], cache_directory=app.config["CACHE_DIRECTORY"])
    live = LiveProvider(
        store=store,
        openai_key=app.config["OPENAI_API_KEY"],
        google_key=app.config["GOOGLE_MAPS_API_KEY"],
        manifest=Path(app.config["IMAGERY_MANIFEST"]),
        imagery_provider=app.config["IMAGERY_PROVIDER"],
        max_images=app.config["MAX_IMAGES"],
    )
    searches = SearchService(
        step_seconds=app.config["SEARCH_STEP_SECONDS"],
        steps=app.config["SEARCH_STEPS"],
        max_active=app.config["SEARCH_MAX_ACTIVE"],
        max_workers=app.config["SEARCH_MAX_WORKERS"],
        store=store,
        live_provider=live,
    )
    locations = LocationService(
        endpoint=app.config["GEOCODER_URL"],
        user_agent=app.config["GEOCODER_USER_AGENT"],
        timeout_seconds=app.config["GEOCODER_TIMEOUT_SECONDS"],
    )
    app.extensions["search_service"] = searches
    app.extensions["location_service"] = locations
    app.extensions["persistent_store"] = store
    app.extensions["live_provider"] = live

    @app.after_request
    def response_headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.errorhandler(ApiError)
    def api_error(error):
        response = jsonify(error.as_dict())
        response.status_code = error.status
        if error.status == 429:
            response.headers["Retry-After"] = "2"
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        codes = {400: "invalid_json", 404: "not_found", 405: "method_not_allowed", 413: "request_too_large", 415: "invalid_json"}
        messages = {
            400: "Send a valid JSON request.",
            404: "This API endpoint does not exist.",
            405: "This action is not available at this endpoint.",
            413: "This request is too large. Use a smaller search area or fewer route points.",
            415: "Send JSON with the application/json content type.",
        }
        return jsonify({"error": {"code": codes.get(error.code, "request_failed"), "message": messages.get(error.code, error.description)}}), error.code

    @app.errorhandler(Exception)
    def unexpected_error(error):
        app.logger.error("Unexpected API error (%s)", type(error).__name__)
        return jsonify({"error": {"code": "internal_error", "message": "The server could not finish this request. Please try again."}}), 500

    @app.get("/api/health")
    def health():
        return jsonify({
            "status": "ok",
            "provider": "owned" if live.owned.records else live.imagery_provider if live.available else "demo",
            "liveSearchAvailable": live.available,
            "locationSearchConfigured": locations.configured,
            "blockedReason": live.blocked_reason,
        })

    @app.post("/api/searches")
    def start_search():
        return jsonify(searches.submit(request.get_json())), 202

    @app.get("/api/searches/<job_id>")
    def search_status(job_id):
        return jsonify(searches.get(job_id))

    @app.delete("/api/searches/<job_id>")
    def cancel_search(job_id):
        return jsonify(searches.cancel(job_id))

    @app.get("/api/locations")
    def search_locations():
        return jsonify(locations.search(request.args.get("q", ""), remote=request.args.get("remote") == "1"))

    @app.get("/api/usage")
    def usage():
        return jsonify({**store.usage(), "model": live.model, "imageryProvider": "owned" if live.owned.records else live.imagery_provider, "liveSearchAvailable": live.available, "blockedReason": live.blocked_reason})

    @app.get("/api/imagery/<image_id>")
    def source_imagery(image_id):
        if image_id.startswith("google-"):
            image = live.google_images.get(image_id)
            return Response(image.content, content_type=image.content_type)
        path = live.panoramax.image_path(image_id) if image_id.startswith("panoramax-") else live.owned.image_path(image_id)
        response = send_file(path, conditional=True)
        if image_id.startswith("panoramax-"):
            cached = store.source_image(image_id)
            response.headers["X-Imagery-License"] = cached["metadata"]["source"]["license"]["name"]
            response.headers["Link"] = "<" + cached["metadata"]["source"]["license"]["url"] + '>; rel="license"'
        return response

    return app
