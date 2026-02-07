from __future__ import annotations

import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = BASE_DIR / "app" / "templates"
STATIC_DIR = BASE_DIR / "app" / "static"
UPLOAD_DIR = Path(os.getenv("WEBCHAT_UPLOAD_DIR", BASE_DIR / "uploads"))

MAX_UPLOAD_MB = int(os.getenv("WEBCHAT_MAX_UPLOAD_MB", "25"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_HISTORY_MESSAGES = int(os.getenv("WEBCHAT_MAX_HISTORY", "500"))

