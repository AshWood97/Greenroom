"""Trusted member sidecar. Only mTLS edge can reach the DSH UI carrier."""
import asyncio
import json
import os
import re
import ssl
import stat
import uuid
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web

ROOT = Path(os.environ.get('TLS_DIR', '/etc/greenroom/tls'))
MEMBER = os.environ['MEMBER_ID']
BROKER = os.environ['MODEL_BROKER_URL']
DSH_ORIGIN = os.environ.get('DSH_ORIGIN', 'http://127.0.0.1:3080')
CANVAS_ORIGIN = os.environ.get('CANVAS_ORIGIN', 'http://127.0.0.1:18766')
BRIDGE_ORIGIN = 'http://127.0.0.1:18767'
TOKEN_FILE = Path(os.environ.get('DSH_LAUNCH_FILE', '/run/dsh/launch-token'))
WORKSPACE = os.environ.get('WORKSPACE_DIR', '/workspace')
# One fresh instance identity per process start. A scale-down is confirmed
# against the instance that really holds the work right now, so the id must be
# new on every start: a pid, a stable env value or a pod name would let a
# restarted sidecar reuse a confirmation it can no longer honour.
INSTANCE_ID = str(uuid.uuid4())
# The drain epoch this sidecar currently serves. A drain closes new business
# first, so the epoch is remembered here and an older one is refused.
DRAIN_EPOCH = 0
# The reopen epoch the coordinator is currently holding, learned from the first
# reopen after a drain. It is not assumed to equal the drain epoch: the
# coordinator owns the counter.
REOPEN_EPOCH = 0
ACTIVE_WORK = 0
DSH_VERSION = json.loads(
    (Path(__file__).resolve().parents[2] / 'runtime/dsh/package.json').read_text()
)['dependencies']['@deepseek-ai/dsh']
if os.environ.get('GREENROOM_STANDALONE') == 'true':
    DSH_VERSION = os.environ.get('GREENROOM_DSH_VERSION', DSH_VERSION)
COOKIE = ''
GRANT = ''
STOP_HEADERS = {'host', 'cookie', 'authorization', 'origin', 'connection', 'upgrade', 'content-length', 'transfer-encoding', 'set-cookie', 'content-encoding'}
STATE = web.AppKey('connector_state', dict)


def tls_client():
    ctx = ssl.create_default_context(cafile=str(ROOT/'ca.crt'))
    ctx.load_cert_chain(str(ROOT/'connector.crt'), str(ROOT/'connector.key'))
    return ctx


def tls_server():
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH, cafile=str(ROOT/'ca.crt'))
    ctx.load_cert_chain(str(ROOT/'connector.crt'), str(ROOT/'connector.key'))
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def common_name(request):
    cert = request.transport.get_extra_info('peercert') or {}
    return [value for group in cert.get('subject', ()) for key, value in group if key == 'commonName']


async def client_lifecycle(app):
    state = app.setdefault(STATE, {})
    state['cookie_lock'] = asyncio.Lock()
    broker_tls = tls_client()
    state['clients'] = {
        'short': aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
            connector=aiohttp.TCPConnector(limit=12, limit_per_host=8),
            timeout=aiohttp.ClientTimeout(total=8, sock_connect=3)),
        'ui': aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
            connector=aiohttp.TCPConnector(limit=48, limit_per_host=32),
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=300)),
        'broker_short': aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
            connector=aiohttp.TCPConnector(ssl=broker_tls, limit=12, limit_per_host=12),
            timeout=aiohttp.ClientTimeout(total=30, sock_connect=10)),
        'broker_long': aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
            connector=aiohttp.TCPConnector(ssl=broker_tls, limit=8, limit_per_host=8),
            timeout=aiohttp.ClientTimeout(total=600, sock_connect=10)),
    }
    try:
        yield
    finally:
        for client in state['clients'].values():
            await client.close()


async def canvas_identity(client=None):
    """The canvas backend's own member and instance identity, or None.

    The drain confirmation must name the canvas instance that really holds the
    managed runs, so this is read from the backend itself for every drain. An
    unreadable or foreign answer returns None, which makes its caller refuse
    the confirmation instead of naming a backend that may have restarted.
    """
    if client is None:
        return None
    try:
        async with client.get(CANVAS_ORIGIN+'/api/greenroom/instance',
                timeout=aiohttp.ClientTimeout(total=5, sock_connect=3)) as response:
            if response.status != 200:
                return None
            data = (await response.json()).get('data') or {}
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        return None
    if data.get('member_id') != MEMBER or not isinstance(data.get('instance_id'), str) or not data['instance_id']:
        return None
    return data['instance_id']


