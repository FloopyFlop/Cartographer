"""Run the Cartographer development API without the duplicate-worker reloader."""

import os

from cartographer import create_app


if __name__ == "__main__":
    create_app().run(
        host=os.environ.get("CARTOGRAPHER_HOST", "127.0.0.1"),
        port=int(os.environ.get("CARTOGRAPHER_PORT", "5050")),
        debug=False,
        use_reloader=False,
        threaded=True,
    )
