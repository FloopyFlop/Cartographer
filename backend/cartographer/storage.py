"""Actual MongoDB persistence and atomic journaled spending reservations.

Each provider's totals and reservations live in one document. A conditional
single-document update reserves spending atomically on standalone MongoDB,
without requiring replica-set transactions. Unknown paid-request outcomes retain
their reservation across restarts. No HTTP endpoint can reset the ledger.
"""

import copy
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import PyMongoError
from pymongo.write_concern import WriteConcern

from .errors import ApiError


MICRODOLLARS = 1_000_000
LIMITS = {"google": 4 * MICRODOLLARS, "openai": 2 * MICRODOLLARS}
DEFAULT_MONGODB_URI = "mongodb://127.0.0.1:27018"
DEFAULT_DATABASE = "cartographer"


def now() -> datetime:
    return datetime.now(timezone.utc)


def database_operation(method):
    """Do not disclose Mongo connection credentials or raw driver diagnostics."""
    def operation(*args, **kwargs):
        try:
            return method(*args, **kwargs)
        except PyMongoError:
            raise ApiError("database_unavailable", "Cartographer's local MongoDB is unavailable. Start the database and try again.", 503) from None
    return operation


class PersistentStore:
    @database_operation
    def __init__(
        self,
        uri: str = DEFAULT_MONGODB_URI,
        database: str = DEFAULT_DATABASE,
        cache_directory: str | Path | None = None,
    ):
        self.uri = uri
        self.database_name = database
        self.cache_directory = Path(cache_directory) if cache_directory else Path(__file__).resolve().parent.parent / ".cache"
        self.cache_directory.mkdir(parents=True, exist_ok=True)
        self.client = MongoClient(
            uri,
            serverSelectionTimeoutMS=3000,
            connectTimeoutMS=3000,
            socketTimeoutMS=10_000,
            retryWrites=False,
            appname="Cartographer",
        )
        self.client.admin.command("ping")
        # A reservation is acknowledged only after its on-disk journal write.
        self.db = self.client.get_database(database, write_concern=WriteConcern(w=1, j=True, wtimeout=10_000))
        for provider, limit in LIMITS.items():
            self.db.budgets.update_one(
                {"_id": provider},
                {"$setOnInsert": {"limit_micro": limit, "used_micro": 0, "reserved_micro": 0, "reservations": []}},
                upsert=True,
            )
        self.db.jobs.create_index([("cache_key", ASCENDING), ("completed", ASCENDING), ("updated_at", DESCENDING)])
        self.db.budgets.create_index("reservations.id", sparse=True)

    @database_operation
    def ping(self) -> None:
        """Readiness check without exposing database connection details."""
        self.client.admin.command("ping")

    @database_operation
    def reserve(self, provider: str, amount_micro: int, operation: str) -> str:
        if provider not in LIMITS or isinstance(amount_micro, bool) or not isinstance(amount_micro, int) or amount_micro <= 0:
            raise ValueError("Invalid budget reservation")
        reservation_id = str(uuid.uuid4())
        result = self.db.budgets.update_one(
            {
                "_id": provider,
                "$expr": {"$lte": [{"$add": ["$used_micro", "$reserved_micro", amount_micro]}, "$limit_micro"]},
            },
            {
                "$inc": {"reserved_micro": amount_micro},
                "$push": {"reservations": {"id": reservation_id, "amount_micro": amount_micro, "charged_micro": None, "operation": operation, "created_at": now()}},
            },
        )
        if result.modified_count != 1:
            raise ApiError("budget_exhausted", f"The {provider.title()} spending limit has been reached. Cached results are still available.", 402)
        return reservation_id

    @database_operation
    def settle(self, reservation_id: str, charged_micro: int) -> None:
        if isinstance(charged_micro, bool) or not isinstance(charged_micro, int) or charged_micro < 0:
            raise ValueError("Invalid charged amount")
        document = self.db.budgets.find_one(
            {"reservations.id": reservation_id},
            {"reservations": {"$elemMatch": {"id": reservation_id}}},
        )
        if document is None:
            raise ValueError("Unknown reservation")
        reservation = document["reservations"][0]
        if reservation["charged_micro"] is not None:
            if reservation["charged_micro"] != charged_micro:
                raise ValueError("Reservation was already settled")
            return
        result = self.db.budgets.update_one(
            {"_id": document["_id"], "reservations": {"$elemMatch": {"id": reservation_id, "charged_micro": None}}},
            {
                "$inc": {"reserved_micro": -reservation["amount_micro"], "used_micro": charged_micro},
                "$set": {"reservations.$.charged_micro": charged_micro},
            },
        )
        if result.modified_count == 0:
            # Another worker may have settled the same request concurrently.
            current = self.db.budgets.find_one(
                {"reservations.id": reservation_id},
                {"reservations": {"$elemMatch": {"id": reservation_id}}},
            )
            if current is None or current["reservations"][0]["charged_micro"] != charged_micro:
                raise ValueError("Reservation was already settled")

    @database_operation
    def usage(self) -> dict:
        result = {}
        for document in self.db.budgets.find({}, {"limit_micro": 1, "used_micro": 1, "reserved_micro": 1}):
            provider = document["_id"]
            if provider not in LIMITS:
                continue
            limit, used, reserved = (document[key] for key in ("limit_micro", "used_micro", "reserved_micro"))
            result[provider] = {
                "limitUsd": limit / MICRODOLLARS,
                "usedUsd": used / MICRODOLLARS,
                "reservedUsd": reserved / MICRODOLLARS,
                "remainingUsd": max(0, limit - used - reserved) / MICRODOLLARS,
            }
        return result

    @database_operation
    def save_job(self, cache_key: str, snapshot: dict) -> None:
        self.db.jobs.replace_one(
            {"_id": snapshot["id"]},
            {"_id": snapshot["id"], "cache_key": cache_key, "snapshot": copy.deepcopy(snapshot), "completed": snapshot["status"] == "completed", "updated_at": now()},
            upsert=True,
        )

    @database_operation
    def get_job(self, job_id: str) -> dict | None:
        row = self.db.jobs.find_one({"_id": job_id}, {"snapshot": 1})
        return row["snapshot"] if row else None

    @database_operation
    def completed_job(self, cache_key: str) -> dict | None:
        row = self.db.jobs.find_one({"cache_key": cache_key, "completed": True}, {"snapshot": 1}, sort=[("updated_at", DESCENDING)])
        return row["snapshot"] if row else None

    @database_operation
    def cached_vision(self, cache_key: str) -> list[dict] | None:
        row = self.db.vision_cache.find_one({"_id": cache_key}, {"result": 1})
        return row["result"] if row else None

    @database_operation
    def cache_vision(self, cache_key: str, detections: list[dict]) -> None:
        self.db.vision_cache.replace_one({"_id": cache_key}, {"_id": cache_key, "result": copy.deepcopy(detections), "created_at": now()}, upsert=True)

    @database_operation
    def cache_panorama_id(self, location_key: str, panorama_id: str) -> None:
        self.db.panorama_ids.replace_one({"_id": location_key}, {"_id": location_key, "panorama_id": panorama_id}, upsert=True)

    @database_operation
    def source_query(self, cache_key: str) -> list[dict] | None:
        row = self.db.source_queries.find_one({"_id": cache_key}, {"result": 1})
        return row["result"] if row else None

    @database_operation
    def cache_source_query(self, cache_key: str, rows: list[dict]) -> None:
        self.db.source_queries.replace_one({"_id": cache_key}, {"_id": cache_key, "result": copy.deepcopy(rows)}, upsert=True)

    @database_operation
    def source_image(self, image_id: str) -> dict | None:
        row = self.db.source_images.find_one({"_id": image_id}, {"metadata": 1, "path": 1, "_id": 0})
        if row and not Path(row["path"]).is_absolute():
            row["path"] = str(self.cache_directory / row["path"])
        return row if row else None

    @database_operation
    def cache_source_image(self, image_id: str, metadata: dict, path: Path) -> None:
        try:
            stored_path = str(path.resolve().relative_to(self.cache_directory.resolve()))
        except ValueError:
            stored_path = str(path)
        self.db.source_images.replace_one({"_id": image_id}, {"_id": image_id, "metadata": copy.deepcopy(metadata), "path": stored_path}, upsert=True)

    def close(self) -> None:
        self.client.close()
