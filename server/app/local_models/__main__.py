"""Run: PYTHONPATH=server python -m app.local_models --data-dir <private-directory>."""
import argparse
import os
from pathlib import Path

import uvicorn

from .app import create_app


def main():
    parser = argparse.ArgumentParser(description="Greenroom 本机单用户模型 API 配置（仅监听 127.0.0.1）")
    parser.add_argument("--data-dir", default=str(Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "greenroom/local-models"))
    parser.add_argument("--port", type=int, default=3099)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port 必须在 1024–65535")
    uvicorn.run(create_app(args.data_dir, port=args.port), host="127.0.0.1", port=args.port,
                access_log=False, proxy_headers=False, workers=1)


if __name__ == "__main__":
    main()
