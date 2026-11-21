"""Run the API. nginx in the same pod proxies /api here."""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn

from app.core.config import load_settings


def _load_local_env() -> None:
    """Fill unset variables from .env.local. Existing environment wins."""
    configured = os.environ.get("GREENROOM_ENV_FILE", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates.append(Path(__file__).resolve().parents[2] / ".env.local")
    for path in candidates:
        if not path.is_file():
            continue
        for raw_line in path.read_text().splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or not key.replace("_", "").isalnum():
                continue
            os.environ.setdefault(key, value.strip().strip('"').strip("'"))
        return


def main() -> None:
    _load_local_env()
    settings = load_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        workers=1,
        timeout_keep_alive=75,
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
    )


if __name__ == "__main__":
    main()
