import json
import sqlite3

from cartographer.migrate import MIGRATION_ID, migrate_legacy
from cartographer.storage import PersistentStore


def test_legacy_import_is_read_only_idempotent_and_preserves_new_charges(tmp_path, mongo_settings):
    legacy = tmp_path / "legacy.sqlite3"
    # SQLite appears only as a fixture for the retired format; all runtime
    # storage operations below exercise the real portable MongoDB server.
    with sqlite3.connect(legacy) as connection:
        connection.executescript("""
            CREATE TABLE spend(id TEXT, provider TEXT, reserved_micro INTEGER, charged_micro INTEGER, operation TEXT, created_at TEXT);
            CREATE TABLE jobs(id TEXT, cache_key TEXT, snapshot TEXT, completed INTEGER, updated_at TEXT);
            CREATE TABLE source_images(id TEXT, metadata TEXT, path TEXT);
        """)
        connection.executemany("INSERT INTO spend VALUES (?, ?, ?, ?, ?, ?)", [
            ("old-settled", "openai", 20000, 1252, "vision", "2026-10-03 12:00:00"),
            ("old-uncertain", "google", 10000, None, "image", "2026-10-03 12:00:00"),
        ])
        snapshot = {"id": "cached-job", "status": "completed", "detections": []}
        connection.execute("INSERT INTO jobs VALUES (?, ?, ?, ?, ?)", ("cached-job", "query-key", json.dumps(snapshot), 1, "2026-10-03 12:00:00"))
        connection.execute("INSERT INTO source_images VALUES (?, ?, ?)", ("source-id", json.dumps({"source": {"provider": "panoramax"}}), str(tmp_path / "images" / "example.jpg")))
    original = legacy.read_bytes()
    store = PersistentStore(**mongo_settings)
    new_call = store.reserve("openai", 40000, "new-vision")
    store.settle(new_call, 600)
    first = migrate_legacy(legacy, **mongo_settings)
    assert first["status"] == "migrated"
    assert store.usage()["openai"]["usedUsd"] == 0.001852
    assert store.usage()["google"]["reservedUsd"] == 0.01
    assert store.completed_job("query-key") == snapshot
    assert store.source_image("source-id")["path"] == str(tmp_path / "images" / "example.jpg")
    repeated = migrate_legacy(legacy, **mongo_settings)
    assert repeated["status"] == "already-migrated"
    assert store.usage()["openai"]["usedUsd"] == 0.001852
    assert legacy.read_bytes() == original
    # Simulate a crash after importing budgets but before finishing caches.
    store.db.migrations.update_one({"_id": MIGRATION_ID}, {"$set": {"status": "running"}})
    assert migrate_legacy(legacy, **mongo_settings)["status"] == "migrated"
    assert store.usage()["openai"]["usedUsd"] == 0.001852
    assert store.usage()["google"]["reservedUsd"] == 0.01
    assert len(store.db.budgets.find_one({"_id": "openai"})["reservations"]) == 2
    store.close()
