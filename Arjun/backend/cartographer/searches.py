"""Thread-safe, bounded, progressively updated search jobs.

Job snapshots are durable in MongoDB. Work execution and cancellation remain
local; use a shared task queue before running multiple server processes.
"""

import copy
import logging
import math
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .errors import ApiError
from .geography import validate_area
from .providers import DemoProvider, Interpretation, interpret_query
from .live import LiveProvider, digest
from .storage import PersistentStore


TERMINAL_STATUSES = {"completed", "cancelled", "failed"}


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_request(payload: object) -> tuple[str, dict, str]:
    if not isinstance(payload, dict):
        raise ApiError("invalid_request", "Send a JSON object containing a query and geographic area.")
    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ApiError("invalid_query", "Describe the object you want to find.", field="query")
    if len(query) > 1_000:
        raise ApiError("invalid_query", "Keep the search description under 1,000 characters.", field="query")
    mode = payload.get("mode", "auto")
    if mode not in ("auto", "live", "precomputed"):
        raise ApiError("invalid_mode", "Search mode must be auto, live, or precomputed.", field="mode")
    return query.strip(), validate_area(payload.get("area")), mode


@dataclass
class JobState:
    snapshot: dict
    cache_key: str = ""
    created_monotonic: float = field(default_factory=time.monotonic)
    cancelled: threading.Event = field(default_factory=threading.Event)


