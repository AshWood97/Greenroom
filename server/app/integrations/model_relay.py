"""mTLS model broker, outside agent containers. No gateway secret reaches DSH."""
import asyncio
from contextlib import AsyncExitStack
from http.cookiejar import CookieJar, DefaultCookiePolicy
import json
import os
import re
import ssl
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import quote, unquote

import aiohttp
import httpx
from aiohttp import web

from app.identity.auth import AuthClient, AuthError, current_member
from app.core.config import load_settings
from app.governance.governance_store import GovernanceStore, ModelUsage
from app.workspace.harness_sessions import HarnessSessions
from app.workspace.member_memory import MemberMemory, memory_bytes
from app.identity.identity_store import IdentityStore
from app.identity.internal_sessions import InternalSessionStore
from app.workspace.canvas import CanvasService, GENERATION_FIELDS, SubmissionRejected, generation_error_text
from app.creative.creative import CreativeService, creative_plugin
from app.governance.provider_routing import (
    LUNA_PROFILE, chat_to_responses, normalize_official_openai_chat, resolve_provider,
    response_as_chat, response_event_as_chat, text_reasoning,
)
from app.creative.creative_render import CreativeRender
from app.creative.creative_catalog import runtime_manifests
from app.assets.media import MediaService
from app.assets.spaces import SpaceStore


def peer_member(request):
    certificate = request.transport.get_extra_info('peercert') or {}
    values = [value for group in certificate.get('subject', ()) for key, value in group if key == 'commonName']
    if len(values) != 1 or not values[0].startswith('user_'):
        raise AuthError(403, 'Invalid connector identity')
    return values[0]


async def _aid_export_probe_urls(payload, client, aid_url, headers, media, identity, native_reference_mapper=None):
    # Only the relay may supply these private reads to AID.
    payload.pop('_greenroomVideoProbeUrls', None)
    probes = {}
    groups = payload.get('groups')
    if not isinstance(groups, list):
        return
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('storyboardId'), int):
            continue
        urls = group.get('videoUrls')
        if not isinstance(urls, list) or len(urls) != 1 or not isinstance(urls[0], str):
            continue
        path = urls[0]
        prefix = '/creative-managed/media/'
        if not path.startswith(prefix) or path in probes:
            continue
        asset_id = unquote(path.removeprefix(prefix))
        if not asset_id or '/' in asset_id or '?' in asset_id or '#' in asset_id:
            continue
        response = await client.post(aid_url + '/api/user/storyboard/record/list',
                                     json={'storyboardId': group['storyboardId']}, headers=headers)
        if not response.is_success:
            continue
        try:
            data = response.json()
        except ValueError:
            continue
        records = data.get('data') if isinstance(data, dict) and data.get('code') == 200 else None
        if not isinstance(records, list):
            continue
        if any(isinstance(record, dict) and record.get('fileUrl') == path
               and (record.get('videoDuration') is None or
                    isinstance(record.get('videoDuration'), (int, float)) and record['videoDuration'] <= 0)
               for record in records):
            signed = await media.reference_url(identity, asset_id)
            probes[path] = native_reference_mapper(signed) if native_reference_mapper else signed
    if probes:
        payload['_greenroomVideoProbeUrls'] = probes


async def _aid_managed_download(request, upstream, business_path, media, identity):
    if request.method != 'POST' or business_path != '/api/user/episode/export/download':
        return None
    asset_id = upstream.headers.get('X-Greenroom-Managed-Asset')
    if asset_id is None:
        return None
    if (upstream.status_code != 200 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', asset_id)
            or upstream.headers.get('Content-Type', '').split(';')[0].lower() != 'video/mp4'
            or not upstream.headers.get('content-disposition', '').startswith('attachment;')
            or not upstream.headers.get('download-filename')
            or await upstream.aread()):
        raise AuthError(502, 'AID 成片下载响应无效')
    row = media.store.get(asset_id)
    if row['owner_id'] != identity.member_id or row['state'] != 'ready':
        raise AuthError(404, '媒体不存在或无权访问')
    if row['mime'] != 'video/mp4':
        raise AuthError(422, 'AID 成片格式无效')
    context = current_member.set(identity)
    content = None
    failure = None
    try:
        content = await media.serve(asset_id, request)
        headers = dict(content.headers)
        # Keep native safe attachment names, but never its empty-pointer content length
        # or the private pointer header. MediaService owns type/length/security headers.
        for key in ('content-disposition', 'download-filename'):
            if value := upstream.headers.get(key):
                headers[key] = value
        response = web.StreamResponse(status=content.status_code, headers=headers)
        await response.prepare(request)
        async for chunk in content.body_iterator:
            await response.write(chunk)
        await response.write_eof()
        return response
    except BaseException as exc:
        failure = exc
        raise
    finally:
        try:
            if content is not None:
                try:
                    await content.body_iterator.aclose()
                finally:
                    if content.background is not None:
                        await content.background()
        except BaseException:
            if failure is None:
                raise
        finally:
            current_member.reset(context)