async def bridge_identity(client=None):
    """The DSH bridge's own member and instance identity, or None.

    A reopen is confirmed against the instance that really holds the plugin
    work, so this is read from the bridge itself rather than derived from a
    process id or a reachable carrier. An unreadable or foreign answer returns
    None, which makes its caller refuse the confirmation instead of naming an
    instance that may have restarted.
    """
    if client is None:
        return None
    try:
        async with client.get(BRIDGE_ORIGIN+'/lifecycle/instance',
                timeout=aiohttp.ClientTimeout(total=5, sock_connect=3)) as response:
            if response.status != 200:
                return None
            data = await response.json()
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('member_id') != MEMBER \
            or not isinstance(data.get('instance_id'), str) or not data['instance_id']:
        return None
    return data['instance_id']


def drain_body(body):
    """The drain request the edge is allowed to answer for, or None.

    The member, the epoch and this sidecar's own instance must all match. An
    epoch older than the one this process serves is refused: a restart replaced
    the instance, so an old confirmation can no longer be honoured.
    """
    if not isinstance(body, dict):
        return None
    if body.get('member_id') != MEMBER:
        return None
    # The edge names the connector instance it bound, which must be this one.
    if body.get('instance_id') != INSTANCE_ID:
        return None
    epoch = body.get('epoch')
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 1:
        return None
    if epoch < DRAIN_EPOCH or epoch <= REOPEN_EPOCH:
        return None
    return epoch


def reopen_body(body):
    """The reopen request the edge is allowed to answer for, or None.

    A reopen must name the epoch the coordinator currently holds for this
    member, which is the epoch that followed the drain it cancelled. It is
    never assumed to equal the drain epoch this sidecar saw: the coordinator
    owns the epoch counter, so a reopen for an epoch this sidecar has not been
    told about is refused rather than guessed at.
    """
    if not isinstance(body, dict):
        return None
    if body.get('member_id') != MEMBER:
        return None
    if body.get('instance_id') != INSTANCE_ID:
        return None
    epoch = body.get('epoch')
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 1:
        return None
    if (DRAIN_EPOCH and epoch <= DRAIN_EPOCH) or epoch < REOPEN_EPOCH:
        return None
    return epoch



async def refresh_cookie(request, invalidated=None):
    global COOKIE
    async with request.app[STATE]['cookie_lock']:
        if COOKIE and COOKIE != invalidated:
            return COOKIE
        token = (await asyncio.to_thread(TOKEN_FILE.read_text)).strip()
        client = request.app[STATE]['clients']['short']
        async with client.get(DSH_ORIGIN+'/', params={'token': token}, allow_redirects=False) as response:
            if response.status != 303 or not response.headers.getall('Set-Cookie', []):
                raise web.HTTPServiceUnavailable()
            cookie = SimpleCookie()
            for value in response.headers.getall('Set-Cookie'): cookie.load(value)
            COOKIE = '; '.join(name+'='+value.value for name, value in cookie.items())
        return COOKIE


def runtime_grant(value):
    if not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9_-]{30,128}', value) is None:
        raise web.HTTPBadRequest()
    return value


@web.middleware
async def edge_only(request, handler):
    global GRANT
    if common_name(request) != ['greenroom-edge']:
        raise web.HTTPForbidden()
    if 'X-Greenroom-Runtime' in request.headers:
        GRANT = runtime_grant(request.headers['X-Greenroom-Runtime'])
    return await handler(request)