class SearchService:
    def __init__(
        self,
        provider: DemoProvider | None = None,
        step_seconds: float = 0.45,
        steps: int = 8,
        max_workers: int = 4,
        max_active: int = 8,
        max_retained: int = 100,
        retention_seconds: float = 3600,
        store: PersistentStore | None = None,
        live_provider: LiveProvider | None = None,
    ):
        self.provider = provider or DemoProvider()
        self.store = store
        self.live_provider = live_provider
        self.step_seconds = step_seconds
        self.steps = steps
        self.max_active = max_active
        self.max_retained = max_retained
        self.retention_seconds = retention_seconds
        self._jobs: dict[str, JobState] = {}
        self._active_keys: dict[str, str] = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="cartographer-search")

    def _prune(self) -> None:
        now = time.monotonic()
        expired = [
            job_id for job_id, state in self._jobs.items()
            if state.snapshot["status"] in TERMINAL_STATUSES
            and now - state.created_monotonic > self.retention_seconds
        ]
        for job_id in expired:
            del self._jobs[job_id]
        while len(self._jobs) >= self.max_retained:
            oldest_terminal = next((
                job_id for job_id, state in self._jobs.items()
                if state.snapshot["status"] in TERMINAL_STATUSES
            ), None)
            if oldest_terminal is None:
                break
            del self._jobs[oldest_terminal]

    def submit(self, payload: object) -> dict:
        query, area, requested_mode = validate_request(payload)
        interpretation = interpret_query(query)
        is_live = requested_mode == "live" or (requested_mode == "auto" and self.live_provider and self.live_provider.available)
        actual_mode = "live" if is_live else "demo"
        canonical_area = {key: value for key, value in area.items() if key != "label"}
        cache_key = digest({
            "query": " ".join(query.casefold().split()), "area": canonical_area,
            "mode": actual_mode,
            "provider": self.live_provider.signature(area) if is_live and self.live_provider else "demo-v1",
        })
        created_at = timestamp()
        job_id = str(uuid.uuid4())
        job = {
            "id": job_id,
            "query": query,
            "label": query,
            "status": "queued",
            "progress": {"completed": 0, "total": self.steps, "stage": "Waiting to load demonstration data"},
            "detections": [],
            "area": area,
            "createdAt": created_at,
            "updatedAt": created_at,
            "mode": actual_mode,
            "interpretation": interpretation.as_dict(),
        }
        if is_live:
            job["progress"] = {"completed": 0, "total": 4, "stage": "Waiting to analyze street imagery"}
            job["interpretation"] = {"featureType": interpretation.feature_type, "description": "Visually identify matching objects in a sparse sample of street imagery. Markers approximate the image camera position, not the exact object."}
            try:
                if self.live_provider is None:
                    raise ApiError("provider_not_configured", "Live imagery analysis is not configured.", 409)
                self.live_provider.require_available()
            except ApiError as error:
                job.update({"status": "failed", "error": {"code": error.code, "message": error.message}})
                job["progress"]["stage"] = "Live search unavailable"
        state = JobState(job, cache_key)
        with self._lock:
            existing_id = self._active_keys.get(cache_key)
            existing = self._jobs.get(existing_id) if existing_id else None
            if existing and existing.snapshot["status"] not in TERMINAL_STATUSES:
                return copy.deepcopy(existing.snapshot)
            cached = self.store.completed_job(cache_key) if self.store else None
            if cached:
                cached["cacheHit"] = True
                return cached
            self._prune()
            active = sum(item.snapshot["status"] not in TERMINAL_STATUSES for item in self._jobs.values())
            if active >= self.max_active or len(self._jobs) >= self.max_retained:
                raise ApiError("too_many_searches", "Several searches are already running. Wait for one to finish or cancel it.", 429)
            self._jobs[job_id] = state
            self._active_keys[cache_key] = job_id
            self._persist(state)
            response = copy.deepcopy(job)
        if job["status"] not in TERMINAL_STATUSES:
            try:
                self._executor.submit(self._run, state, interpretation)
            except RuntimeError:
                with self._lock:
                    del self._jobs[job_id]
                raise ApiError("service_unavailable", "Search workers are shutting down. Try again shortly.", 503) from None
        return response

    def get(self, job_id: str) -> dict:
        with self._lock:
            state = self._jobs.get(job_id)
            if state is None:
                persisted = self.store.get_job(job_id) if self.store else None
                if persisted:
                    if persisted["status"] not in TERMINAL_STATUSES:
                        persisted.update({"status": "failed", "error": {"code": "search_interrupted", "message": "The server restarted before this search finished. Partial results are preserved; run it again to resume using cached imagery."}})
                        persisted["progress"]["stage"] = "Search interrupted by a server restart"
                    return persisted
                raise ApiError("search_not_found", "This search was not found or has expired.", 404)
            return copy.deepcopy(state.snapshot)

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            state = self._jobs.get(job_id)
            if state is None:
                return self.get(job_id)
            if state.snapshot["status"] not in TERMINAL_STATUSES:
                state.cancelled.set()
                state.snapshot["status"] = "cancelled"
                state.snapshot["progress"]["stage"] = "Search cancelled"
                state.snapshot["updatedAt"] = timestamp()
                self._persist(state)
            return copy.deepcopy(state.snapshot)

    def _persist(self, state: JobState) -> None:
        if self.store:
            self.store.save_job(state.cache_key, state.snapshot)

    def _live_update(self, state: JobState, completed: int, total: int, stage: str, detections: list[dict]) -> None:
        with self._lock:
            if state.snapshot["status"] != "running":
                return
            for detection in detections:
                state.snapshot["detections"].append({**detection, "id": f"{state.snapshot['id']}:{len(state.snapshot['detections']) + 1}", "searchId": state.snapshot["id"], "detectedAt": timestamp()})
            state.snapshot["progress"] = {"completed": min(completed, total), "total": total, "stage": stage}
            state.snapshot["updatedAt"] = timestamp()
            self._persist(state)

    def _run(self, state: JobState, interpretation: Interpretation) -> None:
        try:
            if state.cancelled.wait(self.step_seconds / 2):
                return
            with self._lock:
                if state.snapshot["status"] != "queued":
                    return
                state.snapshot["status"] = "running"
                state.snapshot["progress"]["stage"] = "Finding licensed street imagery" if state.snapshot["mode"] == "live" else "Loading demonstration layer"
                state.snapshot["updatedAt"] = timestamp()
                self._persist(state)
            if state.snapshot["mode"] == "live":
                self.live_provider.search(state.snapshot["query"], state.snapshot["area"], state.cancelled, lambda completed, total, stage, detections: self._live_update(state, completed, total, stage, detections))
                with self._lock:
                    if state.snapshot["status"] == "running":
                        state.snapshot["status"] = "completed"
                        progress = state.snapshot["progress"]
                        progress["completed"] = progress["total"]
                        if progress["total"]:
                            progress["stage"] = "Sparse imagery sample analyzed"
                        state.snapshot["updatedAt"] = timestamp()
                        self._persist(state)
                return
            samples = self.provider.search(interpretation, state.snapshot["area"])
            for step in range(1, self.steps + 1):
                if state.cancelled.wait(self.step_seconds):
                    return
                with self._lock:
                    if state.snapshot["status"] != "running":
                        return
                    target_count = math.ceil(len(samples) * step / self.steps)
                    for sample in samples[len(state.snapshot["detections"]):target_count]:
                        state.snapshot["detections"].append({
                            **{key: value for key, value in sample.items() if key != "fixtureId"},
                            "id": f"{state.snapshot['id']}:{sample['fixtureId']}",
                            "searchId": state.snapshot["id"],
                            "detectedAt": timestamp(),
                        })
                    state.snapshot["progress"]["completed"] = step
                    state.snapshot["progress"]["stage"] = "Loading demonstration results"
                    state.snapshot["updatedAt"] = timestamp()
                    if step == self.steps:
                        state.snapshot["status"] = "completed"
                        if interpretation.feature_type == "custom":
                            stage = "No demonstration layer available for this object"
                        elif not samples:
                            stage = "No demonstration locations in the selected area"
                        else:
                            stage = "Demonstration layer loaded"
                        state.snapshot["progress"]["stage"] = stage
                    self._persist(state)
        except Exception as error:
            if not isinstance(error, ApiError):
                logging.getLogger(__name__).error("Search provider failed (%s)", type(error).__name__)
            with self._lock:
                if state.snapshot["status"] not in TERMINAL_STATUSES:
                    state.snapshot["status"] = "failed"
                    state.snapshot["progress"]["stage"] = "Search failed"
                    state.snapshot["updatedAt"] = timestamp()
                    state.snapshot["error"] = {"code": error.code, "message": error.message} if isinstance(error, ApiError) else {"code": "search_failed", "message": "The search provider could not finish. Please try again."}
                    self._persist(state)
        finally:
            with self._lock:
                if self._active_keys.get(state.cache_key) == state.snapshot["id"]:
                    self._active_keys.pop(state.cache_key, None)

    def shutdown(self) -> None:
        with self._lock:
            for state in self._jobs.values():
                if state.snapshot["status"] not in TERMINAL_STATUSES:
                    state.cancelled.set()
                    state.snapshot["status"] = "cancelled"
                    state.snapshot["progress"]["stage"] = "Search cancelled during server shutdown"
                    self._persist(state)
        self._executor.shutdown(wait=True, cancel_futures=True)
