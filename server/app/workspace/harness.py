"""Separate-origin authenticated edge for the complete official DSH WebUI."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import ssl
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, quote

import aiohttp
import httpx
from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.requests import Request as StarletteRequest
from starlette.websockets import WebSocket

from app.identity.auth import AuthError, current_member, error_response
from app.identity.standalone import STANDALONE_MEMBER_ID
from app.integrations.proxy import HOP_BY_HOP
from app.core.roster import ROSTER_BY_ID

RUNTIME_COOKIE = '__Host-greenroom-runtime'

# The first cross-site navigation has no Strict runtime Cookie. This page has
# no member data; its same-origin POST goes through the normal member edge.
class HarnessEdge:
    def __init__(self, settings, auth, sessions, *, governance=None, sleep=None):
        self.settings, self.auth, self.sessions = settings, auth, sessions
        self.governance = governance
        self.sleep = sleep
        self.slots = settings.runtime_slots or {}
        self.connections = {}
        self.sockets = {}
        self.busy_members = {}
        self._clients = {}
        self._loop = None
        self._ssl_context = None
        self._prewarm_tasks = {}
        self._entry_tasks = {}
        self._prewarm_limit = None
        origins = set()
        allowed_members = {STANDALONE_MEMBER_ID} if settings.standalone else ROSTER_BY_ID
        for member_id, slot in self.slots.items():
            if member_id not in allowed_members:
                raise RuntimeError('Unknown DSH member slot')
            origin = slot.get('origin', '')
            parsed = urlsplit(origin)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
                raise RuntimeError('Invalid DSH origin')
            if origin == settings.origin or origin in origins:
                raise RuntimeError('DSH origins must be separate and unique')
            target = urlsplit(slot.get('connector', ''))
            if target.scheme != 'https' or not target.hostname or target.path or target.query or target.username:
                raise RuntimeError('DSH connector requires a fixed HTTPS endpoint')
            origins.add(origin)
        self.origins = {urlsplit(slot['origin']).netloc: (member, slot) for member, slot in self.slots.items()}

    def ssl(self):
        if self._ssl_context is not None:
            return self._ssl_context
        if not self.settings.runtime_tls_dir:
            raise AuthError(503, 'DSH 通道证书未配置')
        root = Path(self.settings.runtime_tls_dir)
        context = ssl.create_default_context(cafile=str(root/'ca.crt'))
        context.load_cert_chain(str(root/'edge.crt'), str(root/'edge.key'))
        self._ssl_context = context
        return context

    def _new_client(self, long):
        return aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar(),
            connector=aiohttp.TCPConnector(ssl=self.ssl(), limit=180 if long else 60,
                                           limit_per_host=12 if long else 8),
            timeout=aiohttp.ClientTimeout(total=None if long else 20, sock_connect=10,
                                          sock_read=300 if long else 20), trust_env=False)

    async def start(self):
        self._loop = asyncio.get_running_loop()
        self._prewarm_limit = asyncio.Semaphore(4)
        if self.slots:
            self._clients = {long: self._new_client(long) for long in (False, True)}

    async def aclose(self):
        tasks = set(self._prewarm_tasks) | set(self._entry_tasks.values())
        for connections in self.connections.values():
            tasks.update(connections)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        clients, self._clients = self._clients, {}
        self._loop = None
        for client in clients.values():
            await client.close()

    def schedule_prewarm(self, identity):
        if identity.member_id not in self.slots:
            return
        if self.memory_active():
            entry = self.sessions.entry(identity.member_id)
            if not entry or entry['state'] != 'active':
                return
        if self._prewarm_limit is None:
            self._prewarm_limit = asyncio.Semaphore(4)
        task = asyncio.create_task(self.prewarm(identity))
        self._prewarm_tasks[task] = identity.access_token
        task.add_done_callback(lambda completed: self._prewarm_tasks.pop(completed, None))

    async def prewarm(self, identity):
        slot = self.slots[identity.member_id]
        try:
            async with self._prewarm_limit:
                # Restore uses a normal runtime binding, revoked with this login.
                def issue_grant():
                    ticket = self.sessions.issue(identity, slot['origin'])
                    return self.sessions.consume(ticket, slot['origin'], admission_required=self.memory_active())[0]
                token = await self.auth.storage_call(issue_grant)
                async with self.client(long=True) as client:
                    async with client.post(slot['connector']+'/control/prewarm',
                            headers={'X-Greenroom-Runtime': token},
                            timeout=aiohttp.ClientTimeout(total=180, sock_connect=10)) as response:
                        await response.read()
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, AuthError):
            return

    def memory_active(self):
        return self.sleep is not None and self.sleep.memory_active()

    def legacy_probe_proof(self, identity, origin):
        if self.sessions.cipher is None:
            raise AuthError(503, 'DSH 会话配置尚未就绪')
        data = {'purpose': 'legacy-entry', 'member': identity.member_id, 'user': identity.user_id,
                'tenant': identity.tenant_id, 'origin': origin}
        return self.sessions.cipher.encrypt(json.dumps(data, separators=(',', ':')).encode()).decode()

    def legacy_probe_identity(self, proof, member_id, origin):
        if self.sessions.cipher is None:
            return None
        try:
            data = json.loads(self.sessions.cipher.decrypt(proof, ttl=60))
        except (InvalidToken, TypeError, ValueError):
            return None
        if (not isinstance(data, dict) or set(data) != {'purpose', 'member', 'user', 'tenant', 'origin'}
                or data['purpose'] != 'legacy-entry' or data['member'] != member_id or data['origin'] != origin
                or not isinstance(data['user'], str) or not data['user']
                or not isinstance(data['tenant'], str) or not data['tenant']):
            return None
        return data['user'], data['tenant']

    async def verify(self, token, origin, member_id, *, include_admission=False):
        resolved = await self.auth.storage_call(self.sessions.resolve, token, origin, member_id,
                                                include_admission=include_admission)
        main, expected = resolved[:2]
        identity = await self.auth.verify(main)
        if identity.member_id != expected:
            raise AuthError(403, 'DSH 成员身份不一致')
        return (identity, resolved[2]) if include_admission else identity

    async def adopt_legacy(self, member_id, identity=None):
        try:
            entry = await self.auth.storage_call(self.sessions.entry, member_id)
            if entry and entry['state'] == 'retiring':
                await self.auth.storage_call(self.sessions.request_restore, member_id)
                if identity is not None:
                    self.start_entry(identity)
                return False
            runtime = await self.auth.storage_call(self.sessions.runtime_row, member_id)
            if runtime and runtime['state'] == 'draining' and not runtime['scale']:
                instances = await self.sleep._instances(member_id)
                decision = await self.auth.storage_call(self.sessions.admit_work, member_id, 'http', '',
                                                        instances=instances)
                if decision.get('operation_id'):
                    await self.auth.storage_call(self.sessions.finish_work, decision['operation_id'])
                return False
            uid, name, cap = await self.sleep.memory.resident(member_id)
            return await self.auth.storage_call(self.sessions.adopt_entry, member_id, uid, name, cap)
        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, ValueError):
            return False

    def start_entry(self, identity):
        member_id = identity.member_id
        task = self._entry_tasks.get(member_id)
        if task is not None and not task.done():
            return
        async def run():
            wake_task = None
            try:
                while True:
                    current = await self.auth.storage_call(self.sessions.entry, member_id)
                    if not current or current['state'] != 'retiring' or current['requested'] != 1:
                        break
                    await asyncio.sleep(2)
                if not current or current['state'] not in {'starting', 'active'}:
                    return
                async def ready():
                    return (await self.status(member_id)).get('ready') is True
                # A previous owner may have disappeared after a confirmed scale.
                # Complete that same wake only from current health and a CAS.
                row = await self.auth.storage_call(self.sessions.runtime_row, member_id)
                entry = await self.auth.storage_call(self.sessions.entry, member_id)
                if (row and row['wake'] and not row['scale'] and not row['reopen']
                        and row['state'] == 'starting' and entry and entry['state'] == 'starting'):
                    deployment = await self.sleep.render.read_deployment(member_id)
                    if deployment.get('spec', {}).get('replicas') == 1 and await ready():
                        uid, name, cap = await self.sleep.memory.resident(member_id)
                        if cap <= entry['reserved_bytes']:
                            await self.auth.storage_call(self.sessions.release_wake, member_id, row['wake'],
                                                         row['op_epoch'], gate_epoch=row['epoch'], state='ready',
                                                         replicas=1, activity=time.time(), result='ready')
                            if await self.auth.storage_call(self.sessions.activate_entry, member_id, uid, name, cap, (uid,)):
                                self.schedule_prewarm(identity)
                                return
                wake_task = asyncio.create_task(self.sleep.wake(member_id, ready))
                while not wake_task.done():
                    await asyncio.wait({wake_task}, timeout=2)
                    if wake_task.done():
                        break
                    try:
                        failure = await self.sleep.memory.startup_failure(member_id)
                    except (AuthError, httpx.HTTPError, OSError, ValueError):
                        failure = None
                    if failure:
                        uid, detail = failure
                        operation = await self.auth.storage_call(self.sessions.begin_failed_start_retirement,
                                                                 member_id, uid, detail)
                        if operation:
                            wake_task.cancel()
                            await asyncio.gather(wake_task, return_exceptions=True)
                            try:
                                await self.sleep._scale(member_id, 0, operation=operation)
                            except AuthError:
                                pass
                            return
                await wake_task
                uid, name, cap = await self.sleep.memory.resident(member_id)
                if await self.auth.storage_call(self.sessions.activate_entry, member_id, uid, name, cap, (uid,)):
                    self.schedule_prewarm(identity)
            except (AuthError, aiohttp.ClientError, httpx.HTTPError, asyncio.TimeoutError, OSError, ValueError):
                await self.auth.storage_call(self.sessions.mark_start_unknown, member_id)
                return
            finally:
                if wake_task is not None and not wake_task.done():
                    wake_task.cancel()
                    await asyncio.gather(wake_task, return_exceptions=True)
        task = asyncio.create_task(run())
        self._entry_tasks[member_id] = task
        task.add_done_callback(lambda completed: self._entry_tasks.pop(member_id, None)
                               if self._entry_tasks.get(member_id) is completed else None)

    @asynccontextmanager
    async def client(self, *, long=False):
        client = self._clients.get(long) if self._loop is asyncio.get_running_loop() else None
        if client is not None:
            yield client
        else:
            async with self._new_client(long) as client:
                yield client

    async def status(self, member_id):
        slot = self.slots.get(member_id)
        if not slot:
            return {'ready': False, 'version': self.settings.dsh_version, 'detail': '成员运行环境尚未配置'}
        try:
            async with self.client() as client:
                async with client.get(slot['connector']+'/control/health') as response:
                    data = await response.json()
                    return {'ready': response.status == 200 and data.get('ready') is True,
                            'version': self.settings.dsh_version,
                            **self._runtime_state(member_id)}
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, AuthError):
            return {'ready': False, 'version': self.settings.dsh_version, 'detail': '成员运行环境正在准备或暂不可用',
                    **self._runtime_state(member_id)}

    def _runtime_state(self, member_id):
        # Added only when the feature is on; status queries never wake a member
        # and never extend its idle window.
        if self.sleep is None or not (self.sleep.enabled or self.memory_active()):
            return {}
        return {'runtime_state': self.sleep.runtime_state(member_id)}

    async def revoke(self, main_token):
        for task, token in list(self._prewarm_tasks.items()):
            if token == main_token:
                if task.get_loop() is asyncio.get_running_loop():
                    task.cancel()
                else:
                    task.get_loop().call_soon_threadsafe(task.cancel)
        await self.auth.storage_call(self.sessions.revoke_main, main_token)
        for task in list(self.connections.get(main_token, set())):
            task.get_loop().call_soon_threadsafe(task.cancel)

    def _foreground(self, member_id):
        if self.sleep is not None:
            self.sleep.touch(member_id, foreground=True)

    async def _register_work(self, member_id, kind, origin):
        """Register one real foreground operation across processes.

        The local socket and busy counters let this process see its own
        requests, but a drain is decided on the shared table: without a work row
        a request this process holds could be invisible to a scale-down. The
        decision is returned whole so the caller can refuse a request the shared
        state did not admit instead of forwarding it.

        A member that is mid-drain gets its reopen intent armed here, and the
        new epoch's expected instances are read from the real components in the
        same call, so the reopen confirmation has real identities to be checked
        against rather than an unmatchable empty protocol.
        """
        if self.sleep is None:
            return None
        instances = None
        if self.sleep.components is not None:
            row = self.sessions.runtime_row(member_id)
            if row is not None and row['reopen'] and not row['scale']:
                # Retry the existing reopen epoch without forcing it open.
                await self.sleep._reopen(member_id, row['epoch'])
                row = self.sessions.runtime_row(member_id)
            if row is not None and row['state'] == 'draining':
                instances = await self.sleep._instances(member_id)
        decision = self.sessions.admit_work(member_id, kind, origin, instances=instances,
                                            idle_ms=self.sleep.idle_ms if self.sleep.enabled or self.memory_active() else 0,
                                            require_entry=self.memory_active())
        if decision['decision'] == 'reopen' and self.sleep.components is not None:
            await self.sleep._reopen(member_id, decision['epoch'])
        return decision

    def _release_work(self, operation):
        if self.sleep is None or not operation:
            return
        self.sessions.finish_work(operation)

    async def handle(self, scope, receive, send):
        request = StarletteRequest(scope, receive) if scope['type'] == 'http' else WebSocket(scope, receive, send)
        member_id, slot = self.origins[request.headers.get('host', '')]
        # Do not register work or change drain state until identity is verified.
        return await self._handle(request, scope, receive, send, member_id, slot, slot['origin'])

    @asynccontextmanager
    async def _registered_work(self, member_id, kind, origin, *, foreground):
        # Register only after authentication and protect the whole operation.
        admission = self.sleep.admit(member_id) if self.sleep is not None else None
        if admission is not None:
            await admission.acquire()
        self.busy_members[member_id] = self.busy_members.get(member_id, 0) + 1
        operation = None
        try:
            try:
                decision = await self._register_work(member_id, kind, origin)
                operation = decision.get('operation_id') if decision else None
                if decision is not None and decision.get('decision') != 'admitted':
                    raise AuthError(503, '成员运行环境正在准备，请稍后重试')
                if foreground:
                    self._foreground(member_id)
            finally:
                if admission is not None:
                    admission.release()
            yield
        finally:
            self._release_work(operation)
            self.busy_members[member_id] -= 1
            if self.busy_members[member_id] <= 0:
                self.busy_members.pop(member_id, None)

    async def _forward_registered(self, request, scope, receive, send, member_id, slot, origin, runtime_token, identity):
        async with self._registered_work(member_id, 'http' if scope['type'] == 'http' else 'ws',
                                         origin, foreground=True):
            return await self._forward(request, scope, receive, send, member_id, slot, origin, runtime_token, identity)

    async def _handle(self, request, scope, receive, send, member_id, slot, origin):
        if scope['type'] == 'http' and scope['path'] == '/_greenroom/legacy-entry':
            if request.method != 'POST' or request.headers.get('origin') != self.settings.origin:
                raise AuthError(403, 'DSH 启动来源无效')
            body = await request.body()
            expected = self.legacy_probe_identity(body, member_id, origin) if len(body) <= 4096 else None
            state = 'absent'
            if expected is not None and self.memory_active():
                try:
                    token = request.cookies.get(RUNTIME_COOKIE, '')
                    identity, admission_required = await self.verify(token, origin, member_id, include_admission=True)
                    if not admission_required and (identity.user_id, identity.tenant_id) == expected:
                        state = 'adopted' if await self.adopt_legacy(member_id, identity) else 'retry'
                except AuthError as exc:
                    state = 'retry' if exc.status >= 500 else 'absent'
                except (aiohttp.ClientError, httpx.HTTPError, asyncio.TimeoutError, OSError):
                    state = 'retry'
            response = JSONResponse({'state': state}, headers={
                'Cache-Control': 'no-store', 'Vary': 'Origin',
                'Access-Control-Allow-Origin': self.settings.origin,
                'Access-Control-Allow-Credentials': 'true',
            })
            return await response(scope, receive, send)
        if scope['type'] == 'http' and scope['path'] == '/bootstrap':
            if request.method != 'POST' or request.headers.get('origin') != self.settings.origin:
                raise AuthError(403, 'DSH 启动来源无效')
            body = await request.body()
            if len(body) > 1024:
                raise AuthError(413, '启动请求过大')
            ticket = parse_qs(body.decode()).get('ticket', [''])[0]
            active = self.memory_active()
            token, expected = await self.auth.storage_call(self.sessions.consume, ticket, origin,
                                                           admission_required=active)
            if expected != member_id:
                raise AuthError(403, 'DSH 启动身份无效')
            identity = await self.verify(token, origin, member_id)
            if active:
                entry = await self.auth.storage_call(self.sessions.entry, member_id)
                if (not entry or entry['state'] != 'active') and not await self.adopt_legacy(member_id, identity):
                    raise AuthError(503, '成员运行环境正在排队，请从工作台重新进入')
            response = RedirectResponse('/?greenroom_parent=' + quote(self.settings.origin, safe=''), status_code=303,
                                        headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
            response.set_cookie(RUNTIME_COOKIE, token, secure=True, httponly=True, samesite='strict', max_age=12*3600, path='/')
            if not active:
                async with self._registered_work(member_id, 'http', origin, foreground=False):
                    return await response(scope, receive, send)
            return await response(scope, receive, send)
        if request.headers.get('origin') not in {None, origin}:
            raise AuthError(403, 'DSH 请求来源无效')
        if scope['type'] == 'websocket' and request.headers.get('origin') != origin:
            raise AuthError(403, 'DSH WebSocket 来源无效')
        if scope['type'] == 'http' and request.method not in {'GET', 'HEAD'} and request.headers.get('origin') != origin:
            raise AuthError(403, 'DSH 写入来源无效')
        if 'token' in request.query_params:
            raise AuthError(400, 'DSH 不接受浏览器上游凭据')
        runtime_token = request.cookies.get(RUNTIME_COOKIE, '')
        identity, admission_required = await self.verify(runtime_token, origin, member_id, include_admission=True)
        if self.memory_active():
            entry = await self.auth.storage_call(self.sessions.entry, member_id)
            if not entry or entry['state'] != 'active':
                if admission_required or not await self.adopt_legacy(member_id, identity):
                    raise AuthError(503, '成员运行环境正在排队，请从工作台重新进入')
        return await self._forward_registered(request, scope, receive, send, member_id, slot, origin,
                                               runtime_token, identity)

    async def _forward(self, request, scope, receive, send, member_id, slot, origin, runtime_token, identity):
        if (scope['type'] == 'http' and request.method not in {'GET', 'HEAD'}
                and scope['path'].startswith('/huobao/api/v1/ai-configs')):
            raise AuthError(404, '接口不存在')
        managed = ('/api/feishu', '/api/media/', '/canvas/api/greenroom/models',
                   '/canvas/api/greenroom/huobao-models', '/canvas/api/greenroom/tasks/',
                   '/canvas/api/greenroom/runninghub/submit', '/canvas/api/greenroom/settings',
                   '/canvas/api/proxy/llm', '/canvas/api/proxy/image/submit',
                   '/canvas/api/proxy/image/status/', '/canvas/api/proxy/video/submit',
                   '/canvas/api/proxy/video/query')
        if scope['type'] == 'http' and scope['path'].startswith(managed):
            scope.setdefault('state', {})['member'] = identity
            return await self.app(scope, receive, send)
        # WebSocket compression is negotiated separately on each proxy hop.
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP and not k.lower().startswith(('x-greenroom-', 'sec-fetch-')) and k.lower() not in {'origin', 'sec-websocket-extensions'}}
        headers['X-Greenroom-Runtime'] = runtime_token
        if scope['type'] == 'http' and self.governance is not None:
            if scope['path'].startswith('/canvas/api/proxy/'):
                keys_data = self.governance.get_canvas_settings(include_keys=True)['keys']
                if not keys_data.get('rhApiKey'):
                    cn_cands = self.governance.get_candidate_runninghub_keys('cn')
                    if cn_cands:
                        keys_data['rhApiKey'] = cn_cands[0]['apiKey']
                if not keys_data.get('rhIntlApiKey'):
                    intl_cands = self.governance.get_candidate_runninghub_keys('intl')
                    if intl_cands:
                        keys_data['rhIntlApiKey'] = intl_cands[0]['apiKey']
                headers['X-Greenroom-Canvas-Keys'] = json.dumps(keys_data, separators=(',', ':'))
            elif request.method == 'GET' and scope['path'].rstrip('/') == '/canvas/api/settings':
                configured_data = self.governance.get_canvas_settings()['configuredKeys']
                if not configured_data.get('rhApiKey') and bool(self.governance.get_candidate_runninghub_keys('cn')):
                    configured_data['rhApiKey'] = True
                if not configured_data.get('rhIntlApiKey') and bool(self.governance.get_candidate_runninghub_keys('intl')):
                    configured_data['rhIntlApiKey'] = True
                headers['X-Greenroom-Canvas-Configured'] = json.dumps(configured_data, separators=(',', ':'))
        canvas_path = scope['path'].startswith(('/canvas/', '/files/', '/input/', '/output/'))
        target = slot['connector'] + ('/canvas' if canvas_path else '/ui') + (
            scope['path'].removeprefix('/canvas') if canvas_path else scope['path'])
        if scope.get('query_string'):
            target += '?' + scope['query_string'].decode('ascii')
        if scope['type'] == 'websocket':
            return await self.websocket(request, target, headers, runtime_token, origin, member_id, identity.access_token)
        incoming = request.stream()
        first = await anext(incoming)
        async def body():
            yield first
            async for chunk in incoming:
                yield chunk
        if not first:
            await incoming.aclose()
        async with self.client(long=True) as client:
            try:
                response = await client.request(request.method, target, headers=headers,
                                                data=body() if first else None, allow_redirects=False)
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                raise AuthError(502, 'DSH 运行环境暂不可用') from exc
            safe_headers = {k: v for k, v in response.headers.items() if k.lower() not in HOP_BY_HOP and k.lower() not in {'set-cookie', 'content-encoding', 'content-security-policy', 'x-frame-options'}}
            safe_headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
                                 'Content-Security-Policy': "frame-ancestors 'self' "+self.settings.origin})
            if response.content_length is not None and response.headers.get('Content-Encoding', 'identity').lower() == 'identity':
                safe_headers['Content-Length'] = str(response.content_length)
            try:
                if response.content.is_eof() and response.content.total_bytes <= 65536:
                    await Response(await response.read(), status_code=response.status, headers=safe_headers)(scope, receive, send)
                    return
                async def chunks():
                    async for chunk in response.content.iter_chunked(65536):
                        yield chunk
                await StreamingResponse(chunks(), status_code=response.status, headers=safe_headers)(scope, receive, send)
            finally:
                response.release()

    async def websocket(self, browser, target, headers, token, origin, member_id, main):
        task = asyncio.current_task()
        self.connections.setdefault(main, set()).add(task)
        # A live workbench socket is member-owned activity: sleep must wait for
        # it, and its presence refreshes the member's idle window.
        self.sockets[member_id] = self.sockets.get(member_id, 0) + 1
        self._foreground(member_id)
        try:
            protocols = browser.scope.get('subprotocols', [])
            headers = {key: value for key, value in headers.items() if key.lower() != 'sec-websocket-protocol'}
            async with self.client(long=True) as client:
                async with client.ws_connect(target, headers=headers, protocols=protocols,
                                             max_msg_size=16*1024*1024, heartbeat=20) as upstream:
                    await browser.accept(subprotocol=upstream.protocol)
                    async def from_browser():
                        while True:
                            message = await browser.receive()
                            if message['type'] == 'websocket.disconnect':
                                return
                            if message.get('bytes') is not None:
                                self._foreground(member_id)
                                await upstream.send_bytes(message['bytes'])
                            elif message.get('text') is not None:
                                self._foreground(member_id)
                                await upstream.send_str(message['text'])
                    async def from_upstream():
                        async for message in upstream:
                            if message.type == aiohttp.WSMsgType.TEXT:
                                await browser.send_text(message.data)
                            elif message.type == aiohttp.WSMsgType.BINARY:
                                await browser.send_bytes(message.data)
                            else:
                                return
                    async def revalidate():
                        while True:
                            await asyncio.sleep(25)
                            await self.verify(token, origin, member_id)
                    tasks = [asyncio.create_task(coro()) for coro in (from_browser, from_upstream, revalidate)]
                    try:
                        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        for item in tasks: item.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            self.connections.get(main, set()).discard(task)
            self.sockets[member_id] -= 1
            if self.sockets[member_id] <= 0:
                self.sockets.pop(member_id, None)
            try: await browser.close()
            except RuntimeError: pass


class MemberComponents:
    """The three real member-side components, over the existing mTLS channel.

    The connector is the only endpoint the edge can reach directly, and it
    reports the identities the bridge and the canvas backend gave it over
    loopback. Each component answers a drain or a reopen only for a given epoch
    and its own instance, so nothing here can invent an identity, a closure or
    a reopening.
    """

    def __init__(self, edge):
        self.edge = edge

    async def _control(self, member_id, path, payload=None):
        slot = self.edge.slots.get(member_id)
        if not slot or not slot.get('connector'):
            raise AuthError(503, '成员运行环境未配置')
        async with self.edge.client() as client:
            async with client.request('POST' if payload is not None else 'GET',
                                      slot['connector'] + path, json=payload) as response:
                if response.status != 200:
                    raise AuthError(503, '成员组件状态未确认')
                return await response.json()

    async def plugin_memory(self, member_id, phase, plugin, uid, instance, epoch):
        payload = {'member_id': member_id, 'plugin_id': plugin, 'pod_uid': uid,
                   'instance_id': instance, 'epoch': epoch}
        result = await self._control(member_id, '/control/memory/' + phase, payload)
        if not isinstance(result, dict) or any(result.get(key) != value for key, value in payload.items()):
            raise AuthError(503, '插件内存状态未确认')
        if phase == 'drain':
            current = result.get('memory_current_bytes')
            if (result.get('closed') is not True or result.get('idle') is not True
                    or not isinstance(current, int) or isinstance(current, bool) or current <= 0):
                raise AuthError(503, '插件空闲状态未确认')
        elif phase == 'reopen':
            if result.get('opened') is not True:
                raise AuthError(503, '插件恢复状态未确认')
        else:
            raise AuthError(503, '插件控制状态无效')
        return result

    async def stopped_plugin(self, member_id, plugin):
        body = await self._control(member_id, '/control/work')
        if not isinstance(body, dict) or body.get('memory_enabled') is not True:
            return None
        matches = [item for item in body.get('plugins', []) if isinstance(item, dict) and item.get('id') == plugin]
        if len(matches) != 1:
            return None
        item = matches[0]
        work, memory = item.get('work') or {}, item.get('memory') or {}
        current = memory.get('memory_current_bytes')
        if (item.get('lifecycle') != 'sleeping' or item.get('activeRequests') != 0
                or work.get('known') is not True or work.get('busy') is not False
                or memory.get('plugin_id') != plugin or memory.get('drain_epoch') != 0
                or not memory.get('pod_uid') or not memory.get('instance_id')
                or not isinstance(current, int) or isinstance(current, bool) or current <= 0):
            return None
        return memory

    async def instances(self, member_id):
        """Each component's own instance identity, or nothing for it.

        The connector reports all three, each read from the component itself.
        A component that cannot be reached, or that answers for another member,
        is absent, and the caller then refuses the drain rather than naming an
        instance nobody confirmed.
        """
        body = await self._control(member_id, '/control/instance')
        if not isinstance(body, dict) or body.get('member_id') != member_id:
            return {}
        components = body.get('components')
        if not isinstance(components, dict):
            return {}
        bound = {}
        for component, instance_id in components.items():
            if component in {'connector', 'bridge', 'canvas'} \
                    and isinstance(instance_id, str) and instance_id:
                bound[component] = instance_id
        return bound

    async def confirmations(self, member_id, epoch):
        """Closed-and-idle confirmations for one drain epoch, per component.

        Each confirmation carries the member, the epoch and the instance the
        component itself reported. Anything missing stays out, so the scale-down
        has nothing to commit against.
        """
        bound = await self.instances(member_id)
        if sorted(bound) != ['bridge', 'canvas', 'connector']:
            return {}
        body = await self._control(member_id, '/control/drain',
                                   {'member_id': member_id, 'epoch': epoch,
                                    'instance_id': bound['connector']})
        return self._entries(body, member_id, epoch, bound, 'closed')

    async def opened(self, member_id, epoch):
        """Opened confirmations for one reopen epoch, per component."""
        bound = await self.instances(member_id)
        if sorted(bound) != ['bridge', 'canvas', 'connector']:
            return {}
        body = await self._control(member_id, '/control/reopen',
                                   {'member_id': member_id, 'epoch': epoch,
                                    'instance_id': bound['connector']})
        return self._entries(body, member_id, epoch, bound, 'opened')

    @staticmethod
    def _entries(body, member_id, epoch, bound, flag):
        """The confirmations in the exact shape the shared protocol defines.

        A missing member, epoch or instance, or a flag that is not literally
        true, yields nothing for that component: a bare truthy value or a 200
        reply never stands in for a confirmation.
        """
        if not isinstance(body, dict) or body.get('member_id') != member_id \
                or body.get('epoch') != epoch or body.get(flag) is not True:
            return {}
        components = body.get('components')
        if not isinstance(components, dict):
            return {}
        fields = {'closed': ('closed', 'idle'), 'opened': ('opened',)}[flag]
        entries = {}
        for component, instance_id in bound.items():
            entry = components.get(component)
            if not isinstance(entry, dict) or set(entry) != {'member_id', 'epoch', 'instance_id', *fields}:
                continue
            if entry['member_id'] != member_id or entry['epoch'] != epoch or entry['instance_id'] != instance_id:
                continue
            if any(entry[name] is not True for name in fields):
                continue
            entries[component] = entry
        return entries


class RuntimeOriginMiddleware:
    def __init__(self, app, edge):
        self.app, self.edge = app, edge
        self.edge.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] not in {'http', 'websocket'}:
            return await self.app(scope, receive, send)
        host = dict(scope['headers']).get(b'host', b'').decode()
        if scope['type'] == 'http' and scope['path'] == '/healthz':
            return await self.app(scope, receive, send)
        if host not in self.edge.origins:
            if host != urlsplit(self.edge.settings.origin).netloc:
                if scope['type'] == 'http':
                    return await JSONResponse({'detail': '访问域名无效'}, status_code=400)(scope, receive, send)
                return await send({'type': 'websocket.close', 'code': 1008})
            return await self.app(scope, receive, send)
        response_started = False
        async def runtime_send(message):
            nonlocal response_started
            if message['type'] == 'http.response.start':
                response_started = True
            await send(message)
        try:
            await self.edge.handle(scope, receive, runtime_send)
        except AuthError as exc:
            if response_started:
                raise
            if scope['type'] == 'websocket':
                await send({'type': 'websocket.close', 'code': 1008})
            else:
                await error_response(exc)(scope, receive, send)
        except (aiohttp.ClientError, asyncio.TimeoutError, UnicodeError, ValueError):
            if response_started:
                raise
            if scope['type'] == 'websocket':
                await send({'type': 'websocket.close', 'code': 1011})
            else:
                await error_response(AuthError(502, 'DSH 通道暂不可用'))(scope, receive, send)


def harness_router(edge, media, spaces):
    router = APIRouter(prefix='/api/harness')
    @router.get('/status')
    async def status():
        return await edge.status(current_member.get().member_id)
    @router.get('/resident-status')
    async def resident_status():
        # This authenticated API exposes aggregate counts, never another member's identity.
        from app.workspace.member_memory import resident_summary
        target = edge.settings.member_resident_target
        memory = edge.sleep.memory if edge.sleep is not None else None
        if memory is None:
            result = resident_summary(None, {}, target)
            result['blocked_reason'] = 'memory_admission_inactive'
            return result
        return await memory.resident_status(target)
    @router.post('/launch')
    async def launch(request: Request):
        member = current_member.get()
        if edge.memory_active():
            edge.sleep.member_for(member.member_id)
            raw = await request.body()
            retry_failed = False
            if raw:
                try:
                    body = json.loads(raw)
                    if not isinstance(body, dict) or set(body) != {'retry_failed'} or body['retry_failed'] is not True:
                        raise ValueError()
                    retry_failed = True
                except (TypeError, ValueError):
                    raise AuthError(422, '启动请求格式无效')
            failure = await edge.auth.storage_call(edge.sessions.start_failure, member.member_id)
            if failure:
                cleared = retry_failed and await edge.auth.storage_call(edge.sessions.retry_failed_entry, member.member_id)
                if not cleared:
                    return JSONResponse({'detail': failure['detail']}, status_code=503,
                                        headers={'Cache-Control': 'no-store'})
            entry = await edge.auth.storage_call(edge.sessions.request_entry, member.member_id)
            if entry['state'] == 'waiting':
                try:
                    snapshot, _ = await edge.sleep.memory.snapshot(member.member_id)
                    await edge.auth.storage_call(edge.sessions.reserve_entry, member.member_id, snapshot)
                except (AuthError, aiohttp.ClientError, httpx.HTTPError, asyncio.TimeoutError, OSError, ValueError):
                    pass
                entry = await edge.auth.storage_call(edge.sessions.entry, member.member_id)
            if entry and entry['state'] in {'starting', 'active'}:
                if entry['state'] == 'starting':
                    edge.start_entry(member)
                elif await edge.auth.storage_call(edge.sessions.memory_admissible, member.member_id):
                    status = await edge.status(member.member_id)
                    if status['ready']:
                        origin = edge.slots[member.member_id]['origin']
                        ticket = await edge.auth.storage_call(edge.sessions.issue, member, origin)
                        return {'action': origin+'/bootstrap', 'ticket': ticket, 'origin': origin,
                                'version': edge.settings.dsh_version}
            state = 'queued' if not entry or entry['state'] == 'waiting' else 'starting'
            unknown = state == 'starting' and await edge.auth.storage_call(edge.sessions.start_unknown, member.member_id)
            detail = ('启动状态尚未确认，正在等待恢复' if unknown else
                      '当前工作台繁忙，正在排队' if state == 'queued' else '工作台正在准备')
            origin = edge.slots[member.member_id]['origin']
            return JSONResponse({'runtime_state': state, 'retry_after_ms': 2000, 'detail': detail,
                                 'legacy_probe': {'origin': origin, 'proof': edge.legacy_probe_proof(member, origin)},
                                 **({'outcome_unknown': True} if unknown else {})},
                                status_code=202, headers={'Cache-Control': 'no-store'})
        if edge.sleep is not None and edge.sleep.enabled:
            # The workbench entry is the only wake trigger; a member that is
            # not ready yet answers 202 and the frontend polls status for the
            # real ticket. With the feature off the original behavior stands.
            async def ready():
                # Only a confirmed healthy runtime counts as ready; any other
                # status payload keeps the wake waiting for its deadline.
                return (await edge.status(member.member_id)).get('ready') is True
            try:
                await edge.sleep.wake(member.member_id, ready)
            except AuthError as exc:
                return JSONResponse({'runtime_state': edge.sleep.runtime_state(member.member_id),
                                     'retry_after_ms': 2000, 'detail': exc.message}, status_code=202,
                                    headers={'Cache-Control': 'no-store'})
        status = await edge.status(member.member_id)
        if not status['ready']:
            raise AuthError(503, status.get('detail', 'DSH 尚未就绪'))
        if edge.sleep is not None and not edge.sleep.enabled:
            # Only an authenticated healthy launch may initialize a missing row.
            await edge.auth.storage_call(edge.sessions.confirm_resident, member.member_id,
                                         time.time(), missing_only=True)
        origin = edge.slots[member.member_id]['origin']
        ticket = await edge.auth.storage_call(edge.sessions.issue, member, origin)
        return {'action': origin+'/bootstrap', 'ticket': ticket, 'origin': origin, 'version': edge.settings.dsh_version}
    @router.delete('/launch')
    async def cancel_launch():
        if not edge.memory_active():
            return {'cancelled': False}
        member = current_member.get()
        return {'cancelled': await edge.auth.storage_call(edge.sessions.cancel_entry, member.member_id)}
    @router.post('/import')
    async def import_output(request: Request):
        member = current_member.get()
        payload = await request.json()
        if not isinstance(payload, dict): raise AuthError(422, '请求格式无效')
        path, title = payload.get('path', ''), payload.get('title', '')
        if not isinstance(path, str) or not path or not isinstance(title, str) or not 0 < len(title.strip()) <= 200:
            raise AuthError(422, '请填写工作区文件路径和资产标题')
        slot = edge.slots.get(member.member_id)
        if not slot: raise AuthError(503, '成员运行环境未配置')
        edge._foreground(member.member_id)
        async with edge.client(long=True) as client:
            async with client.post(slot['connector']+'/control/files', json={'path': path}) as response:
                if response.status != 200: raise AuthError(422, '文件不存在、路径不安全或超出大小限制')
                data = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    data.extend(chunk)
                    if len(data) > edge.settings.upload_max_bytes: raise AuthError(413, '文件过大')
        received = False
        async def receive():
            nonlocal received
            if received: return {'type': 'http.disconnect'}
            received = True
            return {'type': 'http.request', 'body': bytes(data), 'more_body': False}
        ext = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
        inferred_type = 'image' if ext in {'png', 'jpg', 'jpeg', 'gif', 'webp'} else ('video' if ext in {'mp4', 'mov', 'webm'} else ('audio' if ext in {'mp3', 'wav', 'ogg', 'flac'} else 'document'))
        asset_type = payload.get('type') or inferred_type
        if asset_type not in {'image', 'audio', 'video', 'document', 'code', 'design'}:
            asset_type = 'document'
        upload_request = Request({**request.scope, 'headers': [(b'x-file-name', quote(path.split('/')[-1], safe='').encode()), (b'x-asset-type', asset_type.encode())]}, receive)
        uploaded = await media.upload(upload_request)
        metadata = media.metadata({'storageAssetId': uploaded['assetId']}, member)
        asset = spaces.create(member.member_id, {'title': title.strip(), 'type': asset_type, 'content': '', 'visibility': 'private',
            'source': 'deepseek_harness', 'mediaMeta': metadata})
        return {'asset': asset}
    return router