@web.middleware
async def member_admission(request, handler):
    """Close new business, not original-task reads or archive recovery."""
    global ACTIVE_WORK
    if request.path.startswith('/control/') and request.path != '/control/prewarm':
        return await handler(request)
    recovery = request.method in {'GET', 'HEAD'} or (
        request.method == 'POST' and request.path in {'/api/media/uploads', '/api/media/stable-uploads'}) or (
        request.method == 'DELETE' and (request.path == '/internal/memory/admit' or bool(re.fullmatch(
            r'/creative/api/render/jobs/(lemo-opuscar|take-one|hypit)/[A-Za-z0-9_-]+/[a-f0-9-]+', request.path))))
    if DRAIN_EPOCH and (not recovery or request.headers.get('Upgrade', '').lower() == 'websocket'):
        raise web.HTTPServiceUnavailable()
    ACTIVE_WORK += 1
    try:
        return await handler(request)
    finally:
        ACTIVE_WORK -= 1


async def health(request):
    try:
        cookie = await refresh_cookie(request)
        client = request.app[STATE]['clients']['short']
        async with client.get(DSH_ORIGIN+'/', headers={'Cookie': cookie}, allow_redirects=False) as response:
            if response.status in {401, 403}:
                await refresh_cookie(request, invalidated=cookie)
            elif response.status >= 400:
                raise web.HTTPServiceUnavailable()
        return web.json_response({'ready': True, 'version': DSH_VERSION})
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, web.HTTPException):
        return web.json_response({'ready': False}, status=503)


async def grant(request):
    global GRANT
    body = await request.json()
    GRANT = runtime_grant(body.get('grant', ''))
    return web.Response(status=204)


async def prewarm(request):
    if not request.headers.get('X-Greenroom-Runtime'):
        raise web.HTTPUnauthorized()
    client = request.app[STATE]['clients']['short']
    async with client.post(BRIDGE_ORIGIN+'/lifecycle/prewarm',
            timeout=aiohttp.ClientTimeout(total=170, sock_connect=3)) as response:
        await response.read()
        return web.Response(status=204 if response.status < 300 else 503)


async def member_work(request):
    """Whether this member still has any unfinished business work.

    The bridge already aggregates every plugin's in-flight requests and
    durable tasks; the canvas backend reports its own managed runs. An
    unreadable answer stays busy so member sleep never drops a live task.
    """
    try:
        client = request.app[STATE]['clients']['short']
        async with client.get(BRIDGE_ORIGIN+'/lifecycle/work',
                timeout=aiohttp.ClientTimeout(total=10, sock_connect=3)) as response:
            if response.status != 200:
                return web.json_response({'busy': True})
            bridge = await response.json()
            plugins = bridge.get('plugins', [])
        async with client.get(CANVAS_ORIGIN+'/api/greenroom/lifecycle',
                timeout=aiohttp.ClientTimeout(total=10, sock_connect=3)) as response:
            # The canvas backend wraps its payload, so an unreadable or foreign
            # body must not be mistaken for an idle answer.
            canvas = ((await response.json()).get('data') or {}) if response.status == 200 else {'busy': True}
        # A failed runtime can still own an original task or an unreadable
        # durable store; process health alone never proves that work finished.
        busy = ACTIVE_WORK > 0 or any(item.get('lifecycle') in {'starting', 'busy'}
                   or item.get('activeRequests') or item.get('work', {}).get('known') is False
                   or item.get('work', {}).get('busy')
                   for item in plugins if isinstance(item, dict)) or canvas.get('busy') is not False
        result = {'busy': busy, 'render_inventory': bridge.get('render_inventory')}
        if os.environ.get('MEMBER_MEMORY_ENABLED', '').strip().lower() in {'1', 'true', 'yes', 'on'}:
            result['plugins'] = [{'id': item.get('id'), 'lifecycle': item.get('lifecycle'),
                                  'activeRequests': item.get('activeRequests'), 'work': item.get('work'),
                                  'memory': item.get('memory')}
                                 for item in plugins if isinstance(item, dict)]
            result['memory_enabled'] = bridge.get('memory_enabled') is True
        return web.json_response(result)
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        return web.json_response({'busy': True})


async def instance(request):
    """This member's three component identities, reported by the components.

    The edge reads this before a drain epoch is opened, so the epoch binds the
    instances that really exist now. Each identity comes from the component
    itself over loopback — the connector's own process id, and the bridge's and
    canvas backend's own reports — rather than from a label, a pod name or a
    value the edge would have to invent. A component that cannot be reached is
    absent, which makes its caller refuse the drain.
    """
    client = request.app[STATE]['clients']['short']
    bridge = await bridge_identity(client)
    canvas = await canvas_identity(client)
    return web.json_response({
        'member_id': MEMBER,
        'components': {
            'connector': INSTANCE_ID,
            'bridge': bridge,
            'canvas': canvas,
        },
    })


