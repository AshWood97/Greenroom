"""Shared room assets. Visibility is enforced here, not by the browser."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from urllib.parse import quote
from pathlib import Path

from app.core.roster import ROSTER_BY_ID, public_member
from app.assets.space_seeds import SEED_ASSETS
from app.identity.standalone import STANDALONE_MEMBER, STANDALONE_MEMBER_ID


ASSET_TYPES = {
    "document",
    "code",
    "prompt",
    "workflow",
    "design",
    "image",
    "video",
    "audio",
}
MANAGE_ROLES = {"群主"}


def _json_or_none(value) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False)


class SpaceStore:
    def __init__(self, path: Path, *, seed: bool = True, standalone: bool = False):
        self.path = path
        self.members_by_id = ({**ROSTER_BY_ID, STANDALONE_MEMBER_ID: STANDALONE_MEMBER}
                              if standalone else ROSTER_BY_ID)
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS assets (
              id TEXT PRIMARY KEY,
              owner_id TEXT,
              title TEXT,
              description TEXT,
              type TEXT,
              content TEXT,
              visibility TEXT,
              source TEXT,
              generation_meta TEXT,
              media_meta TEXT,
              created_at INTEGER,
              updated_at INTEGER,
              published_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_id);
            CREATE INDEX IF NOT EXISTS idx_assets_visibility ON assets(visibility);
            CREATE INDEX IF NOT EXISTS idx_assets_storage_id ON assets(
              CASE WHEN json_valid(media_meta) THEN json_extract(media_meta, '$.storageAssetId') END
            );
            """
        )
        if seed:
            self._seed_if_empty()
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def _seed_if_empty(self) -> None:
        count = self._db.execute("SELECT COUNT(*) AS n FROM assets").fetchone()["n"]
        if count:
            return
        for asset in SEED_ASSETS:
            self._insert(asset, asset["created_at"])

    def _insert(self, asset: dict, updated_at: int) -> None:
        self._db.execute(
            "INSERT INTO assets (id, owner_id, title, description, type, content, visibility, source, generation_meta, media_meta, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                asset.get("id") or f"asset_{uuid.uuid4().hex[:16]}",
                asset["owner_id"],
                asset["title"],
                asset["description"],
                asset["type"],
                asset["content"],
                asset["visibility"],
                asset["source"],
                _json_or_none(asset.get("generation_meta")),
                _json_or_none(asset.get("media_meta")),
                asset["created_at"],
                updated_at,
                asset.get("published_at"),
            ),
        )

    def _row_to_asset(self, row: sqlite3.Row) -> dict:
        profile = public_member(self.members_by_id[row["owner_id"]])
        media = json.loads(row["media_meta"]) if row["media_meta"] else None
        # Historical browser records may contain signed or arbitrary URLs.
        # Read through the current media registry; never expose those old URLs.
        if isinstance(media, dict) and isinstance(media.get('storageAssetId'), str):
            media = {key: media[key] for key in ('storageAssetId', 'uploadId', 'fileName', 'fileSize', 'mimeType', 'sha256') if key in media}
            media['fileUrl'] = '/api/media/' + quote(media['storageAssetId'], safe='')
        else:
            media = None
        return {
            "id": row["id"],
            "title": row["title"],
            "description": row["description"],
            "type": row["type"],
            "content": row["content"],
            "ownerId": row["owner_id"],
            "ownerName": profile["name"],
            "ownerRole": profile["role"],
            "avatarInitials": profile["avatarInitials"],
            "avatarBgColor": profile["avatarBgColor"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "publishedAt": row["published_at"],
            "source": row["source"],
            "generationMeta": json.loads(row["generation_meta"]) if row["generation_meta"] else None,
            "mediaMeta": media,
        }

    def _matches(self, asset: dict, type_filter: str | None, search: str | None, owner_id: str | None) -> bool:
        if type_filter and type_filter != "all" and asset["type"] != type_filter:
            return False
        if owner_id and owner_id != "all" and asset["ownerId"] != owner_id:
            return False
        if search and search.strip():
            query = search.strip().lower()
            haystack = " ".join(
                [asset["title"], asset["description"], asset["content"], asset["ownerName"]]
            ).lower()
            if query not in haystack:
                return False
        return True

    def list_personal(self, owner_id: str, *, type_filter=None, search=None) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM assets WHERE owner_id = ? ORDER BY created_at DESC",
                (owner_id,),
            ).fetchall()
        return [
            asset
            for row in rows
            if self._matches(asset := self._row_to_asset(row), type_filter, search, None)
        ]

    def list_public(self, *, type_filter=None, search=None, owner_id=None) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM assets ORDER BY COALESCE(published_at, created_at) DESC"
            ).fetchall()
        return [
            asset
            for row in rows
            if self._matches(asset := self._row_to_asset(row), type_filter, search, owner_id)
        ]

    def stats(self, owner_id: str) -> dict:
        with self._lock:
            my_total = self._db.execute(
                "SELECT COUNT(*) AS n FROM assets WHERE owner_id = ?", (owner_id,)
            ).fetchone()["n"]
            space_total = self._db.execute("SELECT COUNT(*) AS n FROM assets").fetchone()["n"]
        return {"myTotal": my_total, "spaceTotal": space_total}

    def bound_storage_ids(self) -> set[str]:
        with self._lock:
            rows = self._db.execute("SELECT media_meta FROM assets WHERE media_meta IS NOT NULL").fetchall()
        storage_ids = set()
        for row in rows:
            try:
                meta = json.loads(row["media_meta"])
            except (TypeError, ValueError):
                continue
            if isinstance(meta, dict) and isinstance(meta.get("storageAssetId"), str):
                storage_ids.add(meta["storageAssetId"])
        return storage_ids

    def migrate_to_single_space(self) -> int:
        """One public space: every asset is visible to the whole roster."""
        with self._lock:
            cursor = self._db.execute(
                "UPDATE assets SET visibility = 'public', published_at = COALESCE(published_at, created_at)"
            )
            self._db.commit()
            return cursor.rowcount

    def create(self, owner_id: str, payload: dict) -> dict:
        if owner_id not in self.members_by_id:
            raise PermissionError("成员不存在")
        title = str(payload.get("title") or "").strip()
        content = str(payload.get("content") or "")
        asset_type = str(payload.get("type") or "")
        source = payload.get("source") or "manual"
        if not title or len(title) > 200:
            raise ValueError("标题不能为空且不超过 200 字")
        if len(content) > 200_000:
            raise ValueError("正文过长")
        if asset_type not in ASSET_TYPES:
            raise ValueError("不支持的资产类型")
        if source not in {"manual", "deepseek_harness", "asset_service"}:
            raise ValueError("来源无效")
        now = int(time.time() * 1000)
        asset_id = f"asset_{uuid.uuid4().hex[:16]}"
        record = {
            "id": asset_id,
            "owner_id": owner_id,
            "title": title,
            "description": str(payload.get("description") or "")[:500],
            "type": asset_type,
            "content": content,
            "visibility": "public",
            "source": source,
            "generation_meta": payload.get("generationMeta"),
            "media_meta": payload.get("mediaMeta"),
            "created_at": now,
            "published_at": now,
        }
        with self._lock:
            self._insert(record, now)
            self._db.commit()
            row = self._db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        return self._row_to_asset(row)

    def _can_manage(self, owner_id: str, actor_id: str, role: str) -> bool:
        return owner_id == actor_id

    def get(self, asset_id: str) -> dict:
        with self._lock:
            row = self._db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if row is None:
            raise LookupError("资产不存在")
        return self._row_to_asset(row)

    def media_visible(self, storage_id: str, member_id: str) -> bool:
        with self._lock:
            row = self._db.execute("""SELECT 1 FROM assets
                WHERE CASE WHEN json_valid(media_meta) THEN json_extract(media_meta, '$.storageAssetId') END = ?
                  AND (owner_id = ? OR visibility = 'public') LIMIT 1""", (storage_id, member_id)).fetchone()
        return row is not None

    def media_bound(self, storage_id: str) -> bool:
        with self._lock:
            row = self._db.execute("""SELECT 1 FROM assets
                WHERE CASE WHEN json_valid(media_meta) THEN json_extract(media_meta, '$.storageAssetId') END = ?
                LIMIT 1""", (storage_id,)).fetchone()
        return row is not None

    def register_generated(self, owner_id, storage_id, kind, metadata):
        now = int(time.time() * 1000)
        record_id = 'canvas_' + storage_id
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                row = self._db.execute('SELECT owner_id FROM assets WHERE id=?', (record_id,)).fetchone()
                if row is None:
                    self._insert({'id': record_id, 'owner_id': owner_id, 'title': metadata['fileName'][:200],
                                  'description': '', 'type': kind, 'content': '', 'visibility': 'public',
                                  'source': 'deepseek_harness', 'media_meta': metadata,
                                  'created_at': now, 'published_at': now}, now)
                elif row['owner_id'] != owner_id:
                    raise PermissionError('生成产物不属于当前成员')
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise

    def delete(self, asset_id: str, actor_id: str, role: str) -> dict:
        with self._lock:
            row = self._db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
            if row is None:
                raise LookupError("资产不存在")
            if not self._can_manage(row["owner_id"], actor_id, role) and role not in MANAGE_ROLES:
                raise PermissionError("权限拒绝：仅所有者或管理员可删除资产")
            self._db.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
            self._db.commit()
        return {"success": True, "message": "资产已删除"}

    def reset_seeds(self) -> None:
        """Test-only reset. Not exposed over HTTP."""
        with self._lock:
            self._db.execute("DELETE FROM assets")
            self._seed_if_empty()
            self._db.commit()
