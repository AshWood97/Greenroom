"""T8's managed GREENROOM provider, authenticated by the member runtime edge."""
import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import tempfile
import uuid
from contextlib import asynccontextmanager
from http.cookiejar import CookieJar, DefaultCookiePolicy
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.identity.auth import AuthError, current_member
from app.governance.governance_store import HUOBAO_MODEL_KINDS, GovernanceStore, ModelUsage
from app.governance.provider_routing import (IMAGE_SIZES, IMAGE_QUALITIES, IMAGE_COMPLEXITIES,
    LUNA_PROFILE, available_models, chat_to_responses, resolve_provider, response_as_chat, response_event_as_chat,
    text_reasoning)

from app.assets.scopes import personal_scope, scope_headers


class SubmissionRejected(AuthError):
    """This request was rejected before a generation task or provider call was created."""


RUNNINGHUB_ORIGINS = {'cn': 'https://www.runninghub.cn', 'intl': 'https://www.runninghub.ai'}
RUNNINGHUB_OUTPUT_FPS = {'1x', '2x', '3x', '4x', '23.976', '24', '25', '29.97', '30',
                       '48', '50', '59.94', '60', '72', '90', '96', '120', '144'}
GENERATION_FIELDS = {'model', 'apiModel', 'prompt', 'aspect_ratio', 'ratio', 'size', 'image_size', 'n',
                     'duration', 'resolution', 'seed', 'generate_audio', 'providerParams', 'images',
                     'reference_images', 'reference_image_urls', 'quality', 'complexity', 'image_url', 'first_frame_url',
                     'last_frame_url', 'reference_video_urls', 'reference_audio_urls', 'input_refs', 'mask'}
# The public catalog exposes channel aliases such as "Nano Banana" or "星图"; only the
# verified product titles of these four image channels replace the label, never the id.
IMAGE_LABELS = {'aws/google/gemini-2.5-flash-image': 'Gemini 2.5 Flash Image',
                'aws/google/gemini-3-pro-image': 'Gemini 3 Pro Image',
                'aws/google/gemini-3.1-flash-image': 'Gemini 3.1 Flash Image',
                'starnet/gpt-image-2': 'GPT Image 2'}
# The provider title the catalog itself reports for the StarNet channel. Only this exact
# value marks a StarNet SKU; display names and id prefixes never imply it.
STARNET_PROVIDER_LABEL = '星网'
OPENAI_ORIGIN = 'https://api.openai.com'
OPENAI_IMAGE_MODEL = 'gpt-image-2.6-flare'
OPENAI_IMAGE_PREFIX = 'openai-image-'
OPENAI_IMAGE_TIMEOUT = 180
OPENAI_IMAGE_PRESET = {'size': '1024x1024', 'quality': 'low', 'complexity': 'low', 'n': 1}


def generation_error_text(value, *, status=None, secrets=()):
    """Keep public provider error fields, without forwarding response bodies."""
    def extract(item):
        if isinstance(item, str):
            text = item.strip()
            if text.startswith(('{', '[')):
                try:
                    return extract(json.loads(text))
                except ValueError:
                    pass
            return text
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            return str(item)
        if isinstance(item, list):
            return next((text for entry in item if (text := extract(entry))), '')
        if not isinstance(item, dict):
            return ''
        message = next((text for key in (
            'error_message', 'errorMessage', 'error_msg', 'errorMsg', 'exception_message',
            'message', 'msg', 'error', 'detail', 'failReason', 'failedReason', 'reason',
        ) if (text := extract(item.get(key)))), '')
        code = item.get('error_code') or item.get('errorCode') or item.get('code')
        if (isinstance(code, (str, int)) and code not in ('', '0', 0)
                and message != str(code) and '[' + str(code) + ']' not in message):
            message += (' ' if message else '') + '[' + str(code) + ']'
        return message

    text = extract(value) or '服务商未返回具体失败原因'
    if status is not None:
        text += f' (HTTP {status})'
    for secret in secrets:
        if secret:
            text = text.replace(secret, '***')
    text = re.sub(r'\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer ***', text, flags=re.I)
    text = re.sub(r'''(["']?(?:api[ _-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|client[_-]?secret|secret)["']?\s*[:=]\s*)["']?[^\s,"';&}]+["']?''',
                  r'\1***', text, flags=re.I)
    text = re.sub(r'\bsk-[A-Za-z0-9_-]{8,}\b', '***', text)

    def clean_url(match):
        try:
            url = urlsplit(match.group())
        except ValueError:
            return re.sub(r'[?#].*$', '?***', re.sub(r'(https?://)[^/@]*@', r'\1', match.group(), flags=re.I))
        authority = url.netloc.rsplit('@', 1)[-1]
        return f'{url.scheme}://{authority}{url.path}' + ('?***' if url.query or url.fragment else '')

    text = re.sub(r'''https?://[^\s<>"']+''', clean_url, text, flags=re.I)
    return re.split(r'\n\s*(?:at\s+|Traceback\b)', text, maxsplit=1)[0].strip()