def create_relay(settings, *, auth=None, sessions=None, transport=None, backend_transport=None,
                 governance=None, revalidate_interval=25, aid_native_reference_mapper=None):
    root = Path(settings.data_dir)
    owns_auth = auth is None
    auth = auth or AuthClient(settings, IdentityStore(root/'identities.sqlite3'), InternalSessionStore(root/'internal-sessions.sqlite3'))
    session_call = auth.storage_call if owns_auth else asyncio.to_thread
    sessions = sessions or HarnessSessions(root/'harness.sqlite3', settings.runtime_session_key)
    store = governance or GovernanceStore(root/'admin_governance.sqlite3')
    active = {}
    # This broker is a separate process sharing the web's harness.sqlite3, so it
    # reads the same switch to decide whether real work must be admitted before
    # it is forwarded. With the switch off nothing scales a member down, so the
    # original forwarding behaviour stands.
    memory_enabled = os.environ.get('MEMBER_MEMORY_ENABLED', '').strip().lower() in {'1', 'true', 'yes', 'on'}
    media = MediaService(settings, SpaceStore(root/'greenroom.sqlite3', seed=False), transport=backend_transport)
    canvas = CanvasService(settings, None, media, transport=backend_transport, governance=store)
    creative = CreativeService(canvas)
    render = CreativeRender()
    memory = MemberMemory(sessions, render, settings.runtime_slots) if memory_enabled else None
    clients = {}
    @web.middleware
    async def errors(request, handler):
        try:
            return await handler(request)
        except AuthError as exc:
            if request.path.startswith(('/canvas/api/', '/creative/')):
                result = {'success': False, 'error': exc.message}
                if isinstance(exc, SubmissionRejected) or request.get('greenroom_submission_not_sent'):
                    result.update(submitted=False, code='greenroom.submission_not_sent')
                return web.json_response(result, status=exc.status, headers={'Cache-Control': 'no-store'})
            return web.json_response({'error': {'message': exc.message}}, status=exc.status)
        except (aiohttp.ClientError, asyncio.TimeoutError, httpx.HTTPError):
            if request.path.startswith('/creative/'):
                return web.json_response({'success': False, 'error': '无法连接创作服务，未自动重新提交'},
                                         status=502, headers={'Cache-Control': 'no-store'})
            return web.json_response({'error': {'message': 'Model gateway unavailable'}}, status=502)
        except web.HTTPRequestEntityTooLarge:
            return web.json_response({'error': {'message': '模型请求超出 48 MiB 限制', 'code': 'request_too_large'}}, status=413)

    app = web.Application(client_max_size=48*1024*1024, middlewares=[errors])

    async def client_lifecycle(app):
        async with AsyncExitStack() as cleanup:
            if owns_auth:
                await auth.start()
                cleanup.push_async_callback(auth.aclose)
            await store.start(settings, transport=backend_transport)
            cleanup.push_async_callback(store.aclose)
            for service in (media, canvas):
                await service.start()
                cleanup.push_async_callback(service.aclose)
            cleanup.push_async_callback(creative.close)
            clients['upstream'] = await cleanup.enter_async_context(aiohttp.ClientSession(
                trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
                timeout=aiohttp.ClientTimeout(total=600, sock_connect=10),
                connector=transport or aiohttp.TCPConnector(limit=120, limit_per_host=90)))
            clients['catalog'] = await cleanup.enter_async_context(httpx.AsyncClient(
                trust_env=False, timeout=20, follow_redirects=False,
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=()))))
            yield

    app.cleanup_ctx.append(client_lifecycle)

    async def memory_admit(request):
        """A connector may reserve only its own Pod's installed plugin."""
        if memory is None:
            raise web.HTTPNotFound()
        member_id = peer_member(request)
        if member_id not in (settings.runtime_slots or {}):
            raise AuthError(403, '成员运行环境未配置')
        body = bytearray()
        async for chunk in request.content.iter_chunked(1024):
            body.extend(chunk)
            if len(body) > 1024:
                raise web.HTTPRequestEntityTooLarge(max_size=1024, actual_size=len(body))
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict) or set(payload) != {'podUid', 'pluginId'}:
                raise ValueError()
            pod_uid, plugin_id = payload['podUid'], payload['pluginId']
            if (not isinstance(pod_uid, str) or str(uuid.UUID(pod_uid)) != pod_uid
                    or not isinstance(plugin_id, str) or not re.fullmatch(r'[a-z0-9-]{1,64}', plugin_id)):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise AuthError(400, '内存申请格式无效')
        manifests = runtime_manifests()
        allowed = {item['id'] for item in manifests if item.get('runtime', {}).get('lifecycle')
                   and not item.get('deployment', {}).get('shared')}
        if plugin_id != 'huobao' and plugin_id not in allowed:
            raise AuthError(403, '插件运行环境未配置')
        container = 'dsh' if plugin_id == 'huobao' else plugin_id
        operation = 'plugin:' + pod_uid + ':' + container
        if request.method == 'DELETE':
            cancelled = await asyncio.to_thread(sessions.cancel_memory_wait, operation, member_id)
            return web.json_response({'cancelled': cancelled}, headers={'Cache-Control': 'no-store'})
        def waiting():
            return web.json_response({'admitted': False, 'waiting': True, 'retry_after_ms': 2000},
                                     status=202, headers={'Cache-Control': 'no-store'})
        if not await asyncio.to_thread(sessions.memory_active):
            return waiting()
        if not await asyncio.to_thread(sessions.memory_admissible, member_id, pod_uid, container):
            try:
                await memory.reconcile_replacement(member_id, expected_uid=pod_uid)
            except (AuthError, httpx.HTTPError, OSError, ValueError):
                pass
            if not await asyncio.to_thread(sessions.memory_admissible, member_id, pod_uid, container):
                return waiting()
        if plugin_id == 'huobao':
            # Huobao shares the DSH cgroup, already charged to the base lease.
            return web.json_response({'admitted': True}, headers={'Cache-Control': 'no-store'})
        claim = await asyncio.to_thread(sessions.memory_claim, operation)
        if claim is None:
            try:
                deployment = await render.read_deployment(member_id)
            except AuthError:
                return waiting()
            containers = deployment.get('spec', {}).get('template', {}).get('spec', {}).get('containers', [])
            values = [item.get('resources', {}) for item in containers if item.get('name') == container]
            try:
                if len(values) != 1:
                    raise ValueError()
                targets = json.loads(os.environ.get('MEMBER_MEMORY_TARGETS', '{}'))
                if not isinstance(targets, dict):
                    raise ValueError()
                desired = memory_bytes(targets[plugin_id])
                base = memory_bytes(values[0]['requests']['memory'])
                configured = json.loads(os.environ.get('MEMBER_MEMORY_MINIMUMS', '{}'))
                if not isinstance(configured, dict):
                    raise ValueError()
                minimum = memory_bytes(configured[plugin_id]) if plugin_id in configured else desired
                if not base <= minimum <= desired:
                    raise ValueError()
            except (KeyError, TypeError, ValueError):
                raise AuthError(503, '插件内存需求尚未配置')
            try:
                result = await memory.reserve_container(operation, member_id, container, desired, minimum,
                                                        expected_uid=pod_uid)
            except AuthError as exc:
                if exc.status == 403:
                    raise
                return waiting()
            except (httpx.HTTPError, OSError):
                return waiting()
            if result['decision'] == 'wait':
                return waiting()
            claim = result['claim']
        if (claim['member'] != member_id or claim['kind'] != 'container'
                or claim['resource_id'] != pod_uid or claim['resource_name'] != container
                or not await asyncio.to_thread(sessions.memory_admissible, member_id, pod_uid, container)):
            return waiting()
        result = await memory.apply_container(operation)
        if result['decision'] != 'applied':
            return waiting()
        return web.json_response({'admitted': True}, headers={'Cache-Control': 'no-store'})

    app.router.add_post('/internal/memory/admit', memory_admit)
    app.router.add_delete('/internal/memory/admit', memory_admit)

    # Real business work on this broker: each of these either submits new work
    # or holds a long-lived connection. A background catalog, settings or task
    # query is not work and never extends a member's idle window.
    def work_kind(path, method):
        if method == 'POST' and path in {'/v1/chat/completions', '/canvas/api/proxy/image/submit',
                                         '/canvas/api/proxy/video/submit', '/creative/api/tts/submit',
                                         '/creative/api/music/submit', '/creative/api/embeddings',
                                         '/creative/api/rerank', '/canvas/api/greenroom/runninghub/submit',
                                         '/creative/api/render/jobs', '/api/media/uploads', '/api/media/stable-uploads'}:
            return 'broker'
        if method == 'GET' and re.fullmatch(r'/creative/api/render/jobs/([a-z0-9-]+)/([A-Za-z0-9_-]+)/([a-f0-9-]+)', path):
            return 'broker'
        return None

    async def relay(request):
        request['greenroom_submission_not_sent'] = (request.method == 'POST' and request.path in {
            '/canvas/api/proxy/image/submit', '/canvas/api/proxy/video/submit',
            '/creative/api/tts/submit', '/creative/api/music/submit'})
        member_id = peer_member(request)
        grant = request.headers.get('X-Greenroom-Runtime', '')
        active_memory = memory is not None and await asyncio.to_thread(sessions.memory_active)
        resolved = await session_call(sessions.resolve, grant, member_id=member_id,
                                      **({'include_admission': True} if active_memory else {}))
        main, expected = resolved[:2]
        identity = await auth.verify(main)
        if identity.member_id != expected:
            raise AuthError(403, 'Runtime identity mismatch')
        # Real work is admitted on the shared coordination table before it is
        # forwarded, so a scale-down in the web process sees it. A member that
        # is reopening or still starting is not admitted, and its request is
        # never forwarded: business waits for the real gate rather than reaching
        # a component that has not reopened. With the feature off the original
        # behaviour stands, because nothing scales a member down.
        operation = None
        kind = work_kind(request.path, request.method) if settings.member_sleep_enabled or active_memory else None
        if kind is not None:
            if active_memory:
                entry = await asyncio.to_thread(sessions.entry, member_id)
                if not entry or entry['state'] != 'active':
                    if resolved[2]:
                        raise AuthError(503, '成员运行环境正在排队，请稍后重试')
                    uid, name, cap = await memory.resident(member_id)
                    if not await asyncio.to_thread(sessions.adopt_entry, member_id, uid, name, cap):
                        raise AuthError(503, '成员运行环境正在准备，请稍后重试')
            decision = await asyncio.to_thread(sessions.admit_work, member_id, kind, '', 0,
                                               require_entry=active_memory)
            if decision.get('decision') != 'admitted':
                raise AuthError(503, '成员运行环境正在准备，请稍后重试')
            operation = decision['operation_id']
        request['greenroom_submission_not_sent'] = False
        try:
            return await _relay(request, identity, member_id, grant, main)
        finally:
            if operation:
                await asyncio.to_thread(sessions.finish_work, operation)

    async def _relay(request, identity, member_id, grant, main):
        if request.path == '/creative/api/usage/receipts' and request.method == 'GET':
            reference_ids = request.query.getall('reference_id', [])
            if (len(reference_ids) != 1 or not 1 <= len(reference_ids[0]) <= 256
                    or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in reference_ids[0])):
                raise AuthError(400, '用量引用无效')
            receipt = await store.gateway_receipt(settings, identity.member_id, reference_ids[0],
                                                  transport=backend_transport)
            if receipt is None:
                raise AuthError(404, '当前成员尚无该用量记录')
            return web.json_response({'success': True, 'data': receipt}, headers={'Cache-Control': 'no-store'})
        if request.path == '/creative/api/skill-catalog' and request.method == 'GET':
            response = await clients['catalog'].get('https://shortdramaskills.com/data.json')
            if response.status_code != 200:
                raise AuthError(502, f'Skill 目录暂不可用（HTTP {response.status_code}），使用随包目录')
            try:
                data = response.json()
            except ValueError:
                raise AuthError(502, 'Skill 目录返回格式无效，使用随包目录')
            return web.json_response({'success': True, 'data': data}, headers={'Cache-Control': 'no-store'})
        if request.path == '/creative/api/render/jobs' and request.method == 'POST':
            minimum = None
            active_memory = memory is not None and await asyncio.to_thread(sessions.memory_active)
            if active_memory and os.environ.get('MEMBER_MEMORY_RENDER_MINIMUM'):
                try:
                    minimum = memory_bytes(os.environ['MEMBER_MEMORY_RENDER_MINIMUM'])
                except ValueError:
                    raise AuthError(503, '渲染内存需求尚未配置')
            payload = await request.json()
            result = (await render.submit(identity.member_id, payload, memory=memory, memory_minimum=minimum)
                      if active_memory else await render.submit(identity.member_id, payload))
            return web.json_response({'success': True, **result}, status=202 if result.get('waiting_memory') else 200,
                                     headers={'Cache-Control': 'no-store'})
        render_match = re.fullmatch(r'/creative/api/render/jobs/([a-z0-9-]+)/([A-Za-z0-9_-]+)/([a-f0-9-]+)', request.path)
        if render_match and request.method == 'DELETE':
            cancelled = await render.cancel_wait(identity.member_id, *render_match.groups(), memory=memory)
            return web.json_response({'success': True, 'cancelled': cancelled}, headers={'Cache-Control': 'no-store'})
        if render_match and request.method == 'GET':
            active_memory = memory is not None and await asyncio.to_thread(sessions.memory_active)
            result = (await render.status(identity.member_id, *render_match.groups(), memory=memory)
                      if active_memory else await render.status(identity.member_id, *render_match.groups()))
            return web.json_response({'success': True, **result},
                                     headers={'Cache-Control': 'no-store'})
        if request.path.startswith('/creative/aid/'):
            path = request.path.removeprefix('/creative/aid')
            ui_prefix = '/plugins/aid-studio'
            ui_api = path.startswith(ui_prefix + '/url/')
            ui_page = (path == ui_prefix or path.startswith(ui_prefix + '/')) and not ui_api
            business_path = path.removeprefix(ui_prefix + '/url') if ui_api else path
            compose = re.fullmatch(r'/greenroom/compose/aid:[0-9]+/(run|status|output)', path)
            compose_operation = compose.group(1) if compose else None
            private_compose = (compose_operation == 'run' and request.method == 'POST') or (
                compose_operation in {'status', 'output'} and request.method == 'GET')
            if request.method == 'POST' and business_path == '/api/user/oss/upload':
                if not request.content_type.startswith('multipart/'):
                    raise AuthError(422, 'AID 素材上传需要 multipart 文件')
                reader = await request.multipart()
                uploaded = []
                total = 0
                while part := await reader.next():
                    if part.name != 'files' or not part.filename:
                        await part.release()
                        continue
                    with tempfile.TemporaryFile() as source:
                        size = 0
                        while chunk := await part.read_chunk(256 * 1024):
                            size += len(chunk)
                            total += len(chunk)
                            if total > 48 * 1024 * 1024:
                                raise AuthError(413, '单次素材上传超出 48 MiB 限制')
                            source.write(chunk)
                        source.seek(0)
                        async def chunks():
                            while chunk := source.read(256 * 1024):
                                yield chunk
                        mime = part.headers.get('Content-Type', 'application/octet-stream').split(';')[0]
                        asset_type = mime.split('/')[0] if mime.split('/')[0] in {'image', 'video', 'audio'} else 'document'
                        metadata = await media.upload_runtime(identity, chunks(), filename=part.filename,
                            size=size, asset_type=asset_type, mime=mime)
                        uploaded.append({'url': '/creative-managed/media/' + quote(metadata['assetId'], safe=''),
                            'fileName': metadata['fileName'], 'originalFileName': part.filename,
                            'fileSize': metadata['fileSize']})
                if not uploaded:
                    raise AuthError(422, '请选择需要上传的素材')
                return web.json_response({'code': 200, 'msg': '上传成功', 'data': uploaded, 'count': len(uploaded)},
                                         headers={'Cache-Control': 'no-store'})
            business = ('/api/user/project', '/api/user/episode', '/api/user/script',
                        '/api/user/asset', '/api/user/task', '/api/user/model', '/api/user/storyboard')
            decoded = unquote(path)
            if ('\\' in decoded or any(part in {'.', '..', ''} for part in decoded.strip('/').split('/'))
                    or not ((ui_page and request.method == 'GET')
                            or private_compose
                            or (request.method == 'POST' and any(business_path == prefix or business_path.startswith(prefix + '/')
                             for prefix in business))
                            or (request.method == 'GET' and business_path.startswith('/api/user/task/stream/'))
                            or (not ui_api and not ui_page and (request.method, path) in {
                                ('GET', '/greenroom/pending'), ('POST', '/greenroom/task-update'), ('POST', '/greenroom/models')})
                            or (request.method, business_path) in {
                                ('POST', '/api/user/step/status'),
                                ('POST', '/api/user/step/advance'),
                                ('POST', '/api/user/profile'), ('POST', '/api/user/balance'),
                                ('POST', '/api/user/music/generate'),
                                ('POST', '/api/user/voice-library/list'), ('POST', '/api/user/voice-library/tags'),
                                ('POST', '/api/user/voice/preview'),
                                ('POST', '/api/user/dict/enum/list'),
                                ('POST', '/api/user/prompt/official/category/list'),
                                ('POST', '/api/user/prompt/official/item/list'),
                                ('POST', '/api/user/prompt/official/item/detail'),
                                ('POST', '/aid/agent/info'), ('POST', '/aid/agent/list')})):
                raise AuthError(404, 'AID 业务操作不可用')
            aid_headers = {'X-Greenroom-Member': identity.member_id, 'Content-Type': 'application/json',
                           'Accept-Encoding': 'identity'}
            if request.method == 'GET' and request.headers.get('Range'):
                aid_headers['Range'] = request.headers['Range']
            body = await request.read()
            if compose_operation == 'run' and private_compose:
                try:
                    payload = json.loads(body)
                except ValueError as exc:
                    raise AuthError(422, 'AID 合成素材请求格式无效') from exc
                if (not isinstance(payload, dict) or set(payload) != {'inputs'}
                        or not isinstance(payload['inputs'], list)
                        or any(not isinstance(value, str) for value in payload['inputs'])):
                    raise AuthError(422, 'AID 合成请求仅接受原任务的 inputs 素材数组')
                references = []
                for value in payload['inputs']:
                    if value.startswith('/creative-managed/media/'):
                        value = '/api/media/' + value.removeprefix('/creative-managed/media/')
                    if not value.startswith('/api/media/'):
                        raise AuthError(422, 'AID 合成仅支持已归档的当前成员素材')
                    references.append(value)
                # Signing verifies each owner. Only this internal job request sees
                # the signed reads; the original project keeps its managed URLs.
                payload['serverUrls'] = await canvas.references(identity, references)
                if aid_native_reference_mapper:
                    # The test-only native consumer needs signed storage, not a
                    # development gateway fixture URL. Keep the full Canvas
                    # validation first, then sign the same canonical Asset IDs.
                    if len(payload['serverUrls']) != len(references) or any(
                            not re.fullmatch(r'/api/media/[A-Za-z0-9][A-Za-z0-9_-]*', value)
                            for value in references):
                        raise AuthError(422, 'AID 测试合成仅接受规范的原成员素材标识')
                    signed = [await media.reference_url(identity, value.removeprefix('/api/media/'))
                              for value in references]
                    payload['serverUrls'] = [aid_native_reference_mapper(url) for url in signed]
                body = json.dumps(payload).encode('utf-8')
            async with canvas.client() as client:
                aid_url = os.environ.get('CREATIVE_AID_URL', 'http://greenroom-aid:18807').rstrip('/')
                if request.method == 'POST' and business_path.rstrip('/') == '/api/user/episode/export':
                    try:
                        payload = json.loads(body)
                    except ValueError:
                        payload = None
                    if isinstance(payload, dict):
                        await _aid_export_probe_urls(payload, client, aid_url, aid_headers, media, identity, aid_native_reference_mapper)
                        body = json.dumps(payload).encode('utf-8')
                async with client.stream(request.method,
                        aid_url + path,
                        params=request.query, content=body,
                        headers=aid_headers) as upstream:
                    if not upstream.is_success:
                        body = await upstream.aread()
                        raise AuthError(upstream.status_code, generation_error_text(body.decode('utf-8', errors='replace'),
                            status=upstream.status_code))
                    download = await _aid_managed_download(request, upstream, business_path, media, identity)
                    if download is not None:
                        return download
                    if 'json' in upstream.headers.get('Content-Type', ''):
                        raw = await upstream.aread()
                        try:
                            data = json.loads(raw)
                        except ValueError as exc:
                            raise AuthError(502, 'AID 服务返回非 JSON 响应') from exc
                        if isinstance(data, dict) and (data.get('success') is False
                                or data.get('code') not in {None, 0, 200, '200'}):
                            data = {'code': data.get('code'), 'msg': generation_error_text(data,
                                    status=upstream.status_code), 'data': None}
                        return web.json_response(data, status=upstream.status_code, headers={'Cache-Control': 'no-store'})
                    response_headers = {
                        'Content-Type': upstream.headers.get('Content-Type', 'application/json'),
                        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'}
                    response_headers.update({key: value for key, value in upstream.headers.items()
                        if key.lower() in {'content-length', 'content-range', 'accept-ranges', 'content-disposition'}})
                    response = web.StreamResponse(status=upstream.status_code, headers=response_headers)
                    await response.prepare(request)
                    async for chunk in upstream.aiter_bytes(65536):
                        await response.write(chunk)
                    await response.write_eof()
                    return response
        if request.method == 'POST' and request.path in {'/api/media/uploads', '/api/media/stable-uploads'}:
            operation_id = request.headers.get('X-Greenroom-Archive-Operation')
            operation_target = request.headers.get('X-Greenroom-Archive-Target')
            if request.path == '/api/media/stable-uploads':
                if operation_id is None or operation_target is None:
                    raise AuthError(422, '稳定归档需要操作标识和目标')
                if request.headers.get('X-Greenroom-Archive-Key') is not None or request.headers.get('X-Greenroom-Archive-SHA256') is not None:
                    raise AuthError(422, '归档键与归档操作不能同时使用')
            elif operation_id is not None or operation_target is not None:
                raise AuthError(422, '稳定归档需要使用专用上传入口')
            try:
                size = int(request.headers.get('Content-Length', ''))
            except ValueError as exc:
                raise AuthError(411, '上传缺少有效文件大小') from exc
            result = await media.upload_runtime(identity, request.content.iter_chunked(256 * 1024),
                filename=unquote(request.headers.get('X-File-Name', '')), size=size,
                asset_type=request.headers.get('X-Asset-Type', 'document'),
                mime=request.headers.get('Content-Type', 'application/octet-stream').split(';')[0],
                archive_key=request.headers.get('X-Greenroom-Archive-Key'),
                content_sha256=request.headers.get('X-Greenroom-Archive-SHA256'),
                operation_id=operation_id, operation_target=operation_target)
            return web.json_response(result, headers={'Cache-Control': 'no-store'})
        if request.method == 'GET' and request.path.startswith('/api/media/upload-operations/'):
            operation_id = request.path.removeprefix('/api/media/upload-operations/')
            result = await media.upload_operation(identity, operation_id)
            return web.json_response(result, headers={'Cache-Control': 'no-store'})
        if request.method == 'GET' and request.path.startswith('/api/media/'):
            asset_id = request.path.removeprefix('/api/media/')
            if not asset_id or '/' in asset_id:
                raise AuthError(404, '媒体不存在或无权访问')
            row = media.store.get(asset_id)
            if row['owner_id'] != identity.member_id:
                raise AuthError(404, '媒体不存在或无权访问')
            context = current_member.set(identity)
            try:
                content = await media.serve(asset_id, request)
                response = web.StreamResponse(status=content.status_code, headers=dict(content.headers))
                await response.prepare(request)
                async for chunk in content.body_iterator:
                    await response.write(chunk)
                await response.write_eof()
                return response
            finally:
                current_member.reset(context)
        plugin_id = request.headers.get('X-Greenroom-Plugin') or None
        if plugin_id and plugin_id not in ('t8', 'huobao'):
            creative_plugin(plugin_id)
        result = None
        if request.method == 'GET' and request.path == '/creative/api/models':
            result = await creative.models(identity, plugin_id=plugin_id)
        elif request.method == 'GET' and request.path.startswith('/creative/api/plugins/') and request.path.endswith('/settings'):
            plugin_id = request.path.removeprefix('/creative/api/plugins/').removesuffix('/settings')
            if '/' in plugin_id:
                raise AuthError(404, '创作插件不存在')
            result = await creative.plugin_settings(identity, plugin_id)
        elif request.method == 'POST' and request.path in {'/creative/api/tts/submit', '/creative/api/music/submit',
                                                         '/creative/api/embeddings', '/creative/api/rerank'}:
            try:
                payload = await request.json()
            except ValueError as exc:
                raise SubmissionRejected(422, '创作请求格式无效') from exc
            if request.path == '/creative/api/tts/submit':
                result = await creative.submit_tts(identity, payload, request.headers.get('X-T8-Provider-Submission'), plugin_id)
            elif request.path == '/creative/api/music/submit':
                result = await creative.submit_music(identity, payload, request.headers.get('X-T8-Provider-Submission'))
            else:
                data = await (creative.embeddings(identity, payload, plugin_id) if request.path.endswith('/embeddings')
                              else creative.rerank(identity, payload, plugin_id))
                return web.json_response(data, headers={'Cache-Control': 'no-store'})
        elif request.method == 'GET' and request.path == '/canvas/api/greenroom/models':
            result = await canvas.models(identity, plugin_id)
        elif request.method == 'GET' and request.path == '/canvas/api/greenroom/huobao-models':
            result = await canvas.huobao_models(identity)
        elif request.method == 'POST' and request.path == '/canvas/api/greenroom/runninghub/submit':
            result = await canvas.runninghub_submit(identity, request, request.headers.get('X-T8-Provider-Submission'))
        elif request.method == 'POST' and request.path in {
                '/canvas/api/proxy/image/submit', '/canvas/api/proxy/video/submit'}:
            try:
                payload = await request.json()
            except ValueError as exc:
                raise SubmissionRejected(422, '生成请求格式无效') from exc
            kind = 'image' if request.path == '/canvas/api/proxy/image/submit' else 'video'
            if not isinstance(payload, dict) or set(payload) - GENERATION_FIELDS:
                raise SubmissionRejected(422, '创作工具仅支持平台生成参数和授权参考素材')
            task_id = await canvas.submit(identity, kind, payload, request.headers.get('X-T8-Provider-Submission'),
                                          source='managed-chat', plugin_id=plugin_id)
            result = {'taskId': task_id, 'kind': kind, 'status': 'pending'}
        elif request.method == 'GET' and request.path.startswith('/canvas/api/greenroom/tasks/'):
            task_id = request.path.removeprefix('/canvas/api/greenroom/tasks/')
            if not task_id or '/' in task_id:
                raise AuthError(404, 'Model operation unavailable')
            row = canvas.task(identity, task_id)
            result = await creative.poll_audio(identity, task_id) if row['kind'] == 'tts' else await canvas.poll(identity, task_id, unified=True)
        elif request.method == 'GET' and request.path.startswith('/canvas/api/proxy/image/status/'):
            task_id = request.path.removeprefix('/canvas/api/proxy/image/status/')
            if not task_id or '/' in task_id:
                raise AuthError(404, 'Model operation unavailable')
            result = await canvas.poll(identity, task_id)
        elif request.method == 'GET' and request.path == '/canvas/api/proxy/video/query':
            result = await canvas.poll(identity, request.query.get('taskId', ''))
        if result is not None:
            return web.json_response({'success': True, 'data': result}, headers={'Cache-Control': 'no-store'})
        allowed = {('GET', '/v1/models'), ('POST', '/v1/chat/completions')}
        responses = request.path == '/v1/responses'
        if responses:
            allowed.add(('POST', '/v1/responses'))
        if (request.method, request.path) not in allowed:
            raise AuthError(404, 'Model operation unavailable')

        if request.method == 'GET':
            models = [{'id': model['id'], 'object': 'model',
                       'owned_by': model.get('provider_label', 'greenroom')}
                      for model in (await canvas.models(identity, plugin_id))['llm']]
            return web.json_response({'object': 'list', 'data': models}, headers={'Cache-Control': 'no-store'})

        body = await request.read()
        target_provider = None
        target_model = None
        modality = "llm"
        provider_type = "internal_gateway"
        provider_id = None
        parameters_dict = {}
        default_gateway = None
        adapt_responses = False

        if request.method == 'POST':
            try:
                payload = json.loads(body)
            except ValueError:
                raise AuthError(422, 'Invalid model request')

            if not isinstance(payload, dict) or not payload.get('model'):
                raise AuthError(403, 'Model is not authorized')
            requested_model = payload['model']
            if not isinstance(requested_model, str):
                raise AuthError(422, '模型 ID 无效')
            route = resolve_provider(store, 'llm', requested_model, plugin_id)
            profile = store.gateway_model_profiles().get(requested_model, LUNA_PROFILE if requested_model == 'gpt-6-luna' else {})
            if route:
                target_provider, target_model, model_config = route
                adapt_responses = bool(plugin_id and not responses and model_config.get('protocol') == 'openai-responses')
                if not adapt_responses and responses != (model_config.get('protocol') == 'openai-responses'):
                    raise AuthError(422, '此模型须使用供应商配置的文字协议')
                provider_type, provider_id = 'external_provider', target_provider['id']
                profile = model_config.get('profile', {})
            if responses:
                if not route:
                    default_gateway = store.gateway_settings(settings, bind=True)
                    if not canvas.local_openai(default_gateway):
                        raise AuthError(403, '当前默认网关未接入 Responses')
                    target_model = await canvas.resolve_submission_model(identity, 'llm', requested_model)
                tools = payload.get('tools', [])
                if (any(payload.get(field) for field in ('conversation', 'previous_response_id', 'background'))
                        or not isinstance(tools, list)
                        or any(not isinstance(tool, dict) or tool.get('type') != 'function' for tool in tools)):
                    raise AuthError(422, 'OpenAI Responses requires local conversation state and DSH function tools')
                items = payload.get('input')
                if isinstance(items, list):
                    payload['input'] = await canvas.chat_messages(identity, items, responses=True)
                elif not isinstance(items, str):
                    raise AuthError(422, 'Missing model input')
                payload['model'] = target_model
                payload['store'] = False
                text_reasoning(payload, profile, True)
                body = json.dumps(payload).encode('utf-8')
                provider_type = 'external_provider'
            else:
                if not isinstance(payload.get('messages'), list):
                    raise AuthError(422, 'Missing model messages')
                resolved_messages = await canvas.chat_messages(identity, payload['messages'])
                if resolved_messages != payload['messages']:
                    payload = {**payload, 'messages': resolved_messages}
                    body = json.dumps(payload).encode('utf-8')

                if not route:
                    target_model = await canvas.resolve_submission_model(identity, 'llm', requested_model)
                    default_gateway = store.gateway_settings(settings, bind=True)
                payload['model'] = target_model
                if adapt_responses:
                    payload = chat_to_responses(payload)
                elif default_gateway and canvas.local_openai(default_gateway):
                    normalize_official_openai_chat(payload)
                text_reasoning(payload, profile, adapt_responses)
                if payload.get('stream') and not route:
                    payload['stream_options'] = {**(payload.get('stream_options') or {}), 'include_usage': True}
                body = json.dumps(payload).encode('utf-8')

        if active.get(member_id, 0) >= 3:
            raise AuthError(429, 'Member model concurrency exceeded')
        active[member_id] = active.get(member_id, 0) + 1

        if target_provider:
            upstream_base = target_provider["baseUrl"].rstrip("/")
            upstream_path = '/responses' if adapt_responses else request.path.removeprefix('/v1')
            headers = {
                "Authorization": f"Bearer {target_provider['apiKey']}",
                "Content-Type": "application/json",
                "Accept-Encoding": "identity",
            }
        else:
            gateway = default_gateway or store.gateway_settings(settings, bind=request.method != "GET")
            upstream_base = gateway.gateway_service_url.rstrip("/")
            upstream_path = request.path
            headers = canvas.headers(identity, asset_scope=False, gateway=gateway)
            headers['Content-Type'] = 'application/json'
            headers['Accept-Encoding'] = 'identity'

        async def revalidate():
            while True:
                await asyncio.sleep(revalidate_interval)
                await session_call(sessions.resolve, grant, member_id=member_id)
                await auth.verify(main)

        start_time = time.time()
        settlement_log_id = None

        try:
            async with clients['upstream'].request(
                    request.method,
                    upstream_base + upstream_path,
                    data=body,
                    headers=headers,
                    allow_redirects=False,
                ) as upstream:
                if target_provider and upstream.status >= 400:
                    try:
                        details = await upstream.json()
                    except (ValueError, aiohttp.ClientError):
                        details = None
                    raise AuthError(upstream.status, generation_error_text(details, status=upstream.status,
                                                                          secrets=(target_provider['apiKey'],)))
                response = web.StreamResponse(
                    status=upstream.status,
                    headers={
                        'Content-Type': upstream.headers.get('Content-Type', 'application/json'),
                        'Cache-Control': 'no-store',
                        'X-Accel-Buffering': 'no',
                        **({'X-Request-ID': upstream.headers['X-Request-ID']}
                           if upstream.headers.get('X-Request-ID') else {}),
                    },
                )
                await response.prepare(request)
                usage = ModelUsage(upstream.headers.get('X-Request-ID'))
                is_sse = 'text/event-stream' in upstream.headers.get('Content-Type', '')
                json_body = bytearray()
                completed = False

                async def forward():
                    nonlocal completed
                    if adapt_responses and is_sse:
                        async for line in upstream.content:
                            usage.feed(line)
                            if not line.startswith(b'data:'):
                                continue
                            try:
                                event = json.loads(line[5:])
                            except ValueError:
                                continue
                            choice = response_event_as_chat(event, target_model)
                            if choice:
                                await response.write(b'data: ' + json.dumps(choice).encode() + b'\n\n')
                        if usage.stream_complete:
                            await response.write(b'data: [DONE]\n\n')
                    else:
                        async for chunk in upstream.content.iter_chunked(65536):
                            if is_sse:
                                usage.feed(chunk)
                            else:
                                json_body.extend(chunk)
                            if not adapt_responses:
                                await response.write(chunk)
                    if not is_sse:
                        try:
                            data = json.loads(json_body)
                            usage.observe(data)
                            if adapt_responses:
                                await response.write(json.dumps(response_as_chat(data)).encode())
                        except ValueError:
                            pass
                    completed = not is_sse or usage.stream_complete
                    await response.write_eof()

                tasks = [asyncio.create_task(forward()), asyncio.create_task(revalidate())]
                try:
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        try:
                            task.result()
                        except AuthError:
                            response.force_close()
                            request.transport.close()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    if target_model:
                        settlement_log_id = await asyncio.to_thread(store.record_usage,
                            log_id='chat_' + usage.reference_id
                                if provider_type == 'internal_gateway' and usage.reference_id else None,
                            member_id=member_id,
                            modality=modality,
                            model=target_model,
                            provider_type=provider_type,
                            provider_id=provider_id,
                            prompt_tokens=usage.prompt_tokens,
                            completion_tokens=usage.completion_tokens,
                            total_tokens=usage.total_tokens,
                            parameters=parameters_dict,
                            duration_ms=int((time.time() - start_time) * 1000),
                            source='managed-chat', reference_id=usage.reference_id,
                            status='failed' if upstream.status >= 400 else 'success' if completed else 'interrupted',
                        )
                return response
        finally:
            active[member_id] -= 1
            if settlement_log_id is not None:
                store.schedule_gateway_charge_refresh(settings, transport=backend_transport, log_id=settlement_log_id)

    app.router.add_route('*', '/{path:.*}', relay)
    return app


def main():
    settings = load_settings()
    root = Path(settings.runtime_tls_dir)
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH, cafile=str(root/'ca.crt'))
    context.load_cert_chain(str(root/'broker.crt'), str(root/'broker.key'))
    context.verify_mode = ssl.CERT_REQUIRED
    web.run_app(create_relay(settings), host='0.0.0.0', port=8444, ssl_context=context, access_log=None)

if __name__ == '__main__':
    main()