async def plugin_memory_control(request):
    """Forward one fixed member/plugin drain without closing other work."""
    if os.environ.get('MEMBER_MEMORY_ENABLED', '').strip().lower() not in {'1', 'true', 'yes', 'on'}:
        raise web.HTTPNotFound()
    try:
        body = await request.json()
        if (not isinstance(body, dict) or set(body) != {'member_id', 'plugin_id', 'pod_uid', 'instance_id', 'epoch'}
                or body['member_id'] != MEMBER or not MEMBER
                or not isinstance(body['plugin_id'], str) or not re.fullmatch(r'[a-z0-9-]{1,64}', body['plugin_id'])
                or not isinstance(body['pod_uid'], str) or not body['pod_uid']
                or not isinstance(body['instance_id'], str) or not body['instance_id']
                or type(body['epoch']) is not int or body['epoch'] < 1):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise web.HTTPBadRequest()
    phase = request.match_info['phase']
    if phase not in {'drain', 'reopen'}:
        raise web.HTTPNotFound()
    client = request.app[STATE]['clients']['short']
    try:
        async with client.post(BRIDGE_ORIGIN + '/lifecycle/memory/' + phase, json=body,
                timeout=aiohttp.ClientTimeout(total=10, sock_connect=3)) as response:
            result = await response.json()
            if response.status != 200 or not isinstance(result, dict):
                raise web.HTTPConflict()
            for key in ('member_id', 'plugin_id', 'pod_uid', 'instance_id', 'epoch'):
                if result.get(key) != body[key]:
                    raise web.HTTPConflict()
            if phase == 'drain':
                current = result.get('memory_current_bytes')
                if result.get('closed') is not True or result.get('idle') is not True \
                        or type(current) is not int or current <= 0:
                    raise web.HTTPConflict()
            elif result.get('opened') is not True:
                raise web.HTTPConflict()
            return web.json_response(result, headers={'Cache-Control': 'no-store'})
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        raise web.HTTPServiceUnavailable()


def component_receipt(body, epoch, instance_id, *flags):
    """Preserve the component's own identity, never relabel its acknowledgement."""
    if not isinstance(body, dict) or set(body) != {'member_id', 'epoch', 'instance_id', *flags}:
        return None
    if body.get('member_id') != MEMBER or type(body.get('epoch')) is not int \
            or body['epoch'] != epoch or body.get('instance_id') != instance_id:
        return None
    return body if all(body.get(flag) is True for flag in flags) else None


def canvas_receipt(body, epoch, instance_id, *flags):
    # The managed Canvas handle wraps success/data and includes confirmed.
    if not isinstance(body, dict) or body.get('success') is not True:
        return None
    data = body.get('data')
    if not isinstance(data, dict) or data.get('confirmed') is not True:
        return None
    return component_receipt({key: value for key, value in data.items() if key != 'confirmed'},
                             epoch, instance_id, *flags)


async def drain_epoch(request):
    global DRAIN_EPOCH
    epoch = drain_body(await request.json())
    if epoch is None:
        return web.json_response({'member_id': MEMBER, 'epoch': 0, 'components': {},
                                  'closed': False, 'idle': False}, status=409)
    # Admission closes before any asynchronous component/idle inspection.
    DRAIN_EPOCH = epoch
    failed = {'member_id': MEMBER, 'epoch': epoch, 'components': {}, 'closed': False, 'idle': False}
    client = request.app[STATE]['clients']['short']
    bridge = await bridge_identity(client)
    canvas = await canvas_identity(client)
    if bridge is None or canvas is None or DRAIN_EPOCH != epoch or REOPEN_EPOCH >= epoch:
        return web.json_response(failed)
    try:
        async with client.post(BRIDGE_ORIGIN+'/lifecycle/drain',
                json={'member_id': MEMBER, 'epoch': epoch, 'instance_id': bridge},
                timeout=aiohttp.ClientTimeout(total=10, sock_connect=3)) as response:
            bridge_body = component_receipt(await response.json(), epoch, bridge, 'closed', 'idle') if response.status == 200 else None
        if bridge_body is None or DRAIN_EPOCH != epoch or REOPEN_EPOCH >= epoch:
            return web.json_response(failed)
        async with client.post(CANVAS_ORIGIN+'/api/greenroom/drain',
                json={'member_id': MEMBER, 'epoch': epoch, 'instance_id': canvas},
                timeout=aiohttp.ClientTimeout(total=10, sock_connect=3)) as response:
            canvas_body = canvas_receipt(await response.json(), epoch, canvas, 'closed', 'idle') if response.status == 200 else None
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        return web.json_response(failed)
    if canvas_body is None or DRAIN_EPOCH != epoch or REOPEN_EPOCH >= epoch:
        return web.json_response(failed)
    components = {
        'connector': {'member_id': MEMBER, 'epoch': epoch, 'instance_id': INSTANCE_ID,
                      'closed': True, 'idle': ACTIVE_WORK == 0},
        'bridge': bridge_body, 'canvas': canvas_body,
    }
    return web.json_response({'member_id': MEMBER, 'epoch': epoch, 'components': components,
                              'closed': True, 'idle': ACTIVE_WORK == 0})