class CanvasService:
    def __init__(self, settings, edge, media, *, transport=None, governance=None):
        self.settings, self.edge, self.media, self.transport = settings, edge, media, transport
        self.governance = governance or GovernanceStore(Path(settings.data_dir) / 'admin_governance.sqlite3')
        self._catalogs = {}
        self._catalog_locks = {}
        self._catalog_revision = None
        self._clients = {}
        self._started = False
        self._client_loop = None
        self.lock = threading.Lock()
        self.runninghub_submission_lock = asyncio.Lock()
        self.archive_lock = asyncio.Lock()
        self._openai_image_jobs = set()
        self.db = sqlite3.connect(Path(settings.data_dir) / 'canvas.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA busy_timeout=5000')
        self.db.execute('''CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, member TEXT NOT NULL, tenant TEXT NOT NULL, actor TEXT NOT NULL,
            kind TEXT NOT NULL, submission TEXT NOT NULL, outputs TEXT NOT NULL DEFAULT '[]',
            UNIQUE(member, tenant, actor, submission))''')
        self.db.execute('''CREATE TABLE IF NOT EXISTS task_usage (
            task_id TEXT PRIMARY KEY, model TEXT NOT NULL, parameters TEXT NOT NULL, started REAL NOT NULL,
            source TEXT NOT NULL DEFAULT 't8')''')
        self.db.execute('BEGIN IMMEDIATE')
        if 'source' not in {row['name'] for row in self.db.execute('PRAGMA table_info(task_usage)')}:
            self.db.execute("ALTER TABLE task_usage ADD COLUMN source TEXT NOT NULL DEFAULT 't8'")
        columns = {row['name'] for row in self.db.execute('PRAGMA table_info(tasks)')}
        for name, definition in {
                'poll_result': 'TEXT', 'poll_error': 'TEXT', 'poll_error_status': 'INTEGER',
                'poll_version': 'INTEGER NOT NULL DEFAULT 0', 'poll_token': 'TEXT',
                'poll_until': 'REAL NOT NULL DEFAULT 0'}.items():
            if name not in columns:
                self.db.execute(f'ALTER TABLE tasks ADD COLUMN {name} {definition}')
        self.db.execute('''CREATE TABLE IF NOT EXISTS local_openai_images (
            task_id TEXT PRIMARY KEY, started REAL NOT NULL, state TEXT NOT NULL,
            image BLOB, error TEXT)''')
        self.db.commit()

    def local_openai(self, gateway):
        return self.settings.standalone and gateway.gateway_service_url.rstrip('/') == OPENAI_ORIGIN

    def headers(self, member, *, asset_scope=True, gateway=None):
        gateway = gateway or self.governance.gateway_settings(self.settings)
        if not gateway.gateway_api_key:
            raise AuthError(503, '画布生成尚未配置平台网关，请联系管理员')
        if self.settings.environment == 'development' and self.settings.local_member_id:
            # A single-member developer key acts as its own gateway principal.
            # Local Asset requests keep their independent verified member scope.
            headers = {}
        else:
            headers = scope_headers(personal_scope(member)) if asset_scope else scope_headers({
                'resource_tenant_id': member.tenant_id, 'workspace_id': member.user_id,
                'kind': 'personal', 'resource_id': member.user_id, 'actor_id': member.user_id,
            })
        headers.update({'Authorization': 'Bearer ' + gateway.gateway_api_key, 'Accept-Encoding': 'identity'})
        if self.settings.staging_gateway_token:
            headers['X-GREENROOM-Staging-Token'] = self.settings.staging_gateway_token
        return headers

    async def start(self):
        self._started = True
        self._client_loop = asyncio.get_running_loop()

    async def aclose(self):
        jobs = list(self._openai_image_jobs)
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        self._started = False
        self._client_loop = None
        clients, self._clients = list(self._clients.values()), {}
        await asyncio.gather(*(client.aclose() for client in clients))

    @asynccontextmanager
    async def client(self, scope='gateway'):
        pooled = self._started and self._client_loop is asyncio.get_running_loop()
        client = self._clients.get(scope) if pooled else None
        owned = client is None and not pooled
        if client is None:
            client = httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False,
                                      timeout=httpx.Timeout(600, connect=10),
                                      limits=httpx.Limits(max_connections=100, max_keepalive_connections=8),
                                      cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=())))
            if pooled:
                self._clients[scope] = client
        try:
            yield client
        finally:
            if owned:
                await client.aclose()

    async def call(self, member, method, path, *, payload=None, submission=None, usage=None):
        # Catalogues and text responses have no asset output destination.
        gateway = self.governance.gateway_settings(self.settings, bind=method.upper() != "GET")
        headers = self.headers(member, asset_scope=path not in {'/v1/models', '/v1/chat/completions'}, gateway=gateway)
        if submission:
            workspace_id = (member.member_id if self.settings.environment == 'development' and self.settings.local_member_id
                            else headers['X-GREENROOM-Workspace-ID'])
            raw_key = workspace_id + ':' + submission
            if len(raw_key) > 75:
                # 确定性哈希压缩超长键，总长为 4 + 64 = 68 字符，严格满足上游 VARCHAR(80) 限制并保持幂等性
                headers['Idempotency-Key'] = 'ogr_' + hashlib.sha256(raw_key.encode('utf-8')).hexdigest()
            else:
                headers['Idempotency-Key'] = raw_key
        try:
            async with self.client() as client:
                response = await client.request(method, gateway.gateway_service_url + path, headers=headers, json=payload)
        except httpx.TimeoutException as exc:
            raise AuthError(504, '平台生成服务请求超时') from exc
        except httpx.HTTPError as exc:
            raise AuthError(502, '无法连接平台生成服务') from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise AuthError(response.status_code if not response.is_success else 502,
                            f'平台生成服务返回非 JSON 响应 (HTTP {response.status_code})') from exc
        if not response.is_success:
            raise AuthError(response.status_code, generation_error_text(data, status=response.status_code,
                            secrets=(gateway.gateway_api_key, self.settings.staging_gateway_token)))
        if not isinstance(data, dict):
            raise AuthError(502, f'平台生成服务返回格式异常 (HTTP {response.status_code})')
        if usage is not None:
            usage.reference_id = response.headers.get('X-Request-ID') or usage.reference_id
            usage.observe(data)
        return data

    async def catalog(self, member, *, require_fresh=False):
        # Authentication remains at the request boundary; only provider data is cached.
        if self.settings.standalone:
            gateway = self.governance.gateway_settings(self.settings)
            if not gateway.gateway_service_url or not gateway.gateway_api_key:
                return {'data': []}
        self.headers(member, asset_scope=False)
        while True:
            revision = self.governance.get_catalog_revision()
            if revision != self._catalog_revision:
                self._catalogs.clear()
                self._catalog_locks.clear()
                self._catalog_revision = revision
            gateway = self.governance.gateway_settings(self.settings)
            key = (revision, gateway.gateway_service_url, gateway.gateway_api_key,
                   self.settings.staging_gateway_token, tuple(self.settings.gateway_models),
                   member.tenant_id, member.user_id, member.member_id)
            cached = self._catalogs.get(key)
            if not require_fresh and cached and cached['expires'] > time.monotonic():
                return cached['value']
            async with self._catalog_locks.setdefault((asyncio.get_running_loop(), key), asyncio.Lock()):
                cached = self._catalogs.get(key)
                if not require_fresh and cached and cached['expires'] > time.monotonic():
                    return cached['value']
                try:
                    catalog = await self.call(member, 'GET', '/v1/models')
                    if require_fresh and not any(key in catalog for key in ('models', 'data')):
                        raise AuthError(502, '平台模型目录格式异常')
                    if any(key in catalog and (not isinstance(catalog[key], list)
                               or any(not isinstance(row, dict) for row in catalog[key]))
                           for key in ('models', 'data')):
                        raise AuthError(502, '平台模型目录格式异常')
                except AuthError as exc:
                    if self.governance.get_catalog_revision() != revision:
                        continue
                    if require_fresh or cached is None or exc.status < 500:
                        raise
                    return cached['value']
                if self.governance.get_catalog_revision() != revision:
                    continue
                catalog['greenroom_local_openai'] = self.local_openai(gateway)
                self._catalogs[key] = {'value': catalog, 'expires': time.monotonic() + 60}
                return catalog

    @staticmethod
    def _declared_input_modalities(capabilities):
        """Input modalities only when the catalog declares them for real.

        A missing, empty, malformed or explicitly `unknown` declaration is not
        evidence of compatibility, so it returns None rather than an empty list; an
        empty list would make any subset check pass.
        """
        if not isinstance(capabilities, dict) or capabilities.get('verification_status') == 'unknown':
            return None
        declared = capabilities.get('input_modalities')
        if not isinstance(declared, list) or not declared:
            return None
        if any(not isinstance(value, str) or not value for value in declared):
            return None
        return declared

    def grouped_models(self, catalog):
        profiles = self.governance.gateway_model_profiles()
        grouped = {'llm': [], 'image': [], 'video': []}
        # GREENROOM's data array mirrors every modality without kind/status metadata.
        # Its richer models array is authoritative, including an empty catalog.
        for model in catalog.get('models', catalog.get('data', [])):
            kind = {'text.generation': 'llm', 'chat': 'llm', 'image.generation': 'image',
                    'video.generation': 'video'}.get(model.get('kind'), model.get('kind'))
            model_id = model.get('slug') or model.get('id')
            local_openai = catalog.get('greenroom_local_openai') is True
            if local_openai and self.settings.local_asset and model_id in {OPENAI_IMAGE_MODEL, 'gpt-image-2.6-sunburst'}:
                grouped['image'].append({
                    'id': model_id, 'label': 'GPT Image 2.6 Flare' if model_id == OPENAI_IMAGE_MODEL else 'GPT Image 2.6 Sunburst',
                    'provider_label': 'OpenAI', 'profile': {**OPENAI_IMAGE_PRESET, **profiles.get(model_id, {})},
                    'capabilities': {'input_modalities': ['text'], 'size': list(IMAGE_SIZES),
                                     'quality': list(IMAGE_QUALITIES), 'complexity': list(IMAGE_COMPLEXITIES)},
                })
                continue
            # Plain OpenAI catalogs cannot identify media models. Keep the
            # configured fallback only for entries with no modality metadata.
            if kind is None and model_id in self.settings.gateway_models:
                kind = 'llm'
            if kind not in grouped or not model_id or model.get('status', 'active') != 'active':
                continue
            if any(option['id'] == model_id for option in grouped[kind]):
                continue
            label = model.get('display_name') or model_id
            if kind == 'image':
                label = IMAGE_LABELS.get(model_id, label)
            option = {'id': model_id, 'label': label, 'capabilities': model.get('capabilities') or {}}
            if kind in {'llm', 'image'}:
                if isinstance(model.get('base_slug'), str) and model['base_slug']:
                    option['base_slug'] = model['base_slug']
                if isinstance(model.get('provider_label'), str) and model['provider_label']:
                    option['provider_label'] = model['provider_label']
                if kind == 'llm':
                    if local_openai:
                        option['api'] = 'openai-responses'
                    profile = profiles.get(model_id, LUNA_PROFILE if local_openai and model_id == 'gpt-6-luna' else {})
                    if profile:
                        option['profile'] = profile
                    option['catalog_order'] = len(grouped[kind])
            grouped[kind].append(option)
        if catalog.get('greenroom_local_openai') is True:
            # Implicit plugin defaults use catalog order. Explicit plugin choices keep their own order.
            grouped['llm'].sort(key=lambda option: option['id'] != 'gpt-6-luna')
        for kind in ('llm', 'image'):
            families = {}
            for index, option in enumerate(grouped[kind]):
                if option.get('base_slug'):
                    families.setdefault(option['base_slug'], []).append(index)
            for positions in families.values():
                entries = [grouped[kind][index] for index in positions]
                # Only a real declaration on both sides may reorder; unknown capabilities
                # keep the catalog's own order rather than passing an empty check.
                required = self._declared_input_modalities(entries[0]['capabilities'])
                preferred = None
                if required is not None:
                    preferred = next((option for option in entries
                                      if option.get('provider_label') == STARNET_PROVIDER_LABEL
                                      and self._covers(option['capabilities'], required)), None)
                if preferred:
                    ordered = [preferred] + [option for option in entries if option is not preferred]
                    for index, option in zip(positions, ordered):
                        grouped[kind][index] = option
        return grouped

    async def models(self, member, plugin_id=None):
        try:
            grouped = self.grouped_models(await self.catalog(member))
        except AuthError:
            grouped = {kind: [] for kind in ('llm', 'image', 'video')}
            if not any(available_models(self.governance, kind, [], plugin_id) for kind in ('llm', 'image')):
                raise
        for kind in ('llm', 'image'):
            grouped[kind] = available_models(self.governance, kind, grouped[kind], plugin_id)
        return grouped

    async def huobao_models(self, member):
        grouped = await self.models(member, 'huobao')
        selected = self.governance.get_huobao_settings()
        if selected is None:
            return {'models': grouped, 'configured': False}
        filtered = {}
        bindings = self.governance.provider_bindings('huobao')
        for kind in HUOBAO_MODEL_KINDS:
            if kind in bindings:
                filtered[kind] = grouped[kind]
                continue
            by_id = {option['id']: option for option in grouped[kind]}
            filtered[kind] = [by_id[model_id] for model_id in selected[kind] if model_id in by_id]
        return {'models': filtered, 'configured': True}

    @staticmethod
    def _covers(capabilities, required):
        """Whether a candidate's declared modalities include every required one.

        Both sides must be real declarations; a candidate with no usable declaration
        never satisfies a requirement.
        """
        declared = CanvasService._declared_input_modalities(capabilities)
        return declared is not None and all(value in declared for value in required)

    @staticmethod
    def _scenario_ids(scenario, selected, kind):
        """The ids a scenario's own governance allows, or None for no scenario filter.

        `selected` is the governance selection already read for this decision: None means
        Huobao has no saved list and applies no extra filter, while a saved list — even an
        empty one — is the exact set of complete ids that scenario may submit.
        """
        if scenario != 'huobao' or selected is None:
            return None
        return set(selected[kind])

    def _allowed_ids(self, catalog, kind, scenario, selected):
        """The ids this member may use in `scenario`, computed from one catalog snapshot.

        The member's own authorization comes from `grouped_models` on this snapshot, and
        the already-read scenario selection then narrows it. This is a pure calculation:
        it performs no further catalog or governance read, so the result can never mix a
        different revision's catalog with this scenario list.
        """
        allowed = {option['id'] for option in self.grouped_models(catalog)[kind]}
        scenario_ids = self._scenario_ids(scenario, selected, kind)
        return allowed if scenario_ids is None else allowed & scenario_ids

    async def model(self, member, kind, requested):
        options = (await self.models(member))[kind]
        if not any(m['id'] == requested for m in options):
            raise AuthError(403, '此模型未在平台开通，请从 GREENROOM 模型列表选择')
        return requested

    async def resolve_submission_model(self, member, kind, requested, scenario='t8'):
        """The model actually submitted, resolved before any request leaves the service.

        A requested id that is still available for this member and scenario is returned
        unchanged. A disabled channel is not replaced by another one in this batch: an
        unconfirmed id, a missing row, unknown capabilities, an authorization exclusion
        or an unreadable catalog raises for the user to reselect, and no generation
        request is sent. Because this runs before the upstream call, an accepted task,
        its receipts and its recovery stay bound to what was sent.
        """
        if not requested:
            raise AuthError(403, '此模型未在平台开通，请从 GREENROOM 模型列表选择')
        # The scenario's own governance selection is read once here, before anything is
        # sent, and the member's authorization comes from the same catalog snapshot.
        selected = self.governance.get_huobao_settings()
        catalog = await self.catalog(member)
        member_ids = self._allowed_ids(catalog, kind, 't8', None)
        scenario_ids = self._scenario_ids(scenario, selected, kind)
        if requested in member_ids:
            if scenario_ids is None or requested in scenario_ids:
                return requested
            # The member may use this id, but this scenario's own list excludes it, so it
            # may not be submitted here.
            raise AuthError(403, '此模型未在火宝已配置的模型列表中，请重新选择')
        # Not authorized for this member, or absent from the snapshot: no sibling id may
        # bypass that exclusion, so the request is refused rather than re-picked.
        raise AuthError(403, '此模型未在平台开通，请从 GREENROOM 模型列表选择')

    def task(self, member, task_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM tasks WHERE id=? AND member=? AND tenant=? AND actor=?',
                                  (task_id, member.member_id, member.tenant_id, member.user_id)).fetchone()
        if row is None:
            raise AuthError(404, '生成任务不存在或无权访问')
        return dict(row)

    def member_pending(self, member_id):
        """Whether Canvas work requires this member's environment to stay awake.

        A confirmed gateway completion awaiting shared-Web archival can be
        queried again by its original task ID after wake. It remains pending in
        the task ledger; this predicate does not complete or archive it.
        """
        with self.lock:
            rows = self.db.execute('SELECT * FROM tasks WHERE member=?', (member_id,)).fetchall()
        for row in rows:
            # An actual poll may be changing the shared record right now.
            if row['poll_token'] and row['poll_until'] > time.time():
                return True
            try:
                result = json.loads(row['poll_result']) if row['poll_result'] else None
            except (TypeError, ValueError):
                return True
            if result is None:
                if row['poll_result'] is None and row['poll_version'] == 0 and self._legacy_terminal(row):
                    continue
                return True
            if not isinstance(result, dict):
                return True
            if result.get('status') in {'succeeded', 'failed', 'cancelled'}:
                continue
            # Only refresh_task writes this flag, after the original gateway
            # task reports succeeded. RunningHub and unknown states stay busy.
            if (row['poll_version'] > 0 and row['kind'] in {'image', 'video', 'music'}
                    and result.get('status') == 'pending' and result.get('archivePending') is True):
                continue
            return True
        return False

    def _legacy_terminal(self, row):
        """Use existing exact-task usage and output ownership for old rows."""
        if row['kind'] not in {'image', 'video', 'music'}:
            return False
        status = self.governance.canvas_task_terminal(row['member'], row['id'], row['kind'])
        try:
            outputs = json.loads(row['outputs'])
        except (TypeError, ValueError):
            return False
        if not isinstance(outputs, list):
            return False
        if status in {'failed', 'cancelled'}:
            return not outputs
        if status != 'success' or not outputs:
            return False
        for url in outputs:
            if not isinstance(url, str):
                return False
            parsed = urlsplit(url)
            prefix = '/api/media/'
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or not parsed.path.startswith(prefix):
                return False
            asset_id = unquote(parsed.path.removeprefix(prefix))
            if not asset_id or '/' in asset_id or '\\' in asset_id:
                return False
            try:
                asset = self.media.store.get(asset_id)
            except (AuthError, TypeError, ValueError):
                return False
            scope = asset.get('scope')
            if (asset.get('owner_id') != row['member'] or asset.get('state') != 'ready'
                    or not isinstance(scope, dict) or scope.get('kind') != 'project'
                    or scope.get('resource_tenant_id') != row['tenant'] or scope.get('actor_id') != row['actor']
                    or not scope.get('workspace_id') or not scope.get('resource_id')):
                return False
        return True

    async def references(self, member, values):
        refs = []
        for value in values:
            if not isinstance(value, str):
                raise AuthError(422, '参考素材格式无效')
            parsed = urlsplit(value)
            local_hosts = {'127.0.0.1:3081', urlsplit(self.settings.origin).netloc}
            local_hosts.update(urlsplit(slot['origin']).netloc for slot in (self.settings.runtime_slots or {}).values())
            if parsed.path.startswith('/creative-managed/media/') and (not parsed.netloc or parsed.netloc in local_hosts):
                parsed = parsed._replace(path='/api/media/' + parsed.path.removeprefix('/creative-managed/media/'))
                value = parsed.geturl()
            if value.startswith('/api/media/') or (parsed.netloc in local_hosts and parsed.path.startswith('/api/media/')):
                asset_id = unquote(parsed.path.removeprefix('/api/media/'))
                if not asset_id or '/' in asset_id or parsed.query or parsed.fragment:
                    raise AuthError(422, '参考素材标识无效')
                if self.settings.environment == 'development' and self.settings.local_member_id:
                    media = self.media.store.get(asset_id)
                    if media['state'] != 'ready' or media['owner_id'] != member.member_id:
                        raise AuthError(403, '参考素材不属于当前成员或尚未归档')
                    with self.lock:
                        source = self.db.execute(
                            "SELECT tasks.id AS task_id, output.key AS asset_id FROM tasks, json_each(tasks.outputs) AS output "
                            "WHERE tasks.member=? AND tasks.tenant=? AND tasks.actor=? "
                            "AND json_type(tasks.outputs)='object' AND output.value=? LIMIT 1",
                            (member.member_id, member.tenant_id, member.user_id, asset_id)).fetchone()
                    if source is None:
                        # Uploaded assets have no generation task. Resolve their real signed
                        # Asset URL using the persisted owner/scope, just as production does.
                        value = await self.media.reference_url(member, asset_id)
                    else:
                        task = await self.call(member, 'GET', '/v1/tasks/' + quote(source['task_id'], safe=''))
                        value = next((item.get('url') for item in task.get('results', [])
                                      if isinstance(item, dict) and item.get('asset_id') == source['asset_id']), None)
                    if not isinstance(value, str) or not value:
                        raise AuthError(502, '原生成任务的参考素材地址尚不可用，请稍后重试')
                    remote = urlsplit(value)
                    if (remote.scheme != 'https' or not remote.hostname or remote.hostname in {'localhost', '127.0.0.1', '::1'}
                            or remote.hostname.endswith('.localhost')):
                        raise AuthError(502, '原生成任务的参考素材地址无法供远端访问')
                else:
                    value = await self.media.reference_url(member, asset_id)
            if value.startswith(('/files/input/', '/files/output/')):
                if self.edge is None:
                    raise AuthError(422, '请先将本地参考素材归档后再生成')
                slot = self.edge.slots[member.member_id]
                async with self.edge.client() as client:
                    async with client.get(slot['connector'] + '/canvas' + value) as response:
                        if response.status != 200:
                            raise AuthError(422, '参考素材不可读取')
                        body = bytearray()
                        async for chunk in response.content.iter_chunked(65536):
                            body.extend(chunk)
                            if len(body) > self.settings.upload_max_bytes:
                                raise AuthError(413, '参考素材过大')
                        mime = response.headers.get('Content-Type', 'application/octet-stream').split(';')[0]
                value = 'data:' + mime + ';base64,' + base64.b64encode(body).decode()
            refs.append(value)
        return refs

    async def submit(self, member, kind, body, submission, *, source='t8', plugin_id=None):
        # Only this preflight region is known not to have submitted generation.
        # Catalogue/asset reads may fail here, but the generation POST is below.
        try:
            if not isinstance(body, dict):
                raise AuthError(422, '生成请求格式无效')
            if submission and submission.startswith('huobao:'):
                source = 'huobao'
            if not isinstance(body.get('prompt'), str) or not body['prompt'].strip():
                raise AuthError(422, '请填写生成提示词')
            submission = kind + ':' + (submission or str(uuid.uuid4()))
            with self.lock:
                existing = self.db.execute('SELECT id FROM tasks WHERE member=? AND tenant=? AND actor=? AND submission=?',
                                           (member.member_id, member.tenant_id, member.user_id, submission)).fetchone()
            if existing:
                return existing['id']
            plugin_id = plugin_id or (source if source in ('t8', 'huobao') else None)
            requested = body.get('apiModel') or body.get('model')
            route = resolve_provider(self.governance, kind, requested, plugin_id) if kind == 'image' else None
            model = route[1] if route else await self.resolve_submission_model(member, kind, requested, source)
            refs = []
            for key in ('images', 'reference_images', 'reference_image_urls'):
                values = body.get(key) or []
                if not isinstance(values, list):
                    raise AuthError(422, '参考素材格式无效')
                refs.extend(values)
            refs = await self.references(member, refs)
            payload = {'model': model, 'prompt': body['prompt']}
            if body.get('mask'):
                if kind != 'image' or not refs:
                    raise AuthError(422, '蒙版编辑需要图片生成能力和参考图片')
                payload['mask'] = (await self.references(member, [body['mask']]))[0]
            provider_params = body.get('providerParams') or {}
            if not isinstance(provider_params, dict):
                raise AuthError(422, '生成参数格式无效')
            params = {k: v for k, v in provider_params.items()
                      if k in {'size', 'width', 'height', 'duration', 'resolution', 'aspect_ratio', 'ratio', 'seed', 'quality', 'complexity', 'negative_prompt', 'generate_audio'}}
            for key in ('aspect_ratio', 'duration', 'resolution', 'seed', 'generate_audio', 'quality', 'complexity'):
                if body.get(key) is not None:
                    params[key] = body[key]
            if kind == 'image':
                payload['num_images'] = body.get('n') or 1
                if refs:
                    payload['image'] = refs
                size = body.get('size') or body.get('image_size')
                if size and size != 'auto':
                    params['size'] = size
                if str(params.get('aspect_ratio', '')).lower() == 'auto':
                    params.pop('aspect_ratio')
                path = '/v1/images/tasks'
            else:
                params['ratio'] = params.pop('aspect_ratio', body.get('ratio') or '16:9')
                input_refs = [{'role': 'first_frame' if index == 0 else 'reference_image', 'url': value}
                              for index, value in enumerate(refs)]
                first_frame = body.get('first_frame_url') or body.get('image_url')
                for role, value in (('first_frame', first_frame), ('last_frame', body.get('last_frame_url'))):
                    if value:
                        input_refs.append({'role': role, 'url': (await self.references(member, [value]))[0]})
                for key, role in (('reference_video_urls', 'reference_video'), ('reference_audio_urls', 'reference_audio')):
                    values = body.get(key) or []
                    if not isinstance(values, list):
                        raise AuthError(422, '参考素材格式无效')
                    input_refs.extend({'role': role, 'url': value} for value in await self.references(member, values))
                explicit = body.get('input_refs') or []
                if not isinstance(explicit, list):
                    raise AuthError(422, '参考素材格式无效')
                for ref in explicit:
                    if not isinstance(ref, dict) or ref.get('role') not in {'first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio', 'image', 'video', 'audio'}:
                        raise AuthError(422, '参考素材用途无效')
                    value = '/api/media/' + quote(ref['asset_id'], safe='') if isinstance(ref.get('asset_id'), str) else ref.get('url')
                    input_refs.append({'role': ref['role'], 'url': (await self.references(member, [value]))[0]})
                if input_refs:
                    payload['input_refs'] = input_refs
                path = '/v1/videos/generate'
            payload.update(params)
        except AuthError as exc:
            raise SubmissionRejected(exc.status, exc.message) from exc
        if route:
            provider, _, config = route
            return self.submit_openai_image(member, payload, submission, source, provider,
                                            profile=config.get('profile'), model_alias=requested)
        if kind == 'image' and model in {OPENAI_IMAGE_MODEL, 'gpt-image-2.6-sunburst'} and self.settings.local_asset:
            gateway = self.governance.gateway_settings(self.settings, bind=True)
            if self.local_openai(gateway):
                return self.submit_openai_image(member, payload, submission, source,
                    {'id': None, 'baseUrl': OPENAI_ORIGIN + '/v1', 'apiKey': gateway.gateway_api_key},
                    profile=self.governance.gateway_model_profiles().get(model), model_alias=model)
        started = time.time()
        data = await self.call(member, 'POST', path, payload=payload,
                               submission=submission)
        task_id = data.get('task_id')
        if not isinstance(task_id, str) or not task_id.strip():
            raise AuthError(502, '平台未返回生成任务编号，受理状态未确认，可能已计费；请核对原请求，勿重复提交')
        with self.lock:
            self.db.execute('INSERT OR IGNORE INTO tasks (id,member,tenant,actor,kind,submission) VALUES (?,?,?,?,?,?)',
                            (task_id, member.member_id, member.tenant_id, member.user_id, kind, submission))
            usage_params = dict(params)
            if kind == 'image':
                usage_params['num_images'] = payload['num_images']
            self.db.execute('INSERT OR IGNORE INTO task_usage (task_id,model,parameters,started,source) VALUES (?,?,?,?,?)',
                            (task_id, model, json.dumps(usage_params), started, source))
            self.db.commit()
        self.governance.record_usage(
            log_id='canvas_' + task_id, member_id=member.member_id, modality=kind,
            model=model, provider_type='internal_gateway', parameters=usage_params,
            source=source, reference_id=task_id, status='pending',
            duration_seconds=float(params.get('duration') or 0) if kind == 'video' else 0)
        return task_id

    def submit_openai_image(self, member, payload, submission, source, provider, *, profile, model_alias):
        if payload.get('image') or payload.get('mask') or payload['num_images'] != 1:
            raise SubmissionRejected(422, '此端点支持纯文本生成一张图片')
        defaults = dict(OPENAI_IMAGE_PRESET) if provider['id'] is None else {'size': '1024x1024', 'n': 1}
        defaults.update(profile or {})
        params = {**defaults, **{key: payload[key] for key in ('size', 'quality', 'complexity')
                                 if payload.get(key) is not None and (key != 'size' or payload[key] != 'auto')}}
        size = params['size']
        if size in ('1K', '1k'):
            size = params['size'] = '1024x1024'
        ratio = payload.get('aspect_ratio')
        if ratio in ('3:2', '2:3') and payload.get('size') in (None, 'auto', '1K', '1k'):
            size = params['size'] = '1536x1024' if ratio == '3:2' else '1024x1536'
        if (size not in IMAGE_SIZES or params.get('quality') not in (None, *IMAGE_QUALITIES)
                or params.get('complexity') not in (None, *IMAGE_COMPLEXITIES)
                or ratio not in (None, '1:1', '3:2', '2:3')):
            raise SubmissionRejected(422, '所选图片尺寸、质量或复杂度不受支持')
        if not provider['apiKey']:
            raise SubmissionRejected(403, '生图供应商尚未配置 Key')
        task_id = OPENAI_IMAGE_PREFIX + uuid.uuid4().hex
        owner = (member.member_id, member.tenant_id, member.user_id)
        started = time.time()
        with self.lock, self.db:
            inserted = self.db.execute(
                'INSERT OR IGNORE INTO tasks (id,member,tenant,actor,kind,submission) VALUES (?,?,?,?,?,?)',
                (task_id, *owner, 'image', submission)).rowcount
            if not inserted:
                return self.db.execute('SELECT id FROM tasks WHERE member=? AND tenant=? AND actor=? AND submission=?',
                                       (*owner, submission)).fetchone()['id']
            self.db.execute("INSERT INTO local_openai_images VALUES (?,?,'submitted',NULL,NULL)", (task_id, started))
            self.db.execute('INSERT INTO task_usage (task_id,model,parameters,started,source) VALUES (?,?,?,?,?)',
                            (task_id, model_alias, json.dumps(params), started, source))
        job = asyncio.create_task(
            self.generate_openai_image(member, provider, task_id, payload['model'], model_alias, payload['prompt'], params, started, source))
        self._openai_image_jobs.add(job)
        job.add_done_callback(self._openai_image_jobs.discard)
        return task_id

    async def generate_openai_image(self, member, provider, task_id, model, model_alias, prompt, params, started, source):
        error = 'OpenAI 未返回可确认的生成结果，可能已计费，请勿重复提交'
        state, image = 'unknown', None
        usage = ModelUsage()
        try:
            async with self.client() as client:
                response = await client.post(provider['baseUrl'] + '/images/generations',
                    headers={'Authorization': 'Bearer ' + provider['apiKey'], 'X-Client-Request-Id': task_id},
                    json={'model': model, 'prompt': prompt, **params, **({'output_format': 'png'} if provider['id'] is None else {})},
                    timeout=OPENAI_IMAGE_TIMEOUT)
            usage.reference_id = response.headers.get('X-Request-ID')
            data = response.json()
            if response.is_success:
                image = base64.b64decode(data['data'][0]['b64_json'], validate=True)
                if image:
                    state, error = 'received', None
                usage.observe(data)
            elif 400 <= response.status_code < 500:
                state = 'rejected'
                error = generation_error_text(data, status=response.status_code, secrets=(provider['apiKey'],))
        except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError, binascii.Error):
            pass
        finally:
            with self.lock, self.db:
                self.db.execute('UPDATE local_openai_images SET state=?,image=?,error=? WHERE task_id=?',
                                (state, image, error, task_id))
        self.governance.record_usage(log_id='canvas_' + task_id, member_id=member.member_id,
            modality='image', model=model_alias, provider_type='external_provider', provider_id=provider['id'], source=source,
            parameters=params, reference_id=usage.reference_id, prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens, total_tokens=usage.total_tokens,
            duration_ms=int((time.time() - started) * 1000),
            status={'received': 'success', 'rejected': 'failed', 'unknown': 'interrupted'}[state])

    async def refresh_openai_image(self, member, task_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM local_openai_images WHERE task_id=?', (task_id,)).fetchone()
        if row['state'] == 'received':
            async def stream():
                yield row['image']
            image = await self.media.upload_runtime(member, stream(), filename=task_id + '.png',
                size=len(row['image']), asset_type='image', mime='image/png',
                operation_id=task_id, operation_target='openai-image')
            return {'status': 'succeeded', 'progress': 100, 'outputs': [image['fileUrl']], 'error': None}
        if row['state'] == 'rejected':
            return {'status': 'failed', 'progress': 0, 'outputs': [], 'error': row['error']}
        if row['state'] == 'unknown' or time.time() - row['started'] > OPENAI_IMAGE_TIMEOUT + 15:
            raise AuthError(502, row['error'] or '原生成任务受理状态未知，可能已计费，请勿重复提交')
        return {'status': 'running', 'progress': 0, 'outputs': [], 'error': None}

    async def chat_messages(self, member, messages, *, responses=False):
        resolved = []
        for message in messages:
            if not isinstance(message, dict) or not isinstance(message.get('content'), list):
                resolved.append(message)
                continue
            content = []
            for part in message['content']:
                if isinstance(part, dict) and part.get('type') == ('input_image' if responses else 'image_url'):
                    image = part.get('image_url')
                    url = image.get('url') if isinstance(image, dict) else image
                    if isinstance(url, str):
                        value = (await self.references(member, [url]))[0]
                        part = {**part, 'image_url': {**image, 'url': value} if isinstance(image, dict) else value}
                content.append(part)
            resolved.append({**message, 'content': content})
        return resolved

    async def poll(self, member, task_id, *, unified=False):
        row = self.task(member, task_id)
        version = row['poll_version']
        waited = False
        while True:
            row = self.task(member, task_id)
            result = json.loads(row['poll_result']) if row['poll_result'] else None
            if waited and row['poll_version'] != version and row['poll_error']:
                raise AuthError(row['poll_error_status'], row['poll_error'])
            if result and (result['status'] in {'succeeded', 'failed', 'cancelled'}
                           or waited and row['poll_version'] != version):
                return self.poll_response(member, row, result, unified=unified)
            token = uuid.uuid4().hex
            with self.lock:
                claimed = self.db.execute(
                    "UPDATE tasks SET poll_token=?,poll_until=? WHERE id=? AND poll_version=? "
                    "AND (poll_token IS NULL OR poll_until<=?)",
                    (token, time.time() + 60, task_id, row['poll_version'], time.time())).rowcount
                self.db.commit()
            if not claimed:
                waited = True
                await asyncio.sleep(.05)
                continue
            heartbeat = asyncio.create_task(self.renew_poll(task_id, token))
            try:
                result = await self.refresh_task(member, row)
                with self.lock:
                    self.db.execute("UPDATE tasks SET poll_result=?,poll_error=NULL,poll_error_status=NULL,"
                                    "poll_version=poll_version+1,poll_token=NULL,poll_until=0 "
                                    "WHERE id=? AND poll_token=?", (json.dumps(result), task_id, token))
                    if task_id.startswith(OPENAI_IMAGE_PREFIX) and result['status'] == 'succeeded':
                        self.db.execute('UPDATE local_openai_images SET image=NULL WHERE task_id=?', (task_id,))
                    self.db.commit()
            except AuthError as exc:
                with self.lock:
                    self.db.execute("UPDATE tasks SET poll_error=?,poll_error_status=?,"
                                    "poll_version=poll_version+1,poll_token=NULL,poll_until=0 "
                                    "WHERE id=? AND poll_token=?", (exc.message, exc.status, task_id, token))
                    self.db.commit()
                raise
            finally:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
                with self.lock:
                    self.db.execute('UPDATE tasks SET poll_token=NULL,poll_until=0 WHERE id=? AND poll_token=?',
                                    (task_id, token))
                    self.db.commit()
            return self.poll_response(member, self.task(member, task_id), result, unified=unified)

    async def renew_poll(self, task_id, token):
        while True:
            await asyncio.sleep(20)
            with self.lock:
                self.db.execute('UPDATE tasks SET poll_until=? WHERE id=? AND poll_token=?',
                                (time.time() + 60, task_id, token))
                self.db.commit()

    async def refresh_task(self, member, row):
        task_id = row['id']
        if task_id.startswith(OPENAI_IMAGE_PREFIX):
            return await self.refresh_openai_image(member, task_id)
        if row['kind'].startswith('runninghub:'):
            data = await self.runninghub_poll(member, row)
            return {'status': {'SUCCESS': 'succeeded', 'FAILED': 'failed', 'RUNNING': 'running'}.get(data['status'], 'pending'),
                    'progress': 100 if data['status'] == 'SUCCESS' else 0, 'outputs': data['urls'],
                    'error': data.get('failReason'), 'runninghub': data}
        data = await self.call(member, 'GET', '/v1/tasks/' + quote(task_id, safe=''))
        status = {'canceled': 'cancelled', 'completed': 'succeeded'}.get(data.get('status'), data.get('status', 'pending'))
        stored_outputs = json.loads(row['outputs'])
        local_development = self.settings.environment == 'development' and self.settings.local_member_id
        if local_development and isinstance(stored_outputs, dict):
            local_assets, outputs = stored_outputs, []
        else:
            outputs = stored_outputs
            local_assets = {unquote(url.removeprefix('/api/media/')): unquote(url.removeprefix('/api/media/'))
                            for url in outputs} if local_development else {}
        archive_pending = False
        if status == 'succeeded':
            asset_ids = data.get('output_asset_ids') or []
            if not asset_ids and not outputs:
                # Archive jobs can trail completion. Query the original task again.
                status, archive_pending = 'pending', True
            for index, asset_id in enumerate(asset_ids):
                if local_development:
                    local_asset_id = local_assets.get(asset_id)
                    if not local_asset_id:
                        result = next((item for item in data.get('results', [])
                                       if isinstance(item, dict) and item.get('asset_id') == asset_id and item.get('url')), None)
                        if result is None:
                            status, archive_pending = 'pending', True
                            break
                        asset_kind = 'audio' if row['kind'] == 'music' else row['kind']
                        extension = 'png' if asset_kind == 'image' else 'mp4'
                        if asset_kind == 'audio':
                            suffix = Path(urlsplit(result['url']).path).suffix.lstrip('.').lower()
                            extension = suffix if suffix in {'wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a'} else 'bin'
                        imported = await self.archive_runninghub_output(
                            member, result['url'], f'gateway_{index}.{extension}', asset_type=asset_kind, source='平台')
                        local_asset_id = imported['assetId']
                        local_assets[asset_id] = local_asset_id
                        with self.lock:
                            self.db.execute('UPDATE tasks SET outputs=? WHERE id=?', (json.dumps(local_assets), task_id))
                            self.db.commit()
                    metadata = await self.media.register_generated(member, local_asset_id, 'audio' if row['kind'] == 'music' else row['kind'])
                else:
                    url = '/api/media/' + quote(asset_id, safe='')
                    if url in outputs:
                        continue
                    metadata = await self.media.register_generated(member, asset_id, 'audio' if row['kind'] == 'music' else row['kind'])
                if metadata['fileUrl'] not in outputs:
                    outputs.append(metadata['fileUrl'])
                if not local_development:
                    with self.lock:
                        self.db.execute('UPDATE tasks SET outputs=? WHERE id=?', (json.dumps(outputs), task_id))
                        self.db.commit()
        if status in {'succeeded', 'failed', 'cancelled'}:
            with self.lock:
                usage = self.db.execute('SELECT * FROM task_usage WHERE task_id=?', (task_id,)).fetchone()
            if usage is not None:
                parameters = json.loads(usage['parameters'])
                self.governance.record_usage(
                    log_id='canvas_' + task_id, member_id=member.member_id, modality=row['kind'],
                    model=usage['model'], provider_type='internal_gateway', parameters=parameters,
                    source='huobao' if ':huobao:' in row['submission'] else usage['source'],
                    reference_id=task_id, status='success' if status == 'succeeded' else status,
                    duration_seconds=float(data.get('duration_seconds') or parameters.get('duration') or 0)
                        if row['kind'] == 'video' else 0,
                    duration_ms=int((time.time() - usage['started']) * 1000))
                self.governance.schedule_gateway_charge_refresh(self.settings, transport=self.transport,
                                                                log_id='canvas_' + task_id)
        progress = float(data.get('progress') or 0)
        error = generation_error_text(data, secrets=(self.governance.gateway_settings(self.settings).gateway_api_key, self.settings.staging_gateway_token))
        if status == 'cancelled' and error == '服务商未返回具体失败原因':
            error = '生成任务已取消'
        return {'status': status, 'progress': min(100, max(0, round(progress * (100 if progress <= 1 else 1)))),
                'outputs': outputs, 'error': error if status in {'failed', 'cancelled'} else None,
                'archivePending': archive_pending}

    def poll_response(self, member, row, result, *, unified):
        status, outputs, error = result['status'], result['outputs'], result['error']
        if unified:
            archived = []
            for url in outputs:
                asset_id = unquote(url.removeprefix('/api/media/'))
                metadata = self.media.store.get(asset_id)
                if metadata['owner_id'] != member.member_id:
                    raise AuthError(403, '生成产物不属于当前成员')
                archived.append({'url': url, 'mimeType': metadata['mime'], 'assetId': asset_id})
            return {'taskId': row['id'], 'kind': 'video' if row['kind'].startswith('runninghub:') else row['kind'],
                    'status': status if status in {'pending', 'running', 'succeeded', 'failed', 'cancelled'} else 'pending',
                    'progress': result['progress'], 'outputs': archived, 'error': error}
        if 'runninghub' in result:
            return result['runninghub']
        if result.get('archivePending'):
            raise AuthError(502, '生成已结束，但平台尚未归档产物，请稍后重试')
        progress_text = str(result['progress']) + '%'
        if row['kind'] == 'image':
            return {'status': {'succeeded': 'completed', 'cancelled': 'failed'}.get(status, status),
                    'progress': progress_text, 'urls': outputs, 'error': error}
        return {'status': {'succeeded': 'SUCCESS', 'failed': 'FAILURE', 'cancelled': 'FAILURE',
                           'running': 'RUNNING'}.get(status, 'PENDING'), 'progress': progress_text,
                'videoUrl': outputs[0] if outputs else None, 'failReason': error}

    def runninghub_providers(self, site, provider_id=None):
        origin = RUNNINGHUB_ORIGINS.get(site)
        if not origin:
            return []
        if provider_id is not None:
            key_rec = self.governance.get_runninghub_key(provider_id, include_key=True)
            if key_rec and key_rec['site'] == site and key_rec['apiKey']:
                return [{
                    'id': key_rec['id'],
                    'apiKey': key_rec['apiKey'],
                    'baseUrl': origin,
                    'isActive': key_rec['isActive'],
                    'site': site,
                }]
            prov = self.governance.get_provider(provider_id, include_key=True)
            if prov and prov['isActive'] and prov['apiKey']:
                parsed = urlsplit(prov['baseUrl'])
                if (parsed.scheme == 'https' and parsed.netloc == urlsplit(origin).netloc
                        and parsed.path.rstrip('/') in {'', '/openapi/v2'}
                        and not parsed.query and not parsed.fragment):
                    return [prov]
            return []

        candidates = self.governance.get_candidate_runninghub_keys(site)
        if candidates:
            return [
                {
                    'id': c['id'],
                    'apiKey': c['apiKey'],
                    'baseUrl': origin,
                    'isActive': c['isActive'],
                    'site': site,
                }
                for c in candidates
            ]

        legacy = []
        for provider in self.governance.list_providers(include_key=True):
            parsed = urlsplit(provider['baseUrl'])
            if (provider['isActive'] and provider['apiKey'] and parsed.scheme == 'https'
                    and parsed.netloc == urlsplit(origin).netloc
                    and parsed.path.rstrip('/') in {'', '/openapi/v2'}
                    and not parsed.query and not parsed.fragment):
                legacy.append(provider)
        return legacy

    def runninghub_provider(self, site, provider_id=None, *, required=True):
        origin = RUNNINGHUB_ORIGINS.get(site)
        if not origin:
            raise AuthError(503, 'RH Upscale 服务配置无效，请联系管理员')
        providers = self.runninghub_providers(site, provider_id)
        if providers:
            return providers[0]
        if required:
            raise AuthError(503, 'RH Upscale 尚未配置有效凭据，请联系管理员')
        return None

    async def runninghub_call(self, site, provider, path, *, payload=None, files=None):
        try:
            async with self.client('runninghub') as client:
                response = await client.post(RUNNINGHUB_ORIGINS[site] + path,
                    headers={'Authorization': 'Bearer ' + provider['apiKey']}, json=payload, files=files)
        except httpx.TimeoutException as exc:
            raise AuthError(504, 'RunningHub 生成服务请求超时') from exc
        except httpx.HTTPError as exc:
            raise AuthError(502, '无法连接 RunningHub 生成服务') from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise AuthError(response.status_code if not response.is_success else 502,
                            f'RunningHub 返回非 JSON 响应 (HTTP {response.status_code})') from exc
        if not isinstance(data, dict):
            raise AuthError(502, 'RunningHub 返回格式异常')
        if path == '/openapi/v2/rhart-video/rh-upscale/enhance-frame':
            if isinstance(data.get('taskId'), str) and data['taskId']:
                return data
            if response.status_code not in {401, 403} and str(data.get('errorCode') or data.get('code') or '') in {'416', '812'}:
                return data
        if (not response.is_success or data.get('code') not in (None, 0, '0')
                or (data.get('errorCode') not in (None, '', 0, '0') and data.get('status') != 'FAILED')):
            raise AuthError(response.status_code if not response.is_success else 502,
                            generation_error_text(data, status=response.status_code, secrets=(provider['apiKey'],)))
        return data

    async def runninghub_upload(self, site, provider, content, filename):
        data = await self.runninghub_call(site, provider, '/openapi/v2/media/upload/binary',
                                        files={'file': (filename, content, 'video/mp4')})
        url = (data.get('data') or {}).get('download_url')
        if data.get('code') not in (0, '0') or not isinstance(url, str) or not url:
            raise AuthError(502, 'RunningHub 上传未完成，请稍后重试')
        return url

    async def runninghub_submit(self, member, request, submission):
        content = None
        filename = 'input.mp4'
        if request.headers.get('content-type', '').split(';')[0] == 'application/json':
            body = await request.json()
        else:
            body = dict(request.query_params)
            filename = unquote(request.headers.get('x-file-name', filename))
            if not filename.lower().endswith('.mp4') or any(c in filename for c in ('/', '\\', '\r', '\n', '\x00')):
                raise AuthError(422, 'RH Upscale 仅支持 MP4 视频')
            content = bytearray()
            async for chunk in request.stream():
                content.extend(chunk)
                if len(content) > 100 * 1024 * 1024:
                    raise AuthError(413, 'RH Upscale 输入视频不能超过 100 MB')
            if not content:
                raise AuthError(422, '请选择 MP4 视频')
            content = bytes(content)
        if not isinstance(body, dict):
            raise AuthError(422, 'RH Upscale 请求格式无效')
        file_url = body.get('fileUrl')
        if isinstance(file_url, str) and (file_url.startswith('/api/media/') or urlsplit(file_url).netloc == '127.0.0.1:3081'):
            file_url = (await self.references(member, [file_url]))[0]
        parsed = urlsplit(file_url) if isinstance(file_url, str) else None
        if content is None and (not parsed or parsed.scheme != 'https' or not parsed.netloc):
            raise AuthError(422, '请提供 MP4 视频地址')
        params = {'model': body.get('model', 'max'), 'resolution': body.get('resolution', '1080p'),
                  'outputFps': body.get('outputFps', '1x')}
        if (params['model'] not in {'max', 'high', 'medium', 'low'}
                or params['resolution'] not in {'720p', '1080p', '2k', '4k'}
                or params['outputFps'] not in RUNNINGHUB_OUTPUT_FPS):
            raise AuthError(422, 'RH Upscale 参数无效')
        submission = 'runninghub:' + (submission or str(uuid.uuid4()))
        async with self.runninghub_submission_lock:
            with self.lock:
                existing = self.db.execute('SELECT id,kind FROM tasks WHERE member=? AND tenant=? AND actor=? AND submission=?',
                    (member.member_id, member.tenant_id, member.user_id, submission)).fetchone()
            if existing:
                return {'taskId': existing['id'], 'site': existing['kind'].split(':', 1)[1]}
            configured = False
            uploaded_urls = {}
            for site in ('intl', 'cn'):
                candidates = self.runninghub_providers(site)
                if not candidates:
                    continue
                configured = True
                for provider in candidates:
                    account = await self.runninghub_call(site, provider, '/uc/openapi/accountStatus',
                                                         payload={'apikey': provider['apiKey']})
                    account_data = account.get('data') or {}
                    remain_money_raw = account_data.get('remainMoney')
                    remain_coins_raw = account_data.get('remainCoins') or account_data.get('coins')

                    has_balance = False
                    if remain_money_raw is not None:
                        try:
                            money_val = Decimal(str(remain_money_raw))
                            if not money_val.is_finite():
                                raise InvalidOperation
                            if money_val > 0:
                                has_balance = True
                        except InvalidOperation as exc:
                            raise AuthError(502, 'RH Upscale 余额暂不可查询，请稍后重试') from exc
                    elif remain_coins_raw is not None:
                        try:
                            coins_val = Decimal(str(remain_coins_raw))
                            if coins_val > 0:
                                has_balance = True
                        except (InvalidOperation, TypeError):
                            pass

                    if not has_balance:
                        self.governance.mark_runninghub_key_exhausted(provider['id'])
                        continue

                    if site not in uploaded_urls:
                        uploaded_urls[site] = await self.runninghub_upload(site, provider, content, filename) if content is not None else file_url
                    selected_url = uploaded_urls[site]

                    started = time.time()
                    data = await self.runninghub_call(site, provider, '/openapi/v2/rhart-video/rh-upscale/enhance-frame',
                                                     payload={'fileUrl': selected_url, **params})
                    upstream_task_id = data.get('taskId')
                    if not upstream_task_id and str(data.get('errorCode') or data.get('code') or '') in {'416', '812'}:
                        self.governance.mark_runninghub_key_exhausted(provider['id'])
                        continue
                    if not isinstance(upstream_task_id, str) or not upstream_task_id:
                        raise AuthError(502, 'RH Upscale 未返回任务编号，请联系管理员确认提交结果')
                    task_id = 'grh_' + uuid.uuid4().hex
                    stored = {**params, 'site': site, 'providerId': provider['id'], 'upstreamTaskId': upstream_task_id}
                    with self.lock:
                        self.db.execute('INSERT INTO tasks (id,member,tenant,actor,kind,submission) VALUES (?,?,?,?,?,?)',
                            (task_id, member.member_id, member.tenant_id, member.user_id, 'runninghub:' + site, submission))
                        self.db.execute('INSERT INTO task_usage (task_id,model,parameters,started) VALUES (?,?,?,?)',
                            (task_id, 'rh-upscale', json.dumps(stored), started))
                        self.db.commit()
                    self.governance.advance_runninghub_cursor(site)
                    return {'taskId': task_id, 'site': site}
            raise AuthError(503, 'RH Upscale 余额不足，请联系管理员充值' if configured else 'RH Upscale 尚未配置有效凭据，请联系管理员')

    async def archive_runninghub_output(self, member, url, filename, *, asset_type='video', source='RH Upscale'):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise AuthError(502, f'{source} 返回的产物地址无效')
        async with self.client('archive') as client:
            async with client.stream('GET', url) as response:
                if not response.is_success:
                    raise AuthError(502, f'{source} 产物暂不可读取 (HTTP {response.status_code})')
                mime = response.headers.get('content-type', 'video/mp4' if asset_type == 'video' else 'image/png').split(';')[0]
                try:
                    size = int(response.headers.get('content-length', ''))
                except ValueError:
                    size = 0
                if size > 0:
                    return await self.media.upload_runtime(member, response.aiter_bytes(), filename=filename,
                                                           size=size, asset_type=asset_type, mime=mime)
                # Some RH CDNs omit length. Stage that single output once, then
                # stream the same file to Asset; never retain a finished copy.
                with tempfile.TemporaryDirectory(prefix='rh-archive-', dir=self.settings.data_dir) as directory:
                    path = Path(directory) / filename
                    with path.open('wb') as file:
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > 512 * 1024 * 1024:
                                raise AuthError(413, '生成产物超出 512 MiB 归档限制')
                            stats = os.statvfs(directory)
                            if stats.f_bavail * stats.f_frsize - len(chunk) < 5 * 1024 ** 3:
                                raise AuthError(507, '归档临时空间不足，需保留 5 GiB 运行余量')
                            file.write(chunk)
                    async def content():
                        with path.open('rb') as file:
                            while chunk := file.read(256 * 1024):
                                yield chunk
                    return await self.media.upload_runtime(member, content(), filename=filename,
                                                           size=size, asset_type=asset_type, mime=mime)

    async def runninghub_poll(self, member, row):
        site = row['kind'].split(':', 1)[1]
        with self.lock:
            usage = self.db.execute('SELECT parameters FROM task_usage WHERE task_id=?', (row['id'],)).fetchone()
        params = json.loads(usage['parameters'])
        if params.get('outputsArchived'):
            return {'status': 'SUCCESS', 'site': site, 'urls': json.loads(row['outputs']), 'code': 0, 'failReason': None}
        provider = self.runninghub_provider(site, params['providerId'])
        data = await self.runninghub_call(site, provider, '/openapi/v2/query', payload={'taskId': params['upstreamTaskId']})
        status = data.get('status', 'QUEUED')
        reason = generation_error_text(data, secrets=(provider['apiKey'],)) if status == 'FAILED' else None
        outputs = []
        if status == 'SUCCESS':
            remote_urls = [item['url'] for item in data.get('results', []) if isinstance(item, dict) and item.get('url')]
            if not remote_urls:
                raise AuthError(502, 'RH Upscale 已生成，但服务商尚未返回视频产物')
            async with self.archive_lock:
                outputs = json.loads(self.task(member, row['id'])['outputs'])
                for index, url in enumerate(remote_urls):
                    if index < len(outputs):
                        continue
                    try:
                        metadata = await self.archive_runninghub_output(member, url, f"rh_upscale_{row['id']}_{index}.mp4")
                    except (AuthError, httpx.HTTPError) as exc:
                        detail = exc.message if isinstance(exc, AuthError) else generation_error_text(str(exc))
                        raise AuthError(exc.status if isinstance(exc, AuthError) else 502,
                                        'RH Upscale 已生成，产物归档未完成；保留原任务继续查询：' + detail) from exc
                    outputs.append(metadata['fileUrl'])
                    with self.lock:
                        self.db.execute('UPDATE tasks SET outputs=? WHERE id=?', (json.dumps(outputs), row['id']))
                        self.db.commit()
                params['outputsArchived'] = True
                with self.lock:
                    self.db.execute('UPDATE task_usage SET parameters=? WHERE task_id=?', (json.dumps(params), row['id']))
                    self.db.commit()
        return {'status': status, 'site': site,
                'urls': outputs,
                'code': {'SUCCESS': 0, 'RUNNING': 804, 'QUEUED': 813, 'FAILED': 805}.get(status),
                'failReason': reason}

    async def chat(self, member, body):
        if not isinstance(body, dict):
            raise AuthError(422, '对话请求格式无效')
        requested = body.get('model')
        route = resolve_provider(self.governance, 'llm', requested, 't8')
        if not route:
            await self.resolve_submission_model(member, 'llm', requested)
        messages = body.get('messages')
        if not isinstance(messages, list):
            raise AuthError(422, '对话消息格式无效')
        payload = {k: body[k] for k in ('model', 'messages', 'temperature', 'max_tokens', 'stream') if k in body}
        payload['messages'] = await self.chat_messages(member, messages)
        provider, model, model_config = route or (None, requested, {})
        responses = model_config.get('protocol') == 'openai-responses'
        payload['model'] = model
        if responses:
            payload = chat_to_responses(payload)
        gateway = self.governance.gateway_settings(self.settings, bind=True) if not provider else None
        profile = model_config.get('profile', {}) if provider else self.governance.gateway_model_profiles().get(requested, {})
        text_reasoning(payload, profile, responses)
        url = provider['baseUrl'] + ('/responses' if responses else '/chat/completions') if provider else gateway.gateway_service_url + '/v1/chat/completions'
        headers = {'Authorization': 'Bearer ' + provider['apiKey']} if provider else self.headers(member, asset_scope=False, gateway=gateway)
        started = time.time()
        usage = ModelUsage()

        async def record(status):
            log_id = self.governance.record_usage(
                log_id='chat_' + usage.reference_id if usage.reference_id else None,
                member_id=member.member_id, modality='llm', model=requested,
                provider_type='external_provider' if provider else 'internal_gateway',
                provider_id=provider['id'] if provider else None, source='t8', reference_id=usage.reference_id,
                prompt_tokens=usage.prompt_tokens, completion_tokens=usage.completion_tokens,
                total_tokens=usage.total_tokens, status=status,
                duration_ms=int((time.time() - started) * 1000))
            if not provider:
                self.governance.schedule_gateway_charge_refresh(self.settings, transport=self.transport, log_id=log_id)

        if not payload.get('stream'):
            if provider:
                async with self.client() as client:
                    response = await client.post(url, headers=headers, json=payload)
                data = response.json()
                if not response.is_success:
                    await record('failed')
                    raise AuthError(response.status_code, generation_error_text(data, status=response.status_code,
                                                                                 secrets=(provider['apiKey'],)))
                usage.reference_id = response.headers.get('X-Request-ID')
                usage.observe(data)
                if responses:
                    data = response_as_chat(data)
            else:
                data = await self.call(member, 'POST', '/v1/chat/completions', payload=payload, usage=usage)
            await record('success')
            choice = data['choices'][0]
            return {'content': choice['message'].get('content', ''), 'model': data.get('model'),
                    'usage': data.get('usage'), 'finishReason': choice.get('finish_reason'), 'raw': data}
        if not provider:
            payload['stream_options'] = {'include_usage': True}
        session = self.client()
        client = await session.__aenter__()
        try:
            response = await client.send(client.build_request('POST', url, headers=headers, json=payload), stream=True)
        except httpx.HTTPError as exc:
            await session.__aexit__(None, None, None)
            raise AuthError(502, '平台对话连接失败') from exc
        if not response.is_success:
            await response.aclose()
            await session.__aexit__(None, None, None)
            raise AuthError(response.status_code, '平台对话请求失败')
        usage.reference_id = response.headers.get('X-Request-ID')
        async def chunks():
            task = asyncio.current_task()
            self.edge.connections.setdefault(member.access_token, set()).add(task)
            async def revalidate():
                while True:
                    await asyncio.sleep(25)
                    try:
                        await self.edge.auth.verify(member.access_token)
                    except AuthError:
                        task.cancel()
                        return
            validator = asyncio.create_task(revalidate())
            completed = False
            try:
                if responses:
                    async for line in response.aiter_lines():
                        usage.feed((line + '\n').encode())
                        if line.startswith('data:'):
                            try:
                                event = json.loads(line[5:])
                            except ValueError:
                                continue
                            choice = response_event_as_chat(event, requested)
                            if choice:
                                yield b'data: ' + json.dumps(choice).encode() + b'\n\n'
                    if usage.stream_complete:
                        yield b'data: [DONE]\n\n'
                else:
                    async for chunk in response.aiter_raw():
                        usage.feed(chunk)
                        yield chunk
                completed = not responses or usage.stream_complete
            finally:
                validator.cancel()
                await asyncio.gather(validator, return_exceptions=True)
                self.edge.connections.get(member.access_token, set()).discard(task)
                await response.aclose()
                await session.__aexit__(None, None, None)
                await record('success' if completed else 'interrupted')
        return StreamingResponse(chunks(), media_type='text/event-stream',
                                 headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


def canvas_router(service):
    router = APIRouter(prefix='/canvas/api')

    async def invoke(operation):
        try:
            result = await operation
            if isinstance(result, StreamingResponse):
                return result
            return JSONResponse({'success': True, 'data': result}, headers={'Cache-Control': 'no-store'})
        except AuthError as exc:
            return JSONResponse({'success': False, 'error': exc.message}, status_code=exc.status,
                                headers={'Cache-Control': 'no-store'})

    @router.get('/greenroom/models')
    async def models():
        return await invoke(service.models(current_member.get(), 't8'))

    @router.get('/greenroom/huobao-models')
    async def huobao_models():
        return await invoke(service.huobao_models(current_member.get()))

    @router.get('/greenroom/tasks/{task_id}')
    async def task(task_id: str):
        return await invoke(service.poll(current_member.get(), task_id, unified=True))

    @router.post('/greenroom/runninghub/submit')
    async def runninghub_submit(request: Request):
        return await invoke(service.runninghub_submit(current_member.get(), request,
                            request.headers.get('x-t8-provider-submission')))

    @router.get('/greenroom/settings')
    async def settings():
        data = service.governance.get_canvas_settings()
        return JSONResponse({'success': True, 'data': {
            'uiFontPreset': data['uiFontPreset'], 'customUiFont': data['customUiFont'],
        }}, headers={'Cache-Control': 'no-store'})

    @router.post('/proxy/llm')
    async def chat(request: Request):
        return await invoke(service.chat(current_member.get(), await request.json()))

    @router.post('/proxy/image/submit')
    async def image(request: Request):
        async def submit():
            task_id = await service.submit(current_member.get(), 'image', await request.json(),
                                           request.headers.get('x-t8-provider-submission'))
            return {'sync': False, 'taskId': task_id, 'kind': 'image', 'status': 'pending', 'progress': '0%'}
        return await invoke(submit())

    @router.get('/proxy/image/status/{task_id}')
    async def image_status(task_id: str):
        return await invoke(service.poll(current_member.get(), task_id))

    @router.post('/proxy/video/submit')
    async def video(request: Request):
        async def submit():
            task_id = await service.submit(current_member.get(), 'video', await request.json(),
                                           request.headers.get('x-t8-provider-submission'))
            return {'taskId': task_id, 'kind': 'video', 'status': 'pending'}
        return await invoke(submit())

    @router.get('/proxy/video/query')
    async def video_status(taskId: str):
        return await invoke(service.poll(current_member.get(), taskId))

    return router
