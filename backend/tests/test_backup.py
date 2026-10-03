from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from bson import decode_all, json_util
from pymongo.errors import NetworkTimeout

from cartographer.backup import backup_database
from cartographer.storage import PersistentStore


def test_backup_contains_standard_bson_and_index_metadata_with_exact_ledger(tmp_path, mongo_settings):
    store = PersistentStore(**mongo_settings)
    reservation = store.reserve("google", 10_000, "test_snapshot")
    store.settle(reservation, 7_000)
    store.reserve("openai", 40_000, "test_uncertain_snapshot")
    store.db.jobs.insert_one({"_id": "cached-search", "snapshot": {"query": "bicycle racks", "status": "completed"}})
    store.db.location_queries.create_index("expiresAt", expireAfterSeconds=0)
    try:
        counts = backup_database(store.client, mongo_settings["database"], tmp_path / "dump")
        directory = tmp_path / "dump" / mongo_settings["database"]
        assert counts["budgets"] == 2
        assert counts["jobs"] == 1
        budgets = {row["_id"]: row for row in decode_all((directory / "budgets.bson").read_bytes())}
        assert budgets["google"]["used_micro"] == 7_000
        assert budgets["openai"]["reserved_micro"] == 40_000
        assert budgets["google"]["reservations"][0]["id"] == reservation
        metadata = json_util.loads((directory / "location_queries.metadata.json").read_text())
        assert any(index.get("expireAfterSeconds") == 0 for index in metadata["indexes"])
        assert metadata["collectionName"] == "location_queries"
        assert store.client.admin.command("currentOp").get("fsyncLock", False) is False
        assert store.usage()["google"]["usedUsd"] == 0.007
        assert {path.suffix for path in directory.iterdir()} == {".bson", ".json"}
    finally:
        store.close()


def test_failed_backup_releases_server_lock_and_removes_incomplete_dump(tmp_path):
    admin = Mock()
    database = SimpleNamespace(list_collections=Mock(side_effect=OSError("export interrupted")))
    class Client:
        def __init__(self):
            self.admin = admin
        def __getitem__(self, database_name):
            return database
    with pytest.raises(OSError):
        backup_database(Client(), "cartographer", tmp_path / "dump")
    assert admin.command.call_args_list[0].args == ({"fsync": 1, "lock": True},)
    assert admin.command.call_args_list[-1].args == ({"fsyncUnlock": 1},)
    assert list((tmp_path / "dump").iterdir()) == []


def test_existing_backup_is_preserved_before_any_server_lock(tmp_path):
    directory = tmp_path / "cartographer"
    directory.mkdir()
    (directory / "budgets.bson").write_bytes(b"existing-private-backup")
    client = Mock()
    with pytest.raises(ValueError, match="already exists"):
        backup_database(client, "cartographer", tmp_path)
    client.admin.command.assert_not_called()
    assert (directory / "budgets.bson").read_bytes() == b"existing-private-backup"


def test_uncertain_lock_acknowledgement_still_attempts_unlock(tmp_path):
    command = Mock(side_effect=[NetworkTimeout("acknowledgement uncertain"), {"ok": 1}])
    client = SimpleNamespace(admin=SimpleNamespace(command=command))
    with pytest.raises(NetworkTimeout):
        backup_database(client, "cartographer", tmp_path / "dump")
    assert command.call_args_list[-1].args == ({"fsyncUnlock": 1},)
    assert list((tmp_path / "dump").iterdir()) == []
