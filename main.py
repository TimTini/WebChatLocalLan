from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.getenv("WEBCHAT_HOST", "0.0.0.0")
    port = int(os.getenv("WEBCHAT_PORT", "9098"))
    reload_mode = os.getenv("WEBCHAT_RELOAD", "0") == "1"
    uvicorn.run("app.web:app", host=host, port=port, reload=reload_mode)


if __name__ == "__main__":
    main()
