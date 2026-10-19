from __future__ import annotations

import logging
import os
import sys


def run() -> None:
    import uvicorn

    from backend.api.app import create_app
    from backend.config import Config

    logging.basicConfig(level=os.environ.get("VEYLORA_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    config = Config.from_env()
    if config.host not in ("127.0.0.1", "localhost"):
        raise SystemExit("the backend only binds to the loopback interface")
    app = create_app(config)
    uvicorn.run(app, host=config.host, port=config.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    run()
