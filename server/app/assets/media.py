"""Private, server-owned upload records and authenticated durable media URLs."""
from __future__ import annotations

import asyncio
import fcntl
import re
import hashlib
import json
import os
import sqlite3
import tempfile
import subprocess
import threading
from contextlib import asynccontextmanager
from http.cookiejar import CookieJar, DefaultCookiePolicy
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from PIL import Image

from app.identity.auth import AuthError, current_member
from app.assets.scopes import personal_scope, public_scope, scope_headers, scope_query


def inert_mime(path: Path) -> str:
    # Decoders validate bytes, not the client-provided filename/MIME.
    try:
        with Image.open(path) as image:
            kind = image.format
            image.verify()
        return {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp"}.get(kind, "application/octet-stream")
    except (OSError, ValueError, Image.DecompressionBombError):
        pass
    try:
        probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp3,wav,ogg,flac,matroska,webm', '-show_entries', 'format=format_name:stream=codec_type', '-of', 'json', str(path)], capture_output=True, timeout=10, check=True)
        data = json.loads(probe.stdout)
        format_name = data.get('format', {}).get('format_name', '')
        types = {stream.get('codec_type') for stream in data.get('streams', [])}
        if 'mov' in format_name or 'mp4' in format_name: return 'video/mp4' if 'video' in types else 'audio/mp4'
        if format_name == 'mp3': return 'audio/mpeg'
        if format_name == 'wav': return 'audio/wav'
        if format_name == 'ogg': return 'audio/ogg'
        if format_name == 'flac': return 'audio/flac'
        if 'webm' in format_name: return 'video/webm' if 'video' in types else 'audio/webm'
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return "application/octet-stream"


class MediaStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("CREATE TABLE IF NOT EXISTS media (asset_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, upload_id TEXT NOT NULL, state TEXT NOT NULL, placement TEXT NOT NULL DEFAULT 'private', desired TEXT NOT NULL DEFAULT 'private')")
        self.db.execute("CREATE TABLE IF NOT EXISTS runtime_archives (owner_id TEXT NOT NULL, scope TEXT NOT NULL, archive_key TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, asset_type TEXT NOT NULL, content_sha256 TEXT NOT NULL, asset_id TEXT, upload_id TEXT, phase TEXT NOT NULL, PRIMARY KEY(owner_id,scope,archive_key))")
        self.db.execute("""CREATE TABLE IF NOT EXISTS media_upload_operations (
            member_id TEXT NOT NULL, scope TEXT NOT NULL, operation_id TEXT NOT NULL,
            target TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
            mime TEXT NOT NULL, asset_type TEXT NOT NULL, state TEXT NOT NULL,
            upload_id TEXT, asset_id TEXT, PRIMARY KEY(member_id,scope,operation_id))""")
        self.archive_lock_path = path.with_suffix('.archive.lock')
        self.db.commit()

    @asynccontextmanager
    async def archive_lock(self):
        # Separate open descriptions also serialize different service instances in
        # this process. OS releases the lock on process death; no stale leases.
        with self.archive_lock_path.open('a') as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(.05)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def archive_intent(self, identity, filename, size, mime, asset_type, content_sha256):
        with self.lock:
            row = self.db.execute("SELECT * FROM runtime_archives WHERE owner_id=? AND scope=? AND archive_key=?", identity).fetchone()
            if row is not None:
                row = dict(row)
                if (row['filename'], row['size'], row['mime'], row['asset_type'], row['content_sha256']) != (filename, size, mime, asset_type, content_sha256):
                    raise AuthError(409, '归档键已绑定其它文件内容或元数据')
                return row
            self.db.execute("INSERT INTO runtime_archives (owner_id,scope,archive_key,filename,size,mime,asset_type,content_sha256,phase) VALUES (?,?,?,?,?,?,?,?,'initializing')", (*identity, filename, size, mime, asset_type, content_sha256))
            self.db.commit()  # Before upload-init: an unknown outcome cannot re-init.
            return None

    def archive_reserved(self, identity, asset_id, upload_id, filename, size, mime, content_sha256):
        with self.lock, self.db:
            self.db.execute("INSERT INTO media (asset_id,owner_id,scope,filename,size,mime,sha256,upload_id,state) VALUES (?,?,?,?,?,?,?,?,'uploading')", (asset_id, identity[0], identity[1], filename, size, mime, content_sha256, upload_id))
            self.db.execute("UPDATE runtime_archives SET asset_id=?,upload_id=?,phase='reserved' WHERE owner_id=? AND scope=? AND archive_key=?", (asset_id, upload_id, *identity))

    def archive_phase(self, identity, phase, asset_id):
        with self.lock, self.db:
            self.db.execute("UPDATE runtime_archives SET phase=? WHERE owner_id=? AND scope=? AND archive_key=?", (phase, *identity))
            if phase == 'ready':
                self.db.execute("UPDATE media SET state='ready' WHERE asset_id=?", (asset_id,))

    def add(self, asset_id, owner_id, scope, filename, size, mime, checksum, upload_id):
        with self.lock:
            self.db.execute("INSERT INTO media (asset_id,owner_id,scope,filename,size,mime,sha256,upload_id,state) VALUES (?,?,?,?,?,?,?,?, 'uploading')", (asset_id, owner_id, json.dumps(scope), filename, size, mime, checksum, upload_id))
            self.db.commit()

    def get(self, asset_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM media WHERE asset_id=?", (asset_id,)).fetchone()
        if row is None:
            raise AuthError(404, "媒体不存在或尚未登记")
        data = dict(row)
        data['scope'] = json.loads(data['scope'])
        return data

    def update(self, asset_id, *, state=None, desired=None, placement=None):
        updates = {k: v for k, v in {'state': state, 'desired': desired, 'placement': placement}.items() if v is not None}
        with self.lock:
            self.db.execute('UPDATE media SET '+ ','.join(k+'=?' for k in updates) +' WHERE asset_id=?', (*updates.values(), asset_id))
            self.db.commit()

    def pending(self):
        with self.lock:
            return [row['asset_id'] for row in self.db.execute("SELECT asset_id FROM media WHERE state='ready' AND placement!=desired").fetchall()]

    @staticmethod
    def _operation_scope(scope):
        return json.dumps(scope, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

    def begin_upload_operation(self, member_id, scope, operation_id, target, filename, size, mime, asset_type):
        scope_key = self._operation_scope(scope)
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                row = self.db.execute('SELECT * FROM media_upload_operations WHERE member_id=? AND scope=? AND operation_id=?',
                                      (member_id, scope_key, operation_id)).fetchone()
                created = row is None
                if created:
                    self.db.execute('INSERT INTO media_upload_operations '
                                    '(member_id,scope,operation_id,target,filename,size,mime,asset_type,state) '
                                    "VALUES (?,?,?,?,?,?,?,?,'init_unknown')",
                                    (member_id, scope_key, operation_id, target, filename, size, mime, asset_type))
                    row = self.db.execute('SELECT * FROM media_upload_operations WHERE member_id=? AND scope=? AND operation_id=?',
                                          (member_id, scope_key, operation_id)).fetchone()
                elif (row['target'], row['filename'], row['size'], row['mime'], row['asset_type']) != (target, filename, size, mime, asset_type):
                    raise AuthError(409, '归档操作标识已绑定其他目标或文件')
                self.db.commit()
                return dict(row), created
            except BaseException:
                self.db.rollback()
                raise

    def get_upload_operation(self, member_id, scope, operation_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM media_upload_operations WHERE member_id=? AND scope=? AND operation_id=?',
                                  (member_id, self._operation_scope(scope), operation_id)).fetchone()
        if row is None:
            raise AuthError(404, '归档操作不存在')
        return dict(row)

    def save_upload_session(self, operation, upload_id, asset_id):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                self.db.execute("INSERT INTO media (asset_id,owner_id,scope,filename,size,mime,sha256,upload_id,state) "
                                "VALUES (?,?,?,?,?,?,'',?,'uploading')",
                                (asset_id, operation['member_id'], operation['scope'], operation['filename'],
                                 operation['size'], operation['mime'], upload_id))
                changed = self.db.execute("UPDATE media_upload_operations SET upload_id=?,asset_id=?,state='initialized' "
                                          "WHERE member_id=? AND scope=? AND operation_id=? AND state='init_unknown'",
                                          (upload_id, asset_id, operation['member_id'], operation['scope'], operation['operation_id']))
                if changed.rowcount != 1:
                    raise AuthError(409, '归档操作状态已变化')
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def transition_upload_operation(self, operation, before, after):
        with self.lock:
            try:
                changed = self.db.execute('UPDATE media_upload_operations SET state=? '
                                          'WHERE member_id=? AND scope=? AND operation_id=? AND state=?',
                                          (after, operation['member_id'], operation['scope'], operation['operation_id'], before))
                self.db.commit()
                return changed.rowcount == 1
            except BaseException:
                self.db.rollback()
                raise

    def complete_upload_operation(self, operation):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                changed = self.db.execute("UPDATE media_upload_operations SET state='ready' "
                                          "WHERE member_id=? AND scope=? AND operation_id=? AND state='put_complete' "
                                          "AND asset_id=? AND upload_id=?",
                                          (operation['member_id'], operation['scope'], operation['operation_id'],
                                           operation['asset_id'], operation['upload_id']))
                if changed.rowcount != 1:
                    raise AuthError(409, '归档操作状态已变化')
                updated = self.db.execute("UPDATE media SET state='ready' WHERE asset_id=? AND upload_id=?",
                                          (operation['asset_id'], operation['upload_id']))
                if updated.rowcount != 1:
                    raise AuthError(409, '归档媒体登记已变化')
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise


class MediaService:
    def __init__(self, settings, spaces, *, transport=None):
        self.settings, self.spaces, self.transport = settings, spaces, transport
        self.store = MediaStore(Path(settings.data_dir) / 'media.sqlite3')
        self.operation_lock = asyncio.Lock()
        self._clients = {}
        self._started = False
        self._client_loop = None

    async def start(self):
        self._started = True
        self._client_loop = asyncio.get_running_loop()

    async def aclose(self):
        self._started = False
        self._client_loop = None
        clients, self._clients = list(self._clients.values()), {}
        await asyncio.gather(*(client.aclose() for client in clients))

    @asynccontextmanager
    async def client(self, *, timeout=60):
        pooled = self._started and self._client_loop is asyncio.get_running_loop()
        client = self._clients.get(timeout) if pooled else None
        owned = client is None and not pooled
        if client is None:
            client = httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False,
                                      limits=httpx.Limits(max_connections=100, max_keepalive_connections=8),
                                      transport=self.transport, cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=())))
            if pooled:
                self._clients[timeout] = client
        try:
            yield client
        finally:
            if owned:
                await client.aclose()

    async def call(self, method, path, scope, payload=None):
        if not self.settings.asset_service_url:
            raise AuthError(503, '资产服务尚未配置')
        headers = scope_headers(scope)
        if self.settings.staging_asset_token:
            headers['X-GREENROOM-Staging-Token'] = self.settings.staging_asset_token
        try:
            async with self.client() as client:
                response = await client.request(method, self.settings.asset_service_url + path, params=scope_query(scope), headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise AuthError(502, '资产服务暂不可用') from exc
        if response.status_code not in range(200, 300):
            raise AuthError(502, '资产服务操作未完成，请重试')
        try:
            data = response.json() if response.content else {}
        except ValueError as exc:
            raise AuthError(502, '资产服务返回格式异常') from exc
        if not isinstance(data, dict):
            raise AuthError(502, '资产服务返回格式异常')
        return data

    def object_url(self, url):
        parsed = urlsplit(url)
        if self.settings.local_asset:
            # Plain HTTP is only for the explicitly configured private local
            # service. Do not loosen the production HTTPS/host restrictions.
            base = urlsplit(self.settings.asset_service_url)
            if (parsed.scheme != base.scheme or parsed.netloc != base.netloc or parsed.query or parsed.fragment
                    or not re.fullmatch(r'/objects/(?:upload|read)/[0-9a-f-]{36}', parsed.path)
                    or url != self.settings.asset_service_url + parsed.path):
                raise AuthError(502, '本地素材地址不属于当前服务')
            return url
        if parsed.scheme != 'https' or parsed.hostname not in self.settings.object_hosts or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            raise AuthError(502, '对象存储地址不在允许范围内')
        return url

    async def upload_runtime(self, member, stream, *, filename, size, asset_type, mime, archive_key=None, content_sha256=None,
                             operation_id=None, operation_target=None):
        """Archive a known-size runtime stream without making another local copy."""
        if not filename or len(filename) > 240 or any(x in filename for x in ('\r', '\n', '\x00', '/', '\\')):
            raise AuthError(422, '文件名无效')
        if asset_type not in {'image', 'audio', 'video', 'document'}:
            raise AuthError(422, '文件类型无效')
        limit = 512 * 1024 * 1024 if asset_type in {'image', 'audio', 'video'} else self.settings.upload_max_bytes
        if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= limit:
            raise AuthError(413, f'文件超出上传限制（{limit // 1024 // 1024} MiB）或大小无效')
        # Runtime may supply passive media types only. Documents and unknown
        # formats always download with nosniff, even if their name is an image.
        if mime == 'audio/x-wav':
            mime = 'audio/wav'  # FileResponse's WAV alias; never infer from filename or kind.
        if mime not in {'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
                        'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac'}:
            mime = 'application/octet-stream'
        scope = personal_scope(member)
        if operation_id is not None or operation_target is not None:
            self._validate_upload_operation_id(operation_id)
            if not isinstance(operation_target, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,199}', operation_target):
                raise AuthError(422, '归档操作目标无效')
            if archive_key is not None or content_sha256 is not None:
                raise AuthError(422, '归档键与归档操作不能同时使用')
            return await self._upload_runtime_operation(member.member_id, scope, stream, operation_id, operation_target,
                                                        filename, size, asset_type, mime)
        if archive_key is not None:
            if not isinstance(archive_key, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,200}', archive_key):
                raise AuthError(422, '归档键无效')
            if not isinstance(content_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', content_sha256):
                raise AuthError(422, '归档键须绑定有效内容 SHA-256')
            return await self._upload_runtime_keyed(member, stream, filename=filename, size=size,
                asset_type=asset_type, mime=mime, scope=scope, archive_key=archive_key, content_sha256=content_sha256)
        init = await self.call('POST', '/v1/assets:upload-init', scope, {
            'filename': filename, 'size': size, 'content_type': mime, 'type': asset_type,
            'resource_scope': scope, 'source_service': 'greenroom',
            'is_private': True, 'upload_mode': 'single', 'tags': ['greenroom'],
        })
        asset_id, upload_id = init.get('asset_id'), init.get('upload_id')
        if not isinstance(asset_id, str) or not isinstance(upload_id, str):
            raise AuthError(502, '资产服务未返回上传标识')
        upload_url = self.object_url(init.get('upload_url', ''))
        self.store.add(asset_id, member.member_id, scope, filename, size, mime, '', upload_id)

        async def content():
            received = 0
            async for chunk in stream:
                received += len(chunk)
                if received > size:
                    raise AuthError(413, '文件大小超过声明的上传大小')
                yield chunk
            if received != size:
                raise AuthError(422, '文件尚未完整上传')

        try:
            async with self.client(timeout=600) as client:
                response = await client.put(upload_url, content=content(),
                                            headers={'Content-Type': mime, 'Content-Length': str(size)})
            if not response.is_success:
                raise AuthError(502, '对象存储上传未完成')
            finalized = await self.call('POST', f'/v1/assets/{quote(upload_id, safe="")}/upload-finalize', scope, {})
            if finalized.get('asset_id') != asset_id:
                raise AuthError(502, '资产入库标识不一致')
        except BaseException as exc:
            self.store.update(asset_id, state='failed')
            try:
                await self.call('POST', f'/v1/assets/{quote(upload_id, safe="")}:abort-upload', scope, {})
            except AuthError:
                pass
            if isinstance(exc, httpx.HTTPError):
                raise AuthError(502, '对象存储暂不可用') from exc
            raise
        self.store.update(asset_id, state='ready')
        return {'assetId': asset_id, 'uploadId': upload_id, 'fileUrl': '/api/media/' + quote(asset_id, safe=''),
                'fileName': filename, 'fileSize': size, 'mimeType': mime, 'assetType': asset_type}

    @staticmethod
    def _validate_upload_operation_id(operation_id):
        if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,159}', operation_id):
            raise AuthError(422, '归档操作标识无效')

    @staticmethod
    def _upload_operation_result(operation):
        return {'assetId': operation['asset_id'], 'uploadId': operation['upload_id'],
                'fileUrl': '/api/media/' + quote(operation['asset_id'], safe=''),
                'fileName': operation['filename'], 'fileSize': operation['size'],
                'mimeType': operation['mime'], 'assetType': operation['asset_type']}

    async def _finalize_upload_operation(self, operation):
        # Serialize the short finalization and its local commit across broker
        # processes; a second reader reuses the first completed binding.
        async with self.store.archive_lock():
            scope = json.loads(operation['scope'])
            operation = await asyncio.to_thread(self.store.get_upload_operation, operation['member_id'], scope, operation['operation_id'])
            if operation['state'] == 'ready':
                return self._upload_operation_result(operation)
            if operation['state'] != 'put_complete':
                raise AuthError(409, '归档上传尚未确认完成')
            result = await self.call('POST', f'/v1/assets/{quote(operation["upload_id"], safe="")}/upload-finalize', scope, {})
            if result.get('asset_id') != operation['asset_id']:
                raise AuthError(502, '资产入库标识不一致')
            await asyncio.to_thread(self.store.complete_upload_operation, operation)
            return self._upload_operation_result(operation)

    async def upload_operation(self, member, operation_id):
        """Read the current member's original operation and retry only finalization."""
        self._validate_upload_operation_id(operation_id)
        operation = await asyncio.to_thread(self.store.get_upload_operation, member.member_id,
                                            personal_scope(member), operation_id)
        status = {'target': operation['target'], 'fileName': operation['filename'], 'fileSize': operation['size'],
                  'mimeType': operation['mime'], 'assetType': operation['asset_type']}
        if operation['state'] == 'put_complete':
            try:
                return {**status, 'state': 'ready', 'result': await self._finalize_upload_operation(operation)}
            except AuthError as exc:
                return {**status, 'state': 'put_complete', 'reason': exc.message}
        if operation['state'] == 'ready':
            return {**status, 'state': 'ready', 'result': self._upload_operation_result(operation)}
        return {**status, 'state': operation['state']}

    async def _upload_runtime_operation(self, member_id, scope, stream, operation_id, target,
                                        filename, size, asset_type, mime):
        operation, created = await asyncio.to_thread(self.store.begin_upload_operation, member_id, scope,
                                                     operation_id, target, filename, size, mime, asset_type)
        upload_url = None
        if created:
            try:
                init = await self.call('POST', '/v1/assets:upload-init', scope, {
                    'filename': filename, 'size': size, 'content_type': mime, 'type': asset_type,
                    'resource_scope': scope, 'source_service': 'greenroom',
                    'is_private': True, 'upload_mode': 'single', 'tags': ['greenroom'],
                })
            except AuthError as exc:
                raise AuthError(503, '上传初始化结果未知，请保留原文件并核对原归档操作') from exc
            asset_id, upload_id = init.get('asset_id'), init.get('upload_id')
            if not isinstance(asset_id, str) or not asset_id or not isinstance(upload_id, str) or not upload_id:
                raise AuthError(503, '上传初始化结果未知，请保留原文件并核对原归档操作')
            await asyncio.to_thread(self.store.save_upload_session, operation, upload_id, asset_id)
            operation = await asyncio.to_thread(self.store.get_upload_operation, member_id, scope, operation_id)
            upload_url = init.get('upload_url') or init.get('presigned_url')
        if operation['state'] == 'ready':
            return self._upload_operation_result(operation)
        if operation['state'] == 'init_unknown':
            raise AuthError(503, '上传初始化结果未知，请保留原文件并核对原归档操作')
        if operation['state'] == 'initialized':
            if upload_url is None:
                signed = await self.call('POST', f'/v1/assets/{quote(operation["upload_id"], safe="")}:presign-upload', scope, {})
                if signed.get('upload_id') != operation['upload_id'] or signed.get('asset_id') != operation['asset_id']:
                    raise AuthError(502, '恢复上传标识不一致')
                upload_url = signed.get('upload_url') or signed.get('presigned_url')
            url = self.object_url(upload_url or '')
            claimed = await asyncio.to_thread(self.store.transition_upload_operation, operation, 'initialized', 'put_unknown')
            if claimed:
                received = 0
                complete = False
                async def content():
                    nonlocal received, complete
                    async for chunk in stream:
                        received += len(chunk)
                        if received > size:
                            raise AuthError(413, '文件大小超过声明的上传大小')
                        yield chunk
                    if received != size:
                        raise AuthError(422, '文件尚未完整上传')
                    complete = True
                try:
                    async with self.client(timeout=600) as client:
                        response = await client.put(url, content=content(), headers={'Content-Type': mime, 'Content-Length': str(size)})
                except httpx.HTTPError as exc:
                    raise AuthError(503, '上传结果未知，请保留原文件并核对原归档操作') from exc
                if not response.is_success or not complete:
                    raise AuthError(503, '上传结果未知，请保留原文件并核对原归档操作')
                if not await asyncio.to_thread(self.store.transition_upload_operation, operation, 'put_unknown', 'put_complete'):
                    raise AuthError(409, '归档操作状态已变化')
            operation = await asyncio.to_thread(self.store.get_upload_operation, member_id, scope, operation_id)
        if operation['state'] == 'ready':
            return self._upload_operation_result(operation)
        if operation['state'] == 'put_complete':
            try:
                return await self._finalize_upload_operation(operation)
            except AuthError as exc:
                raise AuthError(503, '归档尚未完成，请保留原文件并按原操作重试查询') from exc
        raise AuthError(503, '归档结果未知，请保留原文件并按原操作查询')

    async def _upload_runtime_keyed(self, member, stream, *, filename, size, asset_type, mime, scope, archive_key, content_sha256):
        """Opt-in immutable-artifact identity, not content deduplication.

        Only IDs/phases are durable, never object URLs. Unknown init acceptance
        requires reconciliation outside this API, not another reservation.
        """
        identity = (member.member_id, json.dumps(scope, sort_keys=True), archive_key)
        received = 0
        complete = False
        digest = hashlib.sha256()

        async def content():
            nonlocal received, complete
            async for chunk in stream:
                received += len(chunk)
                if received > size:
                    raise AuthError(413, '文件大小超过声明的上传大小')
                digest.update(chunk)
                yield chunk
            if received != size:
                raise AuthError(422, '文件尚未完整上传')
            if digest.hexdigest() != content_sha256:
                raise AuthError(409, '文件内容与归档键绑定的内容不一致')
            complete = True

        async with self.store.archive_lock():
            row = self.store.archive_intent(identity, filename, size, mime, asset_type, content_sha256)
            if row is not None and row['phase'] == 'initializing':
                raise AuthError(409, '归档初始化结果未知；须核对原上传，不可新建重试')
            if row is None:
                init = await self.call('POST', '/v1/assets:upload-init', scope, {
                    'filename': filename, 'size': size, 'content_type': mime, 'type': asset_type,
                    'resource_scope': scope, 'source_service': 'greenroom',
                    'is_private': True, 'upload_mode': 'single', 'tags': ['greenroom'],
                })
                asset_id, upload_id = init.get('asset_id'), init.get('upload_id')
                if not isinstance(asset_id, str) or not asset_id or not isinstance(upload_id, str) or not upload_id:
                    raise AuthError(502, '资产服务未返回上传标识；初始化结果未知')
                # Persist IDs before URL validation/PUT, atomically with registry.
                self.store.archive_reserved(identity, asset_id, upload_id, filename, size, mime, content_sha256)
                phase = 'reserved'
            else:
                asset_id, upload_id, phase = row['asset_id'], row['upload_id'], row['phase']
                if phase == 'reserved':
                    init = await self.call('POST', f'/v1/assets/{quote(upload_id, safe="")}:presign-upload', scope, {})
                    if init.get('asset_id') != asset_id or init.get('upload_id') != upload_id:
                        raise AuthError(502, '恢复上传标识不一致')
            if phase == 'reserved':
                upload_url = self.object_url(init.get('upload_url') or init.get('presigned_url') or '')
                try:
                    async with self.client(timeout=600) as client:
                        response = await client.put(upload_url, content=content(),
                            headers={'Content-Type': mime, 'Content-Length': str(size)})
                except httpx.HTTPError as exc:
                    raise AuthError(502, '对象存储暂不可用；保留原上传待重试') from exc
                if not response.is_success or not complete:
                    raise AuthError(502, '对象存储上传未完成；保留原上传待重试')
                # A partial/uncertain PUT must never be finalized on recovery.
                self.store.archive_phase(identity, 'uploaded', asset_id)
            else:
                # Even a ready replay must obey the declared request body length.
                async for _ in content():
                    pass
            if phase != 'ready':
                # The existing keyed path verified the stream against this digest above.
                payload = {} if self.settings.local_asset else {'sha256': content_sha256}
                finalized = await self.call('POST', f'/v1/assets/{quote(upload_id, safe="")}/upload-finalize', scope, payload)
                if finalized.get('asset_id') != asset_id:
                    raise AuthError(502, '资产入库标识不一致')
                self.store.archive_phase(identity, 'ready', asset_id)
            return {'assetId': asset_id, 'uploadId': upload_id, 'fileUrl': '/api/media/' + quote(asset_id, safe=''),
                    'fileName': filename, 'fileSize': size, 'mimeType': mime, 'assetType': asset_type}

    async def reference_url(self, member, asset_id):
        row = self.store.get(asset_id)
        if row['state'] != 'ready' or row['owner_id'] != member.member_id:
            raise AuthError(403, '参考素材不属于当前成员或尚未归档')
        data = await self.call('GET', f'/v1/assets/{quote(asset_id, safe="")}/signed-url', row['scope'])
        return self.object_url(data.get('url') or data.get('signed_url') or '')

    async def upload(self, request: Request):
        member = current_member.get()
        if member is None:
            raise AuthError(401, '请先登录')
        filename = unquote(request.headers.get('x-file-name', ''))
        if not filename or len(filename) > 240 or any(x in filename for x in ('\r', '\n', '\x00', '/', '\\')):
            raise AuthError(422, '文件名无效')
        asset_type = request.headers.get('x-asset-type', 'document')
        if asset_type not in {'image', 'audio', 'video', 'document', 'code', 'design'}:
            raise AuthError(422, '文件类型无效')
        with tempfile.TemporaryDirectory(prefix='greenroom-upload-') as temporary:
            path = Path(temporary) / 'data'
            digest = None if self.settings.local_asset else hashlib.sha256()
            size = 0
            with path.open('wb') as file:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > self.settings.upload_max_bytes:
                        raise AuthError(413, '文件超出上传限制')
                    stats = os.statvfs(temporary)
                    if stats.f_bavail * stats.f_frsize - len(chunk) < 5 * 1024 ** 3:
                        raise AuthError(507, '上传临时空间不足，需保留 5 GiB 运行余量')
                    if digest is not None:
                        digest.update(chunk)
                    file.write(chunk)
            if not size:
                raise AuthError(422, '文件不能为空')
            mime = inert_mime(path)
            # Non-raster files are served as downloads; no active content runs on app origin.
            scope = personal_scope(member)
            init = await self.call('POST', '/v1/assets:upload-init', scope, {
                'filename': filename, 'size': size, 'content_type': mime, 'type': asset_type,
                'resource_scope': scope, 'source_service': 'greenroom',
                'is_private': True, 'upload_mode': 'single', 'tags': ['greenroom'],
            })
            asset_id, upload_id = init.get('asset_id'), init.get('upload_id')
            if not isinstance(asset_id, str) or not isinstance(upload_id, str):
                raise AuthError(502, '资产服务未返回上传标识')
            upload_url = self.object_url(init.get('upload_url', ''))
            checksum = digest.hexdigest() if digest is not None else ''
            self.store.add(asset_id, member.member_id, scope, filename, size, mime, checksum, upload_id)
            async def content():
                with path.open('rb') as file:
                    while chunk := file.read(256 * 1024):
                        yield chunk
            try:
                async with self.client(timeout=300) as client:
                    response = await client.put(upload_url, content=content(), headers={'Content-Type': mime, 'Content-Length': str(size)})
                if response.status_code not in range(200, 300):
                    raise AuthError(502, '文件上传失败，请重试')
                finalized = await self.call('POST', f'/v1/assets/{quote(upload_id, safe="")}/upload-finalize', scope,
                                            {'sha256': checksum} if checksum else {})
                if finalized.get('asset_id') != asset_id:
                    raise AuthError(502, '资产入库标识不一致')
            except httpx.HTTPError as exc:
                raise AuthError(502, '对象存储暂不可用') from exc
            self.store.update(asset_id, state='ready')
            return {'assetId': asset_id, 'uploadId': upload_id,
                    'fileUrl': f'/api/media/{quote(asset_id, safe="")}', 'fileName': filename,
                    'fileSize': size, 'mimeType': mime, 'assetType': asset_type, 'sha256': checksum}

    def metadata(self, value, member):
        if not isinstance(value, dict) or not isinstance(value.get('storageAssetId'), str):
            raise AuthError(422, '缺少已登记媒体标识')
        row = self.store.get(value['storageAssetId'])
        if row['owner_id'] != member.member_id or row['state'] != 'ready':
            raise AuthError(403, '此媒体不属于当前成员或上传尚未完成')
        if self.spaces.media_bound(row['asset_id']):
            raise AuthError(409, '此媒体已经存入空间，请在现有资产上操作')
        return {'storageAssetId': row['asset_id'], 'uploadId': row['upload_id'],
                'fileUrl': '/api/media/'+quote(row['asset_id'], safe=''), 'fileName': row['filename'],
                'fileSize': row['size'], 'mimeType': row['mime'], 'sha256': row['sha256']}

    async def register_generated(self, member, asset_id, kind):
        """Register an already archived Gateway output in the shared space."""
        scope = personal_scope(member)
        async with self.operation_lock:
            try:
                existing = self.store.get(asset_id)
            except AuthError as exc:
                if exc.status != 404:
                    raise
                existing = None
            if existing:
                if existing['owner_id'] != member.member_id:
                    raise AuthError(403, '生成产物不属于当前成员')
            else:
                asset = await self.call('GET', '/v1/assets/' + quote(asset_id, safe=''), scope)
                filename = asset.get('filename') or asset_id + ('.mp4' if kind == 'video' else '.png')
                with self.store.lock:
                    self.store.db.execute("INSERT OR IGNORE INTO media (asset_id,owner_id,scope,filename,size,mime,sha256,upload_id,state) VALUES (?,?,?,?,?,?,?,'','ready')",
                                          (asset_id, member.member_id, json.dumps(scope), filename,
                                           asset.get('size_bytes') or 0, asset.get('content_type') or 'application/octet-stream',
                                           asset.get('sha256') or ''))
                    self.store.db.commit()
                existing = self.store.get(asset_id)
                if existing['owner_id'] != member.member_id:
                    raise AuthError(403, '生成产物不属于当前成员')
            metadata = {'storageAssetId': asset_id, 'fileUrl': '/api/media/' + quote(asset_id, safe=''),
                        'fileName': existing['filename'], 'fileSize': existing['size'], 'mimeType': existing['mime']}
            self.spaces.register_generated(member.member_id, asset_id, kind, metadata)
            self.store.update(asset_id, desired='public')
            return metadata

    async def publish(self, asset_id):
        """Move a member's media into the shared organization scope."""
        self.store.update(asset_id, desired='public')
        try:
            await self.reconcile(asset_id)
        except AuthError:
            self.store.update(asset_id, desired='private')
            raise

    async def reconcile(self, asset_id):
        async with self.operation_lock:
            row = self.store.get(asset_id)
            if row['placement'] == row['desired']:
                return
            target = public_scope(self.settings, row['scope']['actor_id'])
            if row['desired'] == 'public':
                await self.call('POST', f'/v1/assets/{quote(asset_id, safe="")}:attach', row['scope'], {'source_scope': row['scope'], 'target_scope': target})
            else:
                await self.call('DELETE', f'/v1/assets/{quote(asset_id, safe="")}', target)
            self.store.update(asset_id, placement=row['desired'])

    async def serve(self, asset_id, request):
        member = current_member.get()
        row = self.store.get(asset_id)
        if row['state'] != 'ready' or (row['owner_id'] != member.member_id and not self.spaces.media_visible(asset_id, member.member_id)):
            raise AuthError(404, '媒体不存在或无权访问')
        # The registry remains the authority for signing; no client-selected scope.
        data = await self.call('GET', f'/v1/assets/{quote(asset_id, safe="")}/signed-url', row['scope'])
        url = self.object_url(data.get('url') or data.get('signed_url') or '')
        headers = {"Accept-Encoding": "identity"}
        if request.headers.get('range'):
            headers['Range'] = request.headers['range']
        session = self.client(timeout=300)
        client = await session.__aenter__()
        try:
            upstream = await client.send(client.build_request('GET', url, headers=headers), stream=True)
        except httpx.HTTPError as exc:
            await session.__aexit__(None, None, None)
            raise AuthError(502, '媒体暂不可用') from exc
        mime = row['mime']
        safe = mime in {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac'}
        response_headers = {k: v for k, v in upstream.headers.items() if k.lower() in {'content-range', 'accept-ranges', 'content-length'}}
        response_headers.update({'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
            'Content-Disposition': ('inline' if safe else 'attachment') + "; filename*=UTF-8''"+quote(row['filename'], safe=''),
            'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'"})
        closed = False
        async def close():
            nonlocal closed
            if closed:
                return
            closed = True
            try:
                await upstream.aclose()
            finally:
                await session.__aexit__(None, None, None)
        async def chunks():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await close()
        # The response owner can release an opened upstream even before iteration starts.
        return StreamingResponse(chunks(), status_code=upstream.status_code, headers=response_headers,
                                 background=BackgroundTask(close))

    async def retry_pending(self):
        for asset_id in self.store.pending():
            try:
                await self.reconcile(asset_id)
            except AuthError:
                pass  # durable state retained; worker retries without publishing a failed operation


def media_router(service):
    router = APIRouter(prefix='/api/media')
    @router.post('/uploads')
    async def upload(request: Request):
        return await service.upload(request)
    @router.get('/{asset_id}')
    async def read(asset_id: str, request: Request):
        return await service.serve(asset_id, request)
    return router
