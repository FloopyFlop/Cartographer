"""Private, consistent BSON backups compatible with standard mongorestore.

The local standalone server is briefly write-locked while reading its database.
No configuration files or source image pixels are copied into the dump.
"""

import argparse
import json
import os
import shutil
import signal
import uuid
from pathlib import Path

from bson import BSON, json_util
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import PyMongoError

from .storage import DEFAULT_DATABASE, DEFAULT_MONGODB_URI


PROJECT_DIRECTORY = Path(__file__).resolve().parents[2]


def backup_database(client, database_name: str, output_directory: Path) -> dict[str, int]:
    """Return collection counts only after a fully written, unlocked snapshot."""
    if not isinstance(database_name, str) or not database_name or any(character in database_name for character in ('/', '\\', '\0', '.', '$', '"', ' ')) or database_name in {"admin", "config", "local"}:
        raise ValueError("Choose the application database, not a system database.")
    output = Path(output_directory).resolve()
    destination = output / database_name
    if destination.exists():
        raise ValueError("The backup directory already exists. Preserve or move that backup before creating another.")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = output / ("." + database_name + ".partial-" + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    locked = False
    counts = {}
    try:
        # Even a timed-out acknowledgement can mean the server accepted the
        # lock. Attempt its matching unlock in finally for uncertain outcomes.
        locked = True
        client.admin.command({"fsync": 1, "lock": True})
        database = client[database_name]
        for collection in database.list_collections():
            name = collection["name"]
            if name.startswith("system."):
                continue
            if name in {".", ".."} or any(character in name for character in ("/", "\\", "\0")):
                raise ValueError("A collection name cannot safely be exported as a BSON filename.")
            options = collection.get("options", {})
            metadata = {"options": options, "indexes": [], "collectionName": name, "type": collection.get("type", "collection")}
            if metadata["type"] != "view":
                count = 0
                bson_path = staging / (name + ".bson")
                with bson_path.open("wb") as stream:
                    os.chmod(bson_path, 0o600)
                    for document in database[name].find({}).sort("_id", 1):
                        stream.write(BSON.encode(document))
                        count += 1
                    stream.flush()
                    os.fsync(stream.fileno())
                counts[name] = count
                metadata["indexes"] = [dict(index) for index in database[name].list_indexes()]
            metadata_path = staging / (name + ".metadata.json")
            with metadata_path.open("w", encoding="utf-8") as stream:
                os.chmod(metadata_path, 0o600)
                stream.write(json_util.dumps(metadata, json_options=json_util.RELAXED_JSON_OPTIONS))
                stream.flush()
                os.fsync(stream.fileno())
        client.admin.command({"fsyncUnlock": 1})
        locked = False
        staging.rename(destination)
        return counts
    finally:
        try:
            if locked:
                client.admin.command({"fsyncUnlock": 1})
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def main() -> None:
    load_dotenv(PROJECT_DIRECTORY / ".env", override=False)
    load_dotenv(PROJECT_DIRECTORY / "backend" / ".env", override=False)
    parser = argparse.ArgumentParser(description="Create a private mongorestore-compatible application database backup.")
    parser.add_argument("--output", type=Path, default=PROJECT_DIRECTORY / "build" / "private" / "mongodb", help="Parent dump directory; must not already contain this database backup")
    parser.add_argument("--database", default=os.environ.get("CARTOGRAPHER_MONGODB_DATABASE", DEFAULT_DATABASE))
    arguments = parser.parse_args()
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    client = MongoClient(os.environ.get("CARTOGRAPHER_MONGODB_URI", DEFAULT_MONGODB_URI), serverSelectionTimeoutMS=5000, connectTimeoutMS=5000, socketTimeoutMS=60_000, retryWrites=False, appname="CartographerBackup")
    try:
        counts = backup_database(client, arguments.database, arguments.output)
        print(f"Private MongoDB backup: {arguments.output.resolve() / arguments.database}")
        print(json.dumps({"collections": counts, "documents": sum(counts.values())}))
    except (PyMongoError, OSError, ValueError, KeyboardInterrupt):
        parser.exit(1, "The database backup did not finish. Check database availability, backup privileges and whether the output already exists. No credentials were printed.\n")
    finally:
        client.close()


if __name__ == "__main__":
    main()