async def reopen_epoch(request):
    global DRAIN_EPOCH, REOPEN_EPOCH
    epoch = reopen_body(await request.json())
    if epoch is None:
        return web.json_response({'member_id': MEMBER, 'epoch': 0, 'components': {},
                                  'opened': False}, status=409)
    REOPEN_EPOCH = epoch
    failed = {'member_id': MEMBER, 'epoch': epoch, 'components': {}, 'opened': False}
    client = request.app[STATE]['clients']['short']
    bridge = await bridge_identity(client)
    canvas = await canvas_identity(client)
    if bridge is None or canvas is None or REOPEN_EPOCH != epoch or DRAIN_EPOCH >= epoch:
        return web.json_response(failed, status=503)
    try:
        async with client.post(BRIDGE_ORIGIN+'/lifecycle/reopen',
                json={'member_id': MEMBER, 'epoch': epoch, 'instance_id': bridge},
                timeout=aiohttp.ClientTimeout(total=10, sock_connect=3)) as response:
            bridge_body = component_receipt(await response.json(), epoch, bridge, 'opened') if response.status == 200 else None
        if bridge_body is None or REOPEN_EPOCH != epoch or DRAIN_EPOCH >= epoch:
            return web.json_response(failed, status=503)
        async with client.post(CANVAS_ORIGIN+'/api/greenroom/reopen',
                json={'member_id': MEMBER, 'epoch': epoch, 'instance_id': canvas},
                timeout=aiohttp.ClientTimeout(total=10, sock_connect=3)) as response:
            canvas_body = canvas_receipt(await response.json(), epoch, canvas, 'opened') if response.status == 200 else None
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        return web.json_response(failed, status=503)
    if canvas_body is None or REOPEN_EPOCH != epoch or DRAIN_EPOCH >= epoch:
        return web.json_response(failed, status=503)
    # Only the still-current operation may open admission after real receipts.
    DRAIN_EPOCH = 0
    components = {
        'connector': {'member_id': MEMBER, 'epoch': epoch, 'instance_id': INSTANCE_ID, 'opened': True},
        'bridge': bridge_body, 'canvas': canvas_body,
    }
    return web.json_response({'member_id': MEMBER, 'epoch': epoch, 'components': components, 'opened': True})


async def ready_runtime(request):
    try:
        if not TOKEN_FILE.is_file():
            raise web.HTTPServiceUnavailable()
        target = urlsplit(DSH_ORIGIN)
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(target.hostname, target.port or 80), 2)
        writer.close()
        await writer.wait_closed()
        client = request.app[STATE]['clients']['short']
        async with client.get(BRIDGE_ORIGIN+'/health') as response:
            if response.status != 200 or (await response.json()).get('ready') is not True:
                raise web.HTTPServiceUnavailable()
        return web.json_response({'ready': True})
    except (OSError, asyncio.TimeoutError, aiohttp.ClientError, ValueError, web.HTTPException):
        return web.json_response({'ready': False}, status=503)


async def ready_canvas(request):
    try:
        client = request.app[STATE]['clients']['short']
        async with client.get(CANVAS_ORIGIN+'/api/status') as response:
            return web.json_response({'ready': response.status == 200}, status=200 if response.status == 200 else 503)
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return web.json_response({'ready': False}, status=503)


