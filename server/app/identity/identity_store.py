"""Maps auth user ids to roster emails. Tokens are never stored."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path


class IdentityConflict(ValueError):
    """An existing account cannot claim another roster member."""


class IdentityStore:
    def __init__(self, path: Path):
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS identities (
              user_id TEXT PRIMARY KEY,
              email TEXT,
              member_id TEXT,
              tenant_id TEXT,
              seen_at INTEGER
            );
            """
        )
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def remember(self, *, user_id: str, email: str, member_id: str, tenant_id: str) -> None:
        with self._lock:
            row = self._db.execute(
                "SELECT email, member_id, tenant_id FROM identities WHERE user_id = ?", (user_id,)
            ).fetchone()
            if row is not None and tuple(row) == (email, member_id, tenant_id):
                return
            cursor = self._db.execute(
                "INSERT INTO identities (user_id, email, member_id, tenant_id, seen_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, member_id = excluded.member_id, "
                "tenant_id = excluded.tenant_id, seen_at = excluded.seen_at "
                "WHERE identities.member_id IS NULL OR identities.member_id = '' OR identities.member_id = excluded.member_id",
                (user_id, email, member_id, tenant_id, int(time.time())),
            )
            self._db.commit()
            if cursor.rowcount != 1:
                raise IdentityConflict("账号已绑定其他成员，不能通过登录更改身份")

    def identity_for(self, user_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT email, member_id, tenant_id FROM identities WHERE user_id = ?", (user_id,)
            ).fetchone()
        return dict(row) if row is not None else None

    def email_for(self, user_id: str) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT email FROM identities WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if row is None:
            return None
        return row["email"]

    def member_for(self, user_id: str) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT member_id FROM identities WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if row is None:
            return None
        return row["member_id"]

    def tenant_for(self, user_id: str) -> str | None:
        with self._lock:
            row = self._db.execute(
                "SELECT tenant_id FROM identities WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if row is None:
            return None
        return row["tenant_id"]

    def forget(self, user_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM identities WHERE user_id = ?", (user_id,))
            self._db.commit()
