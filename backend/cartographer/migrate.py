"""One-time read-only import of the original local cache into MongoDB.

Run before the API starts. The legacy file remains intact. Per-provider import
markers and single-document increments ensure a resumed migration cannot reset
new charges or import the old ledger twice.
"""

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from dotenv import load_dotenv

from .storage import DEFAULT_DATABASE, DEFAULT_MONGODB_URI, LIMITS, PersistentStore, now


MIGRATION_ID = "sqlite-to-mongodb-v1"


def _date(value: str | None) -> datetime:
    if value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return now()


def migrate_legacy(
    legacy_path: Path,
    uri: str = DEFAULT_MONGODB_URI,
    database: str = DEFAULT_DATABASE,
    cache_directory: str | Path | None = None,
) -> dict:
    legacy_path = Path(legacy_path).resolve()
    if not legacy_path.is_file():
        return {"status": "not-needed", "counts": {}}
    store = PersistentStore(uri=uri, database=database, cache_directory=cache_directory or legacy_path.parent)
    try:
        previous = store.db.migrations.find_one({"_id": MIGRATION_ID})
        if previous and previous.get("status") == "completed":
            return {"status": "already-migrated", "counts": previous.get("counts", {}), "usage": store.usage()}
        store.db.migrations.update_one({"_id": MIGRATION_ID}, {"$setOnInsert": {"started_at": now(), "status": "running"}}, upsert=True)
        # SQLite is used only as a read-only legacy import format, never as the
        # current application store. MongoDB receives all writes.
        connection = sqlite3.connect("file:" + quote(legacy_path.as_posix()) + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            def rows(table: str) -> list:
                # Names are fixed by this migration, never supplied by callers.
                return list(connection.execute(f"SELECT * FROM {table}")) if table in tables else []
            counts = {}
            spend_rows = rows("spend")
            for provider in LIMITS:
                reservations = [
                    {"id": row["id"], "amount_micro": row["reserved_micro"], "charged_micro": row["charged_micro"], "operation": row["operation"], "created_at": _date(row["created_at"])}
                    for row in spend_rows if row["provider"] == provider
                ]
                used = sum(item["charged_micro"] for item in reservations if item["charged_micro"] is not None)
                reserved = sum(item["amount_micro"] for item in reservations if item["charged_micro"] is None)
                # Atomic additive import preserves calls already made in MongoDB
                # and cannot repeat after a crash or concurrent bootstrap.
                store.db.budgets.update_one(
                    {"_id": provider, "legacy_migrations": {"$ne": MIGRATION_ID}},
                    {"$inc": {"used_micro": used, "reserved_micro": reserved}, "$push": {"reservations": {"$each": reservations}}, "$addToSet": {"legacy_migrations": MIGRATION_ID}},
                )
            counts["spend"] = len(spend_rows)
            for table in ("jobs", "vision_cache", "panorama_ids", "source_queries", "source_images"):
                table_rows = rows(table)
                for row in table_rows:
                    if table == "jobs":
                        document = {"_id": row["id"], "cache_key": row["cache_key"], "snapshot": json.loads(row["snapshot"]), "completed": bool(row["completed"]), "updated_at": _date(row["updated_at"])}
                    elif table == "vision_cache":
                        document = {"_id": row["cache_key"], "result": json.loads(row["result"]), "created_at": _date(row["created_at"])}
                    elif table == "panorama_ids":
                        document = {"_id": row["location_key"], "panorama_id": row["panorama_id"]}
                    elif table == "source_queries":
                        document = {"_id": row["cache_key"], "result": json.loads(row["result"])}
                    else:
                        path = Path(row["path"])
                        try:
                            path = path.resolve().relative_to(legacy_path.parent)
                        except ValueError:
                            pass
                        document = {"_id": row["id"], "metadata": json.loads(row["metadata"]), "path": str(path)}
                    store.db[table].update_one({"_id": document["_id"]}, {"$setOnInsert": document}, upsert=True)
                counts[table] = len(table_rows)
            store.db.migrations.update_one({"_id": MIGRATION_ID}, {"$set": {"status": "completed", "finished_at": now(), "counts": counts}})
            return {"status": "migrated", "counts": counts, "usage": store.usage()}
        finally:
            connection.close()
    finally:
        store.close()


def main() -> None:
    backend_directory = Path(__file__).resolve().parent.parent
    load_dotenv(backend_directory / ".env", override=False)
    cache_directory = Path(os.environ.get("CARTOGRAPHER_CACHE_DIRECTORY", str(backend_directory / ".cache")))
    result = migrate_legacy(
        backend_directory / ".cache" / "cartographer.sqlite3",
        uri=os.environ.get("CARTOGRAPHER_MONGODB_URI", DEFAULT_MONGODB_URI),
        database=os.environ.get("CARTOGRAPHER_MONGODB_DATABASE", DEFAULT_DATABASE),
        cache_directory=cache_directory,
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