async def export_file(request):
    body = await request.json()
    path = body.get('path', '')
    if not isinstance(path, str) or not path or len(path) > 1024 or path.startswith('/') or any(part in {'', '.', '..'} for part in path.split('/')):
        raise web.HTTPBadRequest()
    # Open every component without following symlinks. The agent can race file
    # renames, but cannot turn a checked path into a secret outside its workspace.
    fd = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = path.split('/')
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 50*1024*1024:
                raise web.HTTPBadRequest()
            with os.fdopen(file_fd, 'rb', closefd=False) as file:
                data = file.read(50*1024*1024+1)
            if len(data) > 50*1024*1024: raise web.HTTPRequestEntityTooLarge(max_size=50*1024*1024, actual_size=len(data))
            return web.Response(body=data, content_type='application/octet-stream')
        finally: os.close(file_fd)
    except OSError:
        raise web.HTTPNotFound()
    finally: os.close(fd)


async def ui(request):
    return await proxy_ui(request, DSH_ORIGIN, await refresh_cookie(request))


async def canvas_ui(request):
    return await proxy_ui(request, CANVAS_ORIGIN, '')


async def proxy_ui(request, origin, cookie):
    path = request.match_info['path']
    url = origin+'/'+path
    if request.query_string: url += '?'+request.query_string
    headers = {k: v for k, v in request.headers.items() if k.lower() not in STOP_HEADERS and not k.lower().startswith(('x-greenroom-', 'sec-fetch-'))}
    headers.update({'Host': origin.removeprefix('http://'), 'Origin': origin, 'Accept-Encoding': 'identity'})
    if origin == CANVAS_ORIGIN:
        for name in ('X-Greenroom-Canvas-Keys', 'X-Greenroom-Canvas-Configured'):
            if name in request.headers:
                headers[name] = request.headers[name]
    if cookie:
        headers['Cookie'] = cookie
    client = request.app[STATE]['clients']['ui']
    if request.headers.get('Upgrade', '').lower() == 'websocket':
        protocols = tuple(value.strip() for header in request.headers.getall('Sec-WebSocket-Protocol', ())
                          for value in header.split(',') if value.strip())
        headers = {key: value for key, value in headers.items() if key.lower() != 'sec-websocket-protocol'}
        try:
            upstream = await client.ws_connect(url, headers=headers, protocols=protocols, max_msg_size=16*1024*1024, heartbeat=20)
        except aiohttp.WSServerHandshakeError as exc:
            if origin != DSH_ORIGIN or exc.status not in {401, 403}:
                raise
            headers['Cookie'] = await refresh_cookie(request, invalidated=cookie)
            upstream = await client.ws_connect(url, headers=headers, protocols=protocols, max_msg_size=16*1024*1024, heartbeat=20)
        async with upstream:
            browser = web.WebSocketResponse(protocols=(upstream.protocol,) if upstream.protocol else (), max_msg_size=16*1024*1024)
            await browser.prepare(request)
            async def pipe(source, target):
                async for message in source:
                    if message.type == aiohttp.WSMsgType.TEXT: await target.send_str(message.data)
                    elif message.type == aiohttp.WSMsgType.BINARY: await target.send_bytes(message.data)
                    else: return
            tasks = [asyncio.create_task(pipe(browser, upstream)), asyncio.create_task(pipe(upstream, browser))]
            try: await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            return browser
    upstream = await client.request(request.method, url,
        data=request.content.iter_chunked(65536) if request.can_read_body else None,
        headers=headers, allow_redirects=False)
    if origin == DSH_ORIGIN and upstream.status in {401, 403}:
        headers['Cookie'] = await refresh_cookie(request, invalidated=cookie)
        if request.method in {'GET', 'HEAD'}:
            upstream.release()
            upstream = await client.request(request.method, url, headers=headers, allow_redirects=False)
    async with upstream:
        response_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in STOP_HEADERS}
        if upstream.content_length is not None and upstream.headers.get('Content-Encoding', 'identity').lower() == 'identity':
            response_headers['Content-Length'] = str(upstream.content_length)
        response = web.StreamResponse(status=upstream.status, headers=response_headers)
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(65536): await response.write(chunk)
        await response.write_eof()
        return response


