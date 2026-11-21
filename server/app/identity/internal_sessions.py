"""Room-local sessions used only while external auth is inactive. Passwords are not stored."""

from __future__ import annotations

import secrets
import sqlite3
import threading
import time
from pathlib import Path


SESSION_TTL_SECONDS = 12 * 60 * 60


class InternalSessionStore:
    def __init__(self, path: Path):
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS internal_sessions (
              token TEXT PRIMARY KEY,
              member_id TEXT,
              expires_at INTEGER
            );
            """
        )
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def issue(self, member_id: str) -> str:
        token = secrets.token_urlsafe(32)
        expires_at = int(time.time()) + SESSION_TTL_SECONDS
        with self._lock:
            self._db.execute(
                "INSERT INTO internal_sessions (token, member_id, expires_at) VALUES (?, ?, ?)",
                (token, member_id, expires_at),
            )
            self._db.commit()
        return token

    def resolve(self, token: str):
        if not token:
            return None
        now = int(time.time())
        with self._lock:
            row = self._db.execute(
                "SELECT member_id, expires_at FROM internal_sessions WHERE token = ?",
                (token,),
            ).fetchone()
            if row is None:
                return None
            if int(row["expires_at"] or 0) <= now:
                self._db.execute("DELETE FROM internal_sessions WHERE token = ?", (token,))
                self._db.commit()
                return None
            return row["member_id"]

    def revoke(self, token: str) -> None:
        if not token:
            return
        with self._lock:
            self._db.execute("DELETE FROM internal_sessions WHERE token = ?", (token,))
            self._db.commit()
