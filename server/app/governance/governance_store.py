"""Governance and usage persistence for greenroom.

Stores external model providers configured by admin and detailed
multimodal usage logs (LLM tokens, image generation parameters, video generation parameters).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from http.cookiejar import CookieJar, DefaultCookiePolicy
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional
from decimal import Decimal
from dataclasses import replace

import httpx

CANVAS_KEY_FIELDS = (
    "zhenzhenApiKey",
    "zhenzhenSd2ApiKey",
    "rhApiKey",
    "rhIntlApiKey",
    "llmApiKey",
)


HUOBAO_MODEL_KINDS = ("llm", "image", "video")

CHARGE_SUMMARY = {
    "actualChargeCents": None,
    "actualCurrency": "CNY",
    "settledRequests": 0,
    "pendingRequests": 0,
    "unavailableRequests": 0,
}


def _add_charge(summary, row) -> None:
    if row["provider_type"] != "internal_gateway":
        return
    if row["actual_charge_cents"] is not None:
        summary["actualChargeCents"] = round((summary["actualChargeCents"] or 0) + row["actual_charge_cents"], 3)
        summary["settledRequests"] += 1
    elif row["settlement_status"] in {"pending", "unsettled"}:
        summary["pendingRequests"] += 1
    else:
        summary["unavailableRequests"] += 1


class ModelUsage:
    """Collect OpenAI usage and complete SSE events across arbitrary byte chunks."""

    def __init__(self, reference_id: Optional[str] = None):
        self.reference_id = reference_id
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_tokens = 0
        self.stream_complete = False
        self._buffer = b""
        self._data: list[bytes] = []

    def observe(self, data: dict[str, Any]) -> None:
        if not self.reference_id:
            self.reference_id = data.get("request_id") or data.get("id")
        usage = data.get("usage")
        if isinstance(usage, dict):
            self.prompt_tokens = usage.get("prompt_tokens") or usage.get("input_tokens") or self.prompt_tokens
            self.completion_tokens = usage.get("completion_tokens") or usage.get("output_tokens") or self.completion_tokens
            self.total_tokens = usage.get("total_tokens") or self.total_tokens

    def feed(self, chunk: bytes) -> None:
        self._buffer += chunk
        while b"\n" in self._buffer:
            line, self._buffer = self._buffer.split(b"\n", 1)
            line = line.removesuffix(b"\r")
            if line.startswith(b"data:"):
                self._data.append(line[5:].lstrip(b" "))
            elif not line and self._data:
                payload = b"\n".join(self._data)
                self._data.clear()
                if payload == b"[DONE]":
                    self.stream_complete = True
                else:
                    try:
                        data = json.loads(payload)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if isinstance(data, dict):
                        event = data.get("type")
                        if event in ("response.completed", "response.incomplete") and isinstance(data.get("response"), dict):
                            self.stream_complete = True
                            self.observe(data["response"])
                        else:
                            self.observe(data)


class GovernanceStore:
    def __init__(self, path: Path):
        self._lock = threading.Lock()
        self._charge_client = None
        self._charge_loop = None
        self._charge_transport = None
        self._charge_limit = None
        self._charge_tasks = set()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS gateway_binding (
              id INTEGER PRIMARY KEY CHECK(id = 1), base_url TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS gateway_settings (
              id INTEGER PRIMARY KEY CHECK(id = 1), config_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS external_providers (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              api_key TEXT NOT NULL,
              model_prefix TEXT NOT NULL,
              models TEXT NOT NULL,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plugin_provider_bindings (
              plugin_id TEXT PRIMARY KEY,
              bindings_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gateway_model_profiles (
              model_id TEXT PRIMARY KEY,
              config_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_logs (
              id TEXT PRIMARY KEY,
              timestamp INTEGER NOT NULL,
              member_id TEXT NOT NULL,
              modality TEXT NOT NULL,
              model TEXT NOT NULL,
              provider_type TEXT NOT NULL,
              provider_id TEXT,
              prompt_tokens INTEGER DEFAULT 0,
              completion_tokens INTEGER DEFAULT 0,
              total_tokens INTEGER DEFAULT 0,
              parameters_json TEXT,
              duration_seconds REAL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'success',
              duration_ms INTEGER DEFAULT 0,
              source TEXT NOT NULL DEFAULT 'unknown',
              reference_id TEXT,
              actual_charge_cents REAL,
              actual_currency TEXT,
              settlement_status TEXT NOT NULL DEFAULT 'unavailable'
            );

            CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs (timestamp);
            CREATE INDEX IF NOT EXISTS idx_usage_member ON usage_logs (member_id);
            CREATE INDEX IF NOT EXISTS idx_usage_modality ON usage_logs (modality);

            CREATE TABLE IF NOT EXISTS canvas_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              ui_font_preset TEXT NOT NULL,
              custom_ui_font TEXT NOT NULL,
              keys_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS huobao_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              models_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS creative_plugin_settings (
              plugin_id TEXT PRIMARY KEY,
              models_json TEXT NOT NULL,
              parameters_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runninghub_keys (
              id TEXT PRIMARY KEY,
              site TEXT NOT NULL,
              api_key TEXT NOT NULL,
              label TEXT NOT NULL DEFAULT '',
              is_active INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL DEFAULT 0,
              exhausted_until INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_rh_keys_site ON runninghub_keys (site, is_active, sort_order);

            CREATE TABLE IF NOT EXISTS runninghub_cursors (
              site TEXT PRIMARY KEY,
              cursor_index INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS catalog_revision (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO catalog_revision (id, revision) VALUES (1, 0);
            """
        )
        columns = {row["name"] for row in self._db.execute("PRAGMA table_info(usage_logs)")}
        for name, definition in {
            "source": "TEXT NOT NULL DEFAULT 'unknown'",
            "reference_id": "TEXT",
            "actual_charge_cents": "REAL",
            "actual_currency": "TEXT",
            "settlement_status": "TEXT NOT NULL DEFAULT 'unavailable'",
        }.items():
            if name not in columns:
                self._db.execute(f"ALTER TABLE usage_logs ADD COLUMN {name} {definition}")
        self._db.execute('BEGIN IMMEDIATE')
        provider_columns = {row["name"] for row in self._db.execute("PRAGMA table_info(external_providers)")}
        for name, definition in {
            'plugin_ids': 'TEXT',
            'retired': 'INTEGER NOT NULL DEFAULT 0',
        }.items():
            if name not in provider_columns:
                self._db.execute(f'ALTER TABLE external_providers ADD COLUMN {name} {definition}')
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def gateway_settings(self, settings, *, bind=False):
        """Resolve one request snapshot; bind before sending business requests.

        The address binding closes the first in-flight request/admin update race,
        including submissions whose response was lost before a task ID was saved.
        """
        with self._lock:
            if bind:
                self._db.execute('BEGIN IMMEDIATE')
            try:
                row = self._db.execute("SELECT config_json FROM gateway_settings WHERE id = 1").fetchone()
                if row is not None:
                    config = json.loads(row[0])
                    base = config['baseUrl']
                    settings = replace(settings, gateway_service_url=base.removesuffix('/v1'),
                                       openai_base_url=base, gateway_api_key=config['apiKey'],
                                       openai_api_key=config['apiKey'])
                if bind:
                    base = settings.openai_base_url or settings.gateway_service_url.rstrip('/') + '/v1'
                    if settings.gateway_api_key:
                        self._check_gateway_binding(base)
                        self._db.execute('INSERT OR IGNORE INTO gateway_binding (id, base_url) VALUES (1, ?)', (base,))
                    self._db.commit()
                return settings
            except Exception:
                if bind:
                    self._db.rollback()
                raise

    def _check_gateway_binding(self, base_url):
        row = self._db.execute('SELECT base_url FROM gateway_binding WHERE id = 1').fetchone()
        if row is not None and row[0] != base_url:
            raise ValueError('网关已接收业务请求，不能切换地址；请保留历史数据并由运维处理迁移')

    def has_gateway_usage(self):
        with self._lock:
            return self._db.execute("SELECT 1 FROM usage_logs WHERE provider_type = 'internal_gateway' LIMIT 1").fetchone() is not None

    def has_gateway_settings(self):
        with self._lock:
            return self._db.execute("SELECT 1 FROM gateway_settings WHERE id = 1").fetchone() is not None

    def update_gateway_settings(self, base_url, api_key):
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                self._check_gateway_binding(base_url)
                self._db.execute("INSERT INTO gateway_settings (id, config_json) VALUES (1, ?) "
                                 "ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json",
                                 (json.dumps({'baseUrl': base_url, 'apiKey': api_key}),))
                self._bump_catalog_revision()
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise

    def clear_gateway_settings(self, fallback_base):
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                self._check_gateway_binding(fallback_base)
                self._db.execute("DELETE FROM gateway_settings WHERE id = 1")
                self._bump_catalog_revision()
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise

    def get_catalog_revision(self) -> int:
        with self._lock:
            return self._db.execute("SELECT revision FROM catalog_revision WHERE id = 1").fetchone()[0]

    def _bump_catalog_revision(self) -> None:
        self._db.execute("UPDATE catalog_revision SET revision = revision + 1 WHERE id = 1")

    def _new_charge_client(self, transport):
        return httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
            timeout=httpx.Timeout(5, connect=3), limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=())))

    async def start(self, settings, *, transport=None):
        self._charge_loop = asyncio.get_running_loop()
        self._charge_transport = transport
        self._charge_limit = asyncio.Semaphore(5)
        self._charge_client = self._new_charge_client(transport)

        async def retry_pending():
            while True:
                await self.refresh_gateway_charges(settings, transport=transport, pending_only=True)
                await asyncio.sleep(30)

        task = asyncio.create_task(retry_pending())
        self._charge_tasks.add(task)
        task.add_done_callback(self._charge_tasks.discard)

    async def aclose(self):
        tasks = tuple(self._charge_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        client, self._charge_client = self._charge_client, None
        self._charge_loop = None
        if client is not None:
            await client.aclose()

    @asynccontextmanager
    async def _billing_client(self, transport):
        if (self._charge_client is not None and self._charge_loop is asyncio.get_running_loop()
                and transport is self._charge_transport):
            yield self._charge_client, self._charge_limit
        else:
            async with self._new_charge_client(transport) as client:
                yield client, asyncio.Semaphore(5)

    def schedule_gateway_charge_refresh(self, settings, *, transport=None, log_id=None, start_time=0, member_id=None):
        task = asyncio.create_task(self.refresh_gateway_charges(settings, transport=transport,
            log_id=log_id, start_time=start_time, member_id=member_id))
        self._charge_tasks.add(task)
        task.add_done_callback(self._charge_tasks.discard)

    # --- Unified Canvas Settings ---

    def get_canvas_settings(self, include_keys: bool = False) -> dict[str, Any]:
        with self._lock:
            row = self._db.execute("SELECT * FROM canvas_settings WHERE id = 1").fetchone()
        keys = {field: "" for field in CANVAS_KEY_FIELDS}
        if row:
            keys.update(json.loads(row["keys_json"]))
        result = {
            "uiFontPreset": row["ui_font_preset"] if row else "readable",
            "customUiFont": row["custom_ui_font"] if row else "",
        }
        if include_keys:
            result["keys"] = keys
        else:
            result["configuredKeys"] = {field: bool(keys[field]) for field in CANVAS_KEY_FIELDS}
        return result

    def update_canvas_settings(
        self,
        *,
        ui_font_preset: Optional[str] = None,
        custom_ui_font: Optional[str] = None,
        keys: Optional[dict[str, str]] = None,
        clear_keys: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        with self._lock:
            row = self._db.execute("SELECT * FROM canvas_settings WHERE id = 1").fetchone()
            current_keys = {field: "" for field in CANVAS_KEY_FIELDS}
            if row:
                current_keys.update(json.loads(row["keys_json"]))
            for field, value in (keys or {}).items():
                if value.strip():
                    current_keys[field] = value.strip()
            for field in clear_keys or []:
                current_keys[field] = ""
            preset = ui_font_preset if ui_font_preset is not None else (row["ui_font_preset"] if row else "readable")
            custom_font = custom_ui_font if custom_ui_font is not None else (row["custom_ui_font"] if row else "")
            self._db.execute(
                "INSERT INTO canvas_settings (id, ui_font_preset, custom_ui_font, keys_json) VALUES (1, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET ui_font_preset = excluded.ui_font_preset, "
                "custom_ui_font = excluded.custom_ui_font, keys_json = excluded.keys_json",
                (preset, custom_font, json.dumps(current_keys)),
            )
            self._bump_catalog_revision()
            self._db.commit()
        return self.get_canvas_settings()

    # --- Huobao Managed Models ---

    def get_huobao_settings(self) -> Optional[dict[str, list[str]]]:
        with self._lock:
            row = self._db.execute("SELECT models_json FROM huobao_settings WHERE id = 1").fetchone()
        if row is None:
            return None
        try:
            data = json.loads(row["models_json"])
        except (TypeError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        return {
            kind: [value for value in data.get(kind, []) if isinstance(value, str)]
            for kind in HUOBAO_MODEL_KINDS
        }

    def update_huobao_settings(self, models: dict[str, list[str]]) -> dict[str, list[str]]:
        cleaned = {
            kind: list(dict.fromkeys(value for value in models.get(kind, []) if isinstance(value, str)))
            for kind in HUOBAO_MODEL_KINDS
        }
        with self._lock:
            self._db.execute(
                "INSERT INTO huobao_settings (id, models_json, updated_at) VALUES (1, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET models_json = excluded.models_json, updated_at = excluded.updated_at",
                (json.dumps(cleaned), int(time.time())),
            )
            self._bump_catalog_revision()
            self._db.commit()
        return cleaned

    def clear_huobao_settings(self) -> None:
        with self._lock:
            self._db.execute("DELETE FROM huobao_settings WHERE id = 1")
            self._bump_catalog_revision()
            self._db.commit()

    # --- Provider Management ---

    def get_creative_settings(self, plugin_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._db.execute(
                "SELECT models_json, parameters_json FROM creative_plugin_settings WHERE plugin_id = ?",
                (plugin_id,),
            ).fetchone()
        if row is None:
            return None
        return {"models": json.loads(row["models_json"]), "parameters": json.loads(row["parameters_json"])}

    def update_creative_settings(self, plugin_id: str, models, parameters) -> None:
        with self._lock:
            if models is None:
                self._db.execute("DELETE FROM creative_plugin_settings WHERE plugin_id = ?", (plugin_id,))
            else:
                self._db.execute(
                    "INSERT INTO creative_plugin_settings (plugin_id, models_json, parameters_json, updated_at) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT(plugin_id) DO UPDATE SET "
                    "models_json = excluded.models_json, parameters_json = excluded.parameters_json, "
                    "updated_at = excluded.updated_at",
                    (plugin_id, json.dumps(models), json.dumps(parameters), int(time.time())),
                )
            self._bump_catalog_revision()
            self._db.commit()

    def provider_bindings(self, plugin_id):
        if not plugin_id:
            return {}
        with self._lock:
            row = self._db.execute('SELECT bindings_json FROM plugin_provider_bindings WHERE plugin_id = ?',
                                   (plugin_id,)).fetchone()
        return json.loads(row['bindings_json']) if row else {}

    def save_provider_bindings(self, plugin_id, bindings, *, model_selection=None):
        with self._lock, self._db:
            self._db.execute('INSERT INTO plugin_provider_bindings VALUES (?, ?) ON CONFLICT(plugin_id) '
                             'DO UPDATE SET bindings_json = excluded.bindings_json',
                             (plugin_id, json.dumps(bindings)))
            if model_selection is not None:
                self._db.execute('UPDATE creative_plugin_settings SET models_json = ?, updated_at = ? WHERE plugin_id = ?',
                                 (json.dumps(model_selection), int(time.time()), plugin_id))
            self._bump_catalog_revision()

    def gateway_model_profiles(self):
        with self._lock:
            rows = self._db.execute('SELECT model_id, config_json FROM gateway_model_profiles').fetchall()
        return {row['model_id']: json.loads(row['config_json']) for row in rows}

    def save_gateway_model_profile(self, model_id, profile):
        with self._lock, self._db:
            if profile:
                self._db.execute('INSERT INTO gateway_model_profiles VALUES (?, ?) ON CONFLICT(model_id) '
                                 'DO UPDATE SET config_json = excluded.config_json', (model_id, json.dumps(profile)))
            else:
                self._db.execute('DELETE FROM gateway_model_profiles WHERE model_id = ?', (model_id,))
            self._bump_catalog_revision()

    @staticmethod
    def _provider(row, include_key):
        key = row['api_key']
        return {
            'id': row['id'], 'name': row['name'], 'baseUrl': row['base_url'],
            'apiKey': key if include_key else (key[:3] + '...' + key[-4:] if len(key) > 8 else '***'),
            'modelPrefix': row['model_prefix'], 'models': json.loads(row['models']),
            'pluginIds': json.loads(row['plugin_ids']) if row['plugin_ids'] is not None else None,
            'isActive': bool(row['is_active']), 'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
        }

    def list_providers(self, include_key=False):
        with self._lock:
            rows = self._db.execute('SELECT * FROM external_providers WHERE retired = 0 ORDER BY created_at DESC, id').fetchall()
        return [self._provider(row, include_key) for row in rows]

    def get_provider(self, provider_id, include_key=False, *, include_retired=False):
        with self._lock:
            row = self._db.execute('SELECT * FROM external_providers WHERE id = ? AND (retired = 0 OR ?)',
                                   (provider_id, include_retired)).fetchone()
        return self._provider(row, include_key) if row else None

    def find_active_provider_for_model(self, full_model_name):
        for provider in self.list_providers(include_key=True):
            prefix = provider['modelPrefix']
            if provider['isActive'] and provider['pluginIds'] is None and prefix and full_model_name.startswith(prefix):
                return provider, full_model_name[len(prefix):]
        return None, full_model_name

    def create_provider(
        self,
        *,
        name: str,
        base_url: str,
        api_key: str,
        model_prefix: str,
        models: list[dict[str, Any]],
        is_active: bool = True,
        plugin_ids=None,
    ) -> dict[str, Any]:
        provider_id = "prov_" + uuid.uuid4().hex[:12]
        now = int(time.time())
        models_json = json.dumps(models, ensure_ascii=False)
        with self._lock:
            self._db.execute(
                "INSERT INTO external_providers (id, name, base_url, api_key, model_prefix, models, is_active, created_at, updated_at, plugin_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    provider_id,
                    name.strip(),
                    base_url.strip().rstrip("/"),
                    api_key.strip(),
                    model_prefix.strip() or provider_id + "/",
                    models_json,
                    1 if is_active else 0,
                    now,
                    now,
                    json.dumps(plugin_ids) if plugin_ids is not None else None,
                ),
            )
            self._bump_catalog_revision()
            self._db.commit()
        return self.get_provider(provider_id, include_key=False)  # type: ignore

    def update_provider(
        self,
        provider_id: str,
        *,
        name: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model_prefix: Optional[str] = None,
        models: Optional[list[dict[str, Any]]] = None,
        is_active: Optional[bool] = None,
        plugin_ids=...,
    ) -> Optional[dict[str, Any]]:
        now = int(time.time())
        with self._lock:
            row = self._db.execute(
                "SELECT name, base_url, api_key, model_prefix, models, is_active, plugin_ids FROM external_providers WHERE id = ? AND retired = 0",
                (provider_id,),
            ).fetchone()
            if not row:
                return None
            new_name = name.strip() if name is not None else row["name"]
            new_url = base_url.strip().rstrip("/") if base_url is not None else row["base_url"]
            new_key = api_key.strip() if api_key is not None and api_key.strip() and not api_key.startswith("***") else row["api_key"]
            new_prefix = (model_prefix.strip() or provider_id + "/") if model_prefix is not None else row["model_prefix"]
            new_models = json.dumps(models, ensure_ascii=False) if models is not None else row["models"]
            new_active = (1 if is_active else 0) if is_active is not None else row["is_active"]

            scope = row['plugin_ids'] if plugin_ids is ... else json.dumps(plugin_ids) if plugin_ids is not None else None
            self._db.execute(
                "UPDATE external_providers SET name = ?, base_url = ?, api_key = ?, model_prefix = ?, models = ?, is_active = ?, updated_at = ?, plugin_ids = ? WHERE id = ?",
                (new_name, new_url, new_key, new_prefix, new_models, new_active, now, scope, provider_id),
            )
            self._bump_catalog_revision()
            self._db.commit()
        return self.get_provider(provider_id, include_key=False)

    def delete_provider(self, provider_id: str) -> bool:
        with self._lock:
            cur = self._db.execute(
                "UPDATE external_providers SET retired = 1, is_active = 0 WHERE id = ? AND retired = 0",
                (provider_id,),
            )
            if cur.rowcount > 0:
                self._bump_catalog_revision()
            self._db.commit()
            return cur.rowcount > 0

    # --- RunningHub Multi-Key Pool & Rotation ---



    def list_runninghub_keys(self, site: Optional[str] = None, include_key: bool = False) -> list[dict[str, Any]]:
        now = int(time.time())
        query = "SELECT id, site, api_key, label, is_active, sort_order, exhausted_until, created_at, updated_at FROM runninghub_keys"
        params: tuple[Any, ...] = ()
        if site:
            query += " WHERE site = ? ORDER BY sort_order ASC, created_at ASC"
            params = (site,)
        else:
            query += " ORDER BY site ASC, sort_order ASC, created_at ASC"
        with self._lock:
            rows = self._db.execute(query, params).fetchall()
        result = []
        for r in rows:
            raw_key = r["api_key"]
            if not include_key:
                masked = raw_key[:4] + "..." + raw_key[-4:] if len(raw_key) > 8 else "***"
            else:
                masked = raw_key
            result.append({
                "id": r["id"],
                "site": r["site"],
                "apiKey": masked,
                "label": r["label"],
                "isActive": bool(r["is_active"]),
                "sortOrder": r["sort_order"],
                "exhaustedUntil": r["exhausted_until"],
                "isExhausted": r["exhausted_until"] > now,
                "createdAt": r["created_at"],
                "updatedAt": r["updated_at"],
            })
        return result

    def get_runninghub_key(self, key_id: str, include_key: bool = True) -> Optional[dict[str, Any]]:
        now = int(time.time())
        with self._lock:
            r = self._db.execute(
                "SELECT id, site, api_key, label, is_active, sort_order, exhausted_until, created_at, updated_at FROM runninghub_keys WHERE id = ?",
                (key_id,),
            ).fetchone()
        if not r:
            return None
        raw_key = r["api_key"]
        masked = raw_key if include_key else (raw_key[:4] + "..." + raw_key[-4:] if len(raw_key) > 8 else "***")
        return {
            "id": r["id"],
            "site": r["site"],
            "apiKey": masked,
            "label": r["label"],
            "isActive": bool(r["is_active"]),
            "sortOrder": r["sort_order"],
            "exhaustedUntil": r["exhausted_until"],
            "isExhausted": r["exhausted_until"] > now,
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
        }

    def save_runninghub_keys(self, site: str, keys: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = int(time.time())
        with self._lock:
            existing = {
                r["id"]: dict(r) for r in self._db.execute(
                    "SELECT id, api_key, label, is_active, sort_order, exhausted_until, created_at, updated_at FROM runninghub_keys WHERE site = ?",
                    (site,),
                ).fetchall()
            }
            kept_ids = set()
            for idx, item in enumerate(keys):
                item_id = item.get("id")
                raw_key = (item.get("apiKey") or "").strip()
                label = (item.get("label") or f"{'国内版' if site == 'cn' else '海外版'} Key #{idx + 1}").strip()
                is_active = 1 if item.get("isActive", True) else 0
                exhausted_until = item.get("exhaustedUntil", 0)

                if item_id and item_id in existing:
                    orig = existing[item_id]
                    actual_key = orig["api_key"] if (not raw_key or "..." in raw_key or raw_key.startswith("***")) else raw_key
                    self._db.execute(
                        "UPDATE runninghub_keys SET api_key = ?, label = ?, is_active = ?, sort_order = ?, exhausted_until = ?, updated_at = ? WHERE id = ?",
                        (actual_key, label, is_active, idx, exhausted_until, now, item_id),
                    )
                    kept_ids.add(item_id)
                elif raw_key and not ("..." in raw_key or raw_key.startswith("***")):
                    new_id = f"rhk_{uuid.uuid4().hex[:12]}"
                    self._db.execute(
                        "INSERT INTO runninghub_keys (id, site, api_key, label, is_active, sort_order, exhausted_until, created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (new_id, site, raw_key, label, is_active, idx, exhausted_until, now, now),
                    )
                    kept_ids.add(new_id)

            for old_id in existing:
                if old_id not in kept_ids:
                    self._db.execute("DELETE FROM runninghub_keys WHERE id = ?", (old_id,))
            self._bump_catalog_revision()
            self._db.commit()
        return self.list_runninghub_keys(site=site, include_key=False)

    def mark_runninghub_key_exhausted(self, key_id: str, cooldown_seconds: int = 1800) -> None:
        now = int(time.time())
        until = now + cooldown_seconds
        with self._lock:
            self._db.execute(
                "UPDATE runninghub_keys SET exhausted_until = ?, updated_at = ? WHERE id = ?",
                (until, now, key_id),
            )
            self._db.commit()

    def get_candidate_runninghub_keys(self, site: str) -> list[dict[str, Any]]:
        now = int(time.time())
        with self._lock:
            rows = self._db.execute(
                "SELECT id, site, api_key, label, is_active, sort_order, exhausted_until FROM runninghub_keys "
                "WHERE site = ? AND is_active = 1 ORDER BY sort_order ASC, created_at ASC",
                (site,),
            ).fetchall()
            if not rows:
                return []
            cursor_row = self._db.execute(
                "SELECT cursor_index FROM runninghub_cursors WHERE site = ?", (site,)
            ).fetchone()
            cursor = cursor_row[0] if cursor_row else 0
        total = len(rows)
        reordered = [dict(rows[(cursor + i) % total]) for i in range(total)]
        healthy = [r for r in reordered if r["exhausted_until"] <= now]
        exhausted = [r for r in reordered if r["exhausted_until"] > now]
        candidates = healthy + exhausted
        return [
            {
                "id": c["id"],
                "site": c["site"],
                "apiKey": c["api_key"],
                "label": c["label"],
                "isActive": bool(c["is_active"]),
                "sortOrder": c["sort_order"],
                "exhaustedUntil": c["exhausted_until"],
                "isExhausted": c["exhausted_until"] > now,
            }
            for c in candidates
        ]

    def advance_runninghub_cursor(self, site: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO runninghub_cursors (site, cursor_index) VALUES (?, 1) "
                "ON CONFLICT(site) DO UPDATE SET cursor_index = (runninghub_cursors.cursor_index + 1) % 1000000",
                (site,),
            )
            self._db.commit()

    # --- Multimodal Usage Logging ---

    def canvas_task_terminal(self, member_id: str, task_id: str, modality: str) -> Optional[str]:
        """Return only an exact Canvas task's persisted gateway terminal status."""
        with self._lock:
            row = self._db.execute(
                "SELECT status FROM usage_logs WHERE id=? AND member_id=? AND reference_id=? "
                "AND modality=? AND provider_type='internal_gateway'",
                ('canvas_' + task_id, member_id, task_id, modality),
            ).fetchone()
        return row['status'] if row and row['status'] in {'success', 'failed', 'cancelled'} else None

    def record_usage(
        self,
        *,
        member_id: str,
        modality: str,
        model: str,
        provider_type: str,
        provider_id: Optional[str] = None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
        parameters: Optional[dict[str, Any]] = None,
        duration_seconds: float = 0.0,
        status: str = "success",
        duration_ms: int = 0,
        log_id: Optional[str] = None,
        source: str = "unknown",
        reference_id: Optional[str] = None,
    ) -> str:
        log_id = log_id or "usg_" + uuid.uuid4().hex
        now = int(time.time())
        params_json = json.dumps(parameters or {}, ensure_ascii=False) if parameters else "{}"
        tot_tok = total_tokens if total_tokens > 0 else (prompt_tokens + completion_tokens)
        with self._lock:
            self._db.execute(
                "INSERT INTO usage_logs (id, timestamp, member_id, modality, model, provider_type, provider_id, prompt_tokens, completion_tokens, total_tokens, parameters_json, duration_seconds, status, duration_ms, source, reference_id, settlement_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET status = excluded.status, duration_ms = excluded.duration_ms, "
                "duration_seconds = excluded.duration_seconds WHERE usage_logs.status = 'pending' AND excluded.status != 'pending'",
                (
                    log_id,
                    now,
                    member_id,
                    modality,
                    model,
                    provider_type,
                    provider_id,
                    prompt_tokens,
                    completion_tokens,
                    tot_tok,
                    params_json,
                    duration_seconds,
                    status,
                    duration_ms,
                    source,
                    reference_id,
                    "pending" if provider_type == "internal_gateway" and reference_id else "unavailable",
                ),
            )
            self._db.commit()
        return log_id

    async def gateway_receipt(self, settings, member_id: str, reference_id: str, *, transport=None):
        # A gateway key can see more than one member. Only references already
        # recorded for this member may be queried; never expose an account-wide lookup.
        def owned_row():
            with self._lock:
                return self._db.execute(
                    "SELECT id, provider_type, actual_charge_cents, actual_currency, settlement_status "
                    "FROM usage_logs WHERE member_id = ? AND reference_id = ? ORDER BY timestamp DESC LIMIT 1",
                    (member_id, reference_id),
                ).fetchone()
        row = await asyncio.to_thread(owned_row)
        if row is None:
            return None
        if row['provider_type'] == 'internal_gateway':
            await self.refresh_gateway_charges(settings, transport=transport, log_id=row['id'], member_id=member_id)
            row = await asyncio.to_thread(owned_row)
        settled = (row['provider_type'] == 'internal_gateway' and row['actual_charge_cents'] is not None
                   and row['actual_currency'] == 'CNY'
                   and row['settlement_status'] not in {'pending', 'unsettled', 'unavailable'})
        return {'referenceId': reference_id, 'settlementStatus': row['settlement_status'],
                'settled': settled, 'currency': row['actual_currency'] if settled else None,
                'netCents': row['actual_charge_cents'] if settled else None}

    async def refresh_gateway_charges(self, settings, *, transport=None, log_id=None, start_time=0,
                                      member_id=None, pending_only=False) -> None:
        if settings.standalone:
            return
        settings = self.gateway_settings(settings)
        if not settings.gateway_service_url or not settings.gateway_api_key:
            return
        def pending_references():
            with self._lock:
                query = ("SELECT DISTINCT reference_id FROM usage_logs WHERE provider_type = 'internal_gateway' "
                         "AND reference_id IS NOT NULL AND timestamp >= ?")
                values: list[Any] = [start_time]
                if log_id:
                    query += " AND id = ?"
                    values.append(log_id)
                if member_id is not None:
                    query += " AND member_id = ?"
                    values.append(member_id)
                if pending_only:
                    query += " AND settlement_status IN ('pending', 'unsettled')"
                query += " ORDER BY timestamp DESC"
                return [row[0] for row in self._db.execute(query, values).fetchall()]
        references = await asyncio.to_thread(pending_references)
        if not references:
            return
        async with self._billing_client(transport) as (client, semaphore):

            async def refresh(reference):
                async with semaphore:
                    items = []
                    offset = 0
                    try:
                        while True:
                            response = await client.get(
                                settings.gateway_service_url + "/v1/usage/records",
                                params={"reference_id": reference, "limit": 50, "offset": offset},
                                headers={"Authorization": "Bearer " + settings.gateway_api_key},
                            )
                            response.raise_for_status()
                            page = response.json(parse_float=Decimal)
                            if not isinstance(page, dict):
                                return
                            batch, total = page.get("items"), page.get("total")
                            if (not isinstance(batch, list) or type(total) is not int or total < 0
                                    or any(not isinstance(item, dict) for item in batch)):
                                return
                            items.extend(item for item in batch
                                         if reference in {item.get("task_id"), item.get("request_id")})
                            offset += len(batch)
                            if offset > total:
                                return
                            if offset == total:
                                break
                            if not batch:
                                return
                    except (httpx.HTTPError, ValueError):
                        return
                    if not items:
                        return
                    # Gateway UsageRecordFacts are ledger-backed monetary facts;
                    # the actual public contract has no `settled` field. Missing
                    # records/amounts are unknown, not a confirmed free request.
                    # Honor an explicit pending signal if a compatible gateway sends one.
                    settled = all(item.get("settled") is not False and
                                  item.get("billing_status") not in {"pending", "unsettled"}
                                  for item in items)
                    if settled:
                        if any(item.get("currency") != "CNY" or
                               type(item.get("net_cents")) not in (int, float, Decimal) or
                               not Decimal(str(item["net_cents"])).is_finite() for item in items):
                            return
                        amount = float(sum(Decimal(str(item["net_cents"])) for item in items))
                        statuses = {item.get("billing_status") or "settled" for item in items}
                        status = statuses.pop() if len(statuses) == 1 else "settled"
                    else:
                        amount = None
                        status = "unsettled" if any(item.get("billing_status") == "unsettled" for item in items) else "pending"
                    def persist_charge():
                        with self._lock:
                            query = ("UPDATE usage_logs SET actual_charge_cents = ?, actual_currency = ?, settlement_status = ? "
                                     "WHERE provider_type = 'internal_gateway' AND reference_id = ?")
                            values = [amount, "CNY" if settled else None, status, reference]
                            if member_id is not None:
                                query += " AND member_id = ?"
                                values.append(member_id)
                            self._db.execute(query, values)
                            self._db.commit()
                    await asyncio.to_thread(persist_charge)

            try:
                await asyncio.wait_for(asyncio.gather(*(refresh(reference) for reference in references)), timeout=8)
            except asyncio.TimeoutError:
                pass

    # --- Usage Analytics & Queries ---

    def get_usage_overview(self, start_time: int = 0, *, member_id: Optional[str] = None) -> dict[str, Any]:
        with self._lock:
            query = ("SELECT modality, model, provider_type, prompt_tokens, completion_tokens, total_tokens, "
                     "duration_seconds, actual_charge_cents, settlement_status FROM usage_logs WHERE timestamp >= ?")
            values: list[Any] = [start_time]
            if member_id is not None:
                query += " AND member_id = ?"
                values.append(member_id)
            rows = self._db.execute(query, values).fetchall()

        total_requests = len(rows)
        total_llm_tokens = 0
        total_prompt_tokens = 0
        total_completion_tokens = 0
        total_image_count = 0
        total_video_count = 0
        total_video_seconds = 0.0
        modality_breakdown: dict[str, int] = {}
        model_stats: dict[str, dict[str, Any]] = {}
        charges = dict(CHARGE_SUMMARY)

        for r in rows:
            _add_charge(charges, r)
            mod = r["modality"]
            modality_breakdown[mod] = modality_breakdown.get(mod, 0) + 1
            m_name = r["model"]
            if m_name not in model_stats:
                model_stats[m_name] = {
                    "model": m_name,
                    "modality": mod,
                    "providerType": r["provider_type"],
                    "requests": 0,
                    "tokens": 0,
                    "videoSeconds": 0.0,
                    **CHARGE_SUMMARY,
                }
            model_stats[m_name]["requests"] += 1
            _add_charge(model_stats[m_name], r)

            if mod == "llm":
                pt = r["prompt_tokens"] or 0
                ct = r["completion_tokens"] or 0
                tt = r["total_tokens"] or (pt + ct)
                total_llm_tokens += tt
                total_prompt_tokens += pt
                total_completion_tokens += ct
                model_stats[m_name]["tokens"] += tt
            elif mod == "image":
                total_image_count += 1
            elif mod == "video":
                total_video_count += 1
                sec = float(r["duration_seconds"] or 0.0)
                total_video_seconds += sec
                model_stats[m_name]["videoSeconds"] = round(model_stats[m_name]["videoSeconds"] + sec, 1)

        top_models = sorted(model_stats.values(), key=lambda x: x["requests"], reverse=True)[:15]

        return {
            "totalRequests": total_requests,
            "totalLlmTokens": total_llm_tokens,
            "totalPromptTokens": total_prompt_tokens,
            "totalCompletionTokens": total_completion_tokens,
            "totalImageCount": total_image_count,
            "totalVideoCount": total_video_count,
            "totalVideoSeconds": round(total_video_seconds, 1),
            "modalityBreakdown": modality_breakdown,
            "topModels": top_models,
            **charges,
        }

    def get_member_usage(self, start_time: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT member_id, modality, provider_type, prompt_tokens, completion_tokens, total_tokens, parameters_json, duration_seconds, actual_charge_cents, settlement_status FROM usage_logs WHERE timestamp >= ?",
                (start_time,),
            ).fetchall()

        members_map: dict[str, dict[str, Any]] = {}
        param_map: dict[str, dict[str, dict[str, int]]] = {}

        for r in rows:
            m_id = r["member_id"]
            if m_id not in members_map:
                members_map[m_id] = {
                    "memberId": m_id,
                    "totalRequests": 0,
                    "llmTokens": 0,
                    "promptTokens": 0,
                    "completionTokens": 0,
                    "imageCount": 0,
                    "videoCount": 0,
                    "videoSeconds": 0.0,
                    **CHARGE_SUMMARY,
                }
                param_map[m_id] = {"image": {}, "video": {}}

            item = members_map[m_id]
            item["totalRequests"] += 1
            _add_charge(item, r)
            mod = r["modality"]

            if mod == "llm":
                pt = r["prompt_tokens"] or 0
                ct = r["completion_tokens"] or 0
                tt = r["total_tokens"] or (pt + ct)
                item["llmTokens"] += tt
                item["promptTokens"] += pt
                item["completionTokens"] += ct
            elif mod == "image":
                item["imageCount"] += 1
                pj = r["parameters_json"]
                if pj:
                    param_map[m_id]["image"][pj] = param_map[m_id]["image"].get(pj, 0) + 1
            elif mod == "video":
                item["videoCount"] += 1
                sec = float(r["duration_seconds"] or 0.0)
                item["videoSeconds"] = round(item["videoSeconds"] + sec, 1)
                pj = r["parameters_json"]
                if pj:
                    param_map[m_id]["video"][pj] = param_map[m_id]["video"].get(pj, 0) + 1

        result = []
        for m_id, data in members_map.items():
            img_profiles = []
            for pj_str, cnt in param_map[m_id]["image"].items():
                try:
                    p = json.loads(pj_str)
                except Exception:
                    p = {}
                img_profiles.append({"params": p, "count": cnt})

            vid_profiles = []
            for pj_str, cnt in param_map[m_id]["video"].items():
                try:
                    p = json.loads(pj_str)
                except Exception:
                    p = {}
                vid_profiles.append({"params": p, "count": cnt})

            data["imageParameterProfiles"] = img_profiles
            data["videoParameterProfiles"] = vid_profiles
            result.append(data)

        result.sort(key=lambda x: x["totalRequests"], reverse=True)
        return result

    def get_usage_logs(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        member_id: Optional[str] = None,
        modality: Optional[str] = None,
        start_time: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        with self._lock:
            query = "FROM usage_logs WHERE timestamp >= ?"
            values: list[Any] = [start_time]
            if member_id is not None:
                query += " AND member_id = ?"
                values.append(member_id)
            if modality:
                query += " AND modality = ?"
                values.append(modality)
            total_count = self._db.execute("SELECT COUNT(*) " + query, values).fetchone()[0]
            rows = self._db.execute(
                "SELECT * " + query + " ORDER BY timestamp DESC LIMIT ? OFFSET ?",
                (*values, limit, offset),
            ).fetchall()

        logs = []
        for r in rows:
            parsed_params = {}
            if r["parameters_json"]:
                try:
                    parsed_params = json.loads(r["parameters_json"])
                except Exception:
                    pass
            logs.append({
                "id": r["id"],
                "timestamp": r["timestamp"],
                "memberId": r["member_id"],
                "modality": r["modality"],
                "model": r["model"],
                "providerType": r["provider_type"],
                "providerId": r["provider_id"],
                "promptTokens": r["prompt_tokens"] or 0,
                "completionTokens": r["completion_tokens"] or 0,
                "totalTokens": r["total_tokens"] or 0,
                "parameters": parsed_params,
                "durationSeconds": r["duration_seconds"] or 0.0,
                "status": r["status"],
                "durationMs": r["duration_ms"] or 0,
                "source": r["source"],
                "referenceId": r["reference_id"],
                "actualChargeCents": r["actual_charge_cents"],
                "actualCurrency": r["actual_currency"],
                "settlementStatus": r["settlement_status"],
            })
        return logs, total_count