async def model(request):
    if not GRANT: raise web.HTTPUnauthorized()
    scoped = re.fullmatch(r'/plugin/([a-z0-9-]+)(/.*)', request.path)
    path = scoped[2] if scoped else request.path
    media_upload = request.method == 'POST' and path in {'/api/media/uploads', '/api/media/stable-uploads'}
    media_read = request.method == 'GET' and path.startswith('/api/media/') and bool(
        path.removeprefix('/api/media/')) and '/' not in path.removeprefix('/api/media/')
    media_operation = request.method == 'GET' and bool(re.fullmatch(
        r'/api/media/upload-operations/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}', path))
    recovery = request.method == 'GET' and (
        path == '/canvas/api/proxy/video/query' or any(
            path.startswith(prefix) and path[len(prefix):] and '/' not in path[len(prefix):]
            for prefix in ('/canvas/api/proxy/image/status/', '/canvas/api/greenroom/tasks/')))
    plugin_settings = request.method == 'GET' and path.startswith('/creative/api/plugins/') and path.endswith('/settings') and '/' not in path.removeprefix('/creative/api/plugins/').removesuffix('/settings')
    aid_business = path.startswith('/creative/aid/') and request.method in {'GET', 'POST'}
    render_business = (request.method == 'POST' and path == '/creative/api/render/jobs') or (
        request.method in {'GET', 'DELETE'} and bool(re.fullmatch(
            r'/creative/api/render/jobs/(lemo-opuscar|take-one|hypit)/[A-Za-z0-9_-]+/[a-f0-9-]+', path)))
    reference_ids = request.query.getall('reference_id', [])
    usage_receipt = (request.method == 'GET' and path == '/creative/api/usage/receipts'
        and len(reference_ids) == 1 and 1 <= len(reference_ids[0]) <= 256
        and not any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in reference_ids[0]))
    allowed = {('GET', '/v1/models'), ('POST', '/v1/chat/completions'),
               ('GET', '/creative/api/models'), ('GET', '/creative/api/skill-catalog'), ('POST', '/creative/api/tts/submit'),
               ('POST', '/creative/api/music/submit'), ('POST', '/creative/api/embeddings'), ('POST', '/creative/api/rerank'),
               ('GET', '/canvas/api/greenroom/models'), ('GET', '/canvas/api/greenroom/huobao-models'),
               ('POST', '/canvas/api/proxy/image/submit'),
               ('POST', '/canvas/api/proxy/video/submit'),
               ('POST', '/canvas/api/greenroom/runninghub/submit')}
    allowed.add(('POST', '/v1/responses'))
    if not recovery and not plugin_settings and not aid_business and not render_business and not usage_receipt and not media_read and not media_upload and not media_operation and (request.method, path) not in allowed:
        raise web.HTTPNotFound()
    headers = {'X-Greenroom-Runtime': GRANT, 'Content-Type': 'application/json'}
    plugin = scoped[1] if scoped else request.headers.get('X-Greenroom-Plugin')
    if plugin:
        headers['X-Greenroom-Plugin'] = plugin

    if aid_business and request.headers.get('Content-Type'):
        headers['Content-Type'] = request.headers['Content-Type']
    if media_upload:
        for name in ('Content-Type', 'Content-Length', 'X-File-Name', 'X-Asset-Type', 'X-Greenroom-Archive-Key', 'X-Greenroom-Archive-SHA256',
                     'X-Greenroom-Archive-Operation', 'X-Greenroom-Archive-Target'):
            if name in request.headers:
                headers[name] = request.headers[name]
    if (media_read or (aid_business and request.method == 'GET')) and request.headers.get('Range'):
        headers['Range'] = request.headers['Range']
    if request.method == 'POST' and path in {'/canvas/api/proxy/image/submit', '/canvas/api/proxy/video/submit', '/canvas/api/greenroom/runninghub/submit', '/creative/api/tts/submit', '/creative/api/music/submit'}:
        submission = request.headers.get('X-T8-Provider-Submission')
        if submission:
            headers['X-T8-Provider-Submission'] = submission
    short = request.method == 'GET' and not media_read and not aid_business and not media_operation
    client = request.app[STATE]['clients']['broker_short' if short else 'broker_long']
    async with client.request(request.method, BROKER + (request.rel_url.raw_path_qs.removeprefix('/plugin/' + scoped[1]) if scoped else request.rel_url.raw_path_qs), data=request.content.iter_chunked(65536), headers=headers, allow_redirects=False) as upstream:
        response_headers = {'Content-Type': upstream.headers.get('Content-Type', 'application/json')}
        if request.method == 'POST' and path in {'/v1/chat/completions', '/v1/responses'}:
            if upstream.headers.get('X-Request-ID'):
                response_headers['X-Request-ID'] = upstream.headers['X-Request-ID']
        if usage_receipt or media_operation:
            response_headers['Cache-Control'] = 'no-store'
        if media_read or (aid_business and request.method == 'GET'):
            response_headers.update({k: v for k, v in upstream.headers.items() if k.lower() in {
                'content-length', 'content-range', 'accept-ranges', 'cache-control',
                'content-disposition', 'x-content-type-options', 'content-security-policy'}})
        response = web.StreamResponse(status=upstream.status, headers=response_headers)
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(65536): await response.write(chunk)
        await response.write_eof()
        return response


