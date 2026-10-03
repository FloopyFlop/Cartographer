"""Start the local API with uv run python -m cartographer."""

import os

from . import create_app


def main() -> None:
    create_app().run(host=os.environ.get("CARTOGRAPHER_HOST", "127.0.0.1"), port=int(os.environ.get("CARTOGRAPHER_PORT", "5050")), debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