async def memory_admit(request):
    """Forward only the member's local memory admission on its mTLS channel."""
    if os.environ.get('MEMBER_MEMORY_ENABLED', '').strip().lower() not in {'1', 'true', 'yes', 'on'}:
        raise web.HTTPNotFound()
    body = bytearray()
    async for chunk in request.content.iter_chunked(1024):
        body.extend(chunk)
        if len(body) > 1024:
            raise web.HTTPRequestEntityTooLarge(max_size=1024, actual_size=len(body))
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        raise web.HTTPBadRequest()
    if (not isinstance(payload, dict) or set(payload) != {'podUid', 'pluginId'}
            or not all(isinstance(payload[key], str) and payload[key] for key in payload)):
        raise web.HTTPBadRequest()
    client = request.app[STATE]['clients']['broker_short']
    async with client.request(request.method, BROKER + '/internal/memory/admit', json=payload) as upstream:
        try:
            data = await upstream.json()
        except (ValueError, aiohttp.ContentTypeError):
            raise web.HTTPServiceUnavailable()
        return web.json_response(data, status=upstream.status, headers={'Cache-Control': 'no-store'})


async def main():
    edge = web.Application(middlewares=[edge_only, member_admission], client_max_size=50*1024*1024)
    edge[STATE] = {}
    edge.cleanup_ctx.append(client_lifecycle)
    edge.router.add_get('/control/health', health)
    edge.router.add_post('/control/grant', grant)
    edge.router.add_post('/control/prewarm', prewarm)
    edge.router.add_get('/control/work', member_work)
    edge.router.add_get('/control/instance', instance)
    edge.router.add_post('/control/memory/{phase}', plugin_memory_control)
    edge.router.add_post('/control/drain', drain_epoch)
    edge.router.add_post('/control/reopen', reopen_epoch)
    edge.router.add_post('/control/files', export_file)
    edge.router.add_route('*', '/ui/{path:.*}', ui)
    edge.router.add_route('*', '/canvas/{path:.*}', canvas_ui)
    broker = web.Application(middlewares=[member_admission], client_max_size=48*1024*1024)
    broker[STATE] = edge[STATE]
    broker.router.add_post('/internal/memory/admit', memory_admit)
    broker.router.add_delete('/internal/memory/admit', memory_admit)
    broker.router.add_route('*', '/{path:.*}', model)
    probes = web.Application()
    probes[STATE] = edge[STATE]
    probes.router.add_get('/ready/runtime', ready_runtime)
    probes.router.add_get('/ready/canvas', ready_canvas)
    runners = []
    try:
        for app, host, port, context in [(edge, '0.0.0.0', 8443, tls_server()),
                (broker, '127.0.0.1', 3081, None), (probes, '0.0.0.0', 18768, None)]:
            runner = web.AppRunner(app, access_log=None)
            runners.append(runner)
            await runner.setup()
            await web.TCPSite(runner, host, port, ssl_context=context).start()
        await asyncio.Event().wait()
    finally:
        for runner in reversed(runners):
            await runner.cleanup()

if __name__ == '__main__': asyncio.run(main())
