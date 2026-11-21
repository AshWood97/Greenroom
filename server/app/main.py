"""greenroom API: closed roster, shared room, server-held gateway key."""

from __future__ import annotations

import asyncio
import os
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from json import JSONDecodeError, loads
from typing import Optional

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import aiohttp
import httpx

from app.governance.admin import admin_router
from app.workspace.canvas import CanvasService, canvas_router
from app.identity.auth import AuthClient, AuthError, AuthenticationMiddleware, auth_router, current_member
from app.core.config import load_settings, validate_settings
from app.integrations.feishu import FeishuService, feishu_router
from app.governance.governance_store import GovernanceStore
from app.assets.media import MediaService, media_router
from app.workspace.harness import HarnessEdge, MemberComponents, RuntimeOriginMiddleware, harness_router
from app.workspace.harness_sessions import HarnessSessions
from app.workspace.member_sleep import MemberSleep
from app.workspace.member_memory import MemberMemory, memory_bytes
from app.identity.identity_store import IdentityStore
from app.identity.internal_sessions import InternalSessionStore
from app.integrations.proxy import proxy_router
from app.core.roster import directory
from app.assets.spaces import SpaceStore
from app.governance.usage import usage_router
from app.creative.creative_render import CreativeRender
from app.creative.creative_catalog import runtime_manifests

PACKAGE_VERSION = loads((Path(__file__).resolve().parents[2] / "package.json").read_text())["version"]
PRODUCT_VERSION = "v" + ".".join(part if index == 0 else part.zfill(2)
                                 for index, part in enumerate(PACKAGE_VERSION.split(".")))


async def _member_idle(harness, member_id):
    """No live workbench WebSocket and no in-flight request for this member."""
    return not harness.sockets.get(member_id, 0) and not harness.busy_members.get(member_id, 0)


async def _member_busy(harness, canvas, render, member_id, media=None, memory=None):
    """Any unfinished generation, poll, render or member-side task blocks sleep.

    The member sidecar aggregates its plugins, T8 and huobao; the host holds
    the generation ledger and the isolated render Jobs. An unreadable answer
    stays busy instead of being treated as idle, and no original task is ever
    resubmitted to reach a quiet state.
    """
    if canvas.member_pending(member_id):
        return True
    slot = harness.slots.get(member_id) or {}
    inventory = None
    if slot.get('connector'):
        try:
            async with harness.client() as client:
                async with client.get(slot['connector'] + '/control/work') as response:
                    if response.status != 200:
                        return True
                    work = await response.json()
                    if work.get('busy') is not False:
                        return True
                    inventory = work.get('render_inventory')
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
            return True
    options = {'inventory': inventory, 'media_store': media.store if media is not None else None}
    if memory is not None and harness.sleep.memory_active():
        options['memory'] = memory
    return await render.member_busy(member_id, **options)


async def _warm_idle_members(harness, sleep, memory, limit, *, busy):
    """Retain recent member-owned Pods only while a spare admission fits."""
    if memory is None or not sleep.memory_active() or limit <= 0:
        return set()
    candidates = await asyncio.to_thread(harness.sessions.warm_candidates, sleep.idle_ms, limit=limit)
    warm = set()
    for candidate in candidates:
        member, uid = candidate['member'], candidate['pod_uid']
        try:
            if not await _member_idle(harness, member) or await busy(member):
                continue
            snapshot, pod = await memory.snapshot(member)
            ready = pod and any(item.get('type') == 'Ready' and item.get('status') == 'True'
                                for item in pod.get('status', {}).get('conditions', []))
            if (ready and pod.get('metadata', {}).get('uid') == uid
                    and await asyncio.to_thread(harness.sessions.keep_warm, member, uid, snapshot,
                                                sleep.idle_ms, limit)):
                warm.add(member)
        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, KeyError, TypeError, ValueError):
            continue
    return warm


async def _memory_plugins(harness, member_id):
    slot = harness.slots.get(member_id) or {}
    if not slot.get('connector'):
        return []
    try:
        async with harness.client() as client:
            async with client.get(slot['connector'] + '/control/work') as response:
                if response.status != 200:
                    return []
                data = await response.json()
        if data.get('memory_enabled') is not True:
            return []
        return [item for item in data.get('plugins', []) if isinstance(item, dict)]
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError, TypeError, ValueError):
        return []


def _stopped_memory(item, plugin_id, epoch=None):
    work = item.get('work') or {}
    memory = item.get('memory') or {}
    current = memory.get('memory_current_bytes')
    if (item.get('id') != plugin_id or item.get('lifecycle') != 'sleeping' or item.get('activeRequests') != 0
            or work.get('known') is not True or work.get('busy') is not False
            or memory.get('plugin_id') != plugin_id or not memory.get('pod_uid')
            or not memory.get('instance_id') or not isinstance(current, int) or isinstance(current, bool)
            or current <= 0 or memory.get('drain_epoch') != (0 if epoch is None else epoch)):
        return None
    return memory


async def _plugin_stopped(harness, member_id, plugin_id, epoch=None):
    try:
        plugins = [item for item in await _memory_plugins(harness, member_id) if item.get('id') == plugin_id]
        if len(plugins) != 1:
            return None
        return _stopped_memory(plugins[0], plugin_id, epoch)
    except (TypeError, ValueError):
        return None


def create_app(settings=None, *, transport=None, store: Optional[SpaceStore] = None, identities: Optional[IdentityStore] = None) -> FastAPI:
    settings = settings or load_settings()
    validate_settings(settings)
    data_dir = Path(settings.data_dir)
    spaces = store or SpaceStore(data_dir / "greenroom.sqlite3",
                                 seed=settings.environment != "production" and not settings.standalone,
                                 standalone=settings.standalone)
    identity_store = identities or IdentityStore(data_dir / "identities.sqlite3")
    session_store = InternalSessionStore(data_dir / "internal-sessions.sqlite3")
    auth = AuthClient(settings, identity_store, session_store, transport=transport)
    harness_sessions = HarnessSessions(data_dir / 'harness.sqlite3', settings.runtime_session_key)
    governance = GovernanceStore(data_dir / 'admin_governance.sqlite3')
    render = CreativeRender()
    harness = HarnessEdge(settings, auth, harness_sessions, governance=governance)
    # The three real member-side components the drain protocol confirms against.
    # Without them no instance can be named, so no drain opens.
    components = MemberComponents(harness)
    sleep = MemberSleep(settings, render, sessions=harness_sessions, components=components)
    memory_enabled = os.environ.get('MEMBER_MEMORY_ENABLED', '').strip().lower() in {'1', 'true', 'yes', 'on'}
    memory = MemberMemory(harness_sessions, render, settings.runtime_slots) if memory_enabled else None
    sleep.memory = memory
    harness.sleep = sleep
    auth.runtime_revoke = harness.revoke
    auth.runtime_prewarm = harness.schedule_prewarm
    media = MediaService(settings, spaces, transport=transport)
    canvas = CanvasService(settings, harness, media, transport=transport, governance=governance)
    feishu = FeishuService(data_dir)
    @asynccontextmanager
    async def lifespan(app):
        async with AsyncExitStack() as cleanup:
            for service in (auth, governance, media, canvas, harness):
                if service is governance:
                    await service.start(settings, transport=transport)
                else:
                    await service.start()
                cleanup.push_async_callback(service.aclose)
            def migrate():
                spaces.migrate_to_single_space()
                for storage_id in spaces.bound_storage_ids():
                    media.store.update(storage_id, desired='public')
            await asyncio.to_thread(migrate)
            sleep.reset()
            if sleep.enabled or memory_enabled:
                await sleep.observe(initial=True, memory=memory_enabled)
            async def retry():
                while True:
                    await media.retry_pending()
                    await asyncio.sleep(30)
            task = asyncio.create_task(retry())
            warm_limit = getattr(settings, 'member_warm_idle_limit', 4)
            async def idle_members():
                # Only this controller decides sleep, and only after the whole
                # member environment (workbench sockets, in-flight calls and
                # every durable task) is confirmed idle.
                while True:
                    await asyncio.sleep(60)
                    if not sleep.enabled and not memory_enabled:
                        continue
                    await sleep.observe(memory=memory_enabled)
                    # An unresolved scale from before a restart converges on
                    # its own operation first, so no new drain or wake can be
                    # layered on top of one whose result is still unknown.
                    if sleep.enabled or sleep.memory_active():
                        await sleep.recover_scales()
                    if memory is not None and sleep.memory_active():
                        for member_id in settings.runtime_slots:
                            entry = await asyncio.to_thread(harness_sessions.entry, member_id)
                            if not entry or entry['state'] != 'active':
                                continue
                            try:
                                await memory.reconcile_replacement(member_id)
                            except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, TypeError, ValueError):
                                continue
                        for marker in await asyncio.to_thread(harness_sessions.plugin_reclaims):
                            await memory.reconcile_plugin_reclaim(marker['operation'], components)
                        scoped = {marker['operation'] for marker in
                                  await asyncio.to_thread(harness_sessions.plugin_reclaims)}
                        try:
                            configured = loads(os.environ.get('MEMBER_MEMORY_BASE_LIMITS', '{}'))
                            if not isinstance(configured, dict):
                                configured = None
                        except (TypeError, ValueError):
                            configured = None
                        if configured is not None:
                            for claim in await asyncio.to_thread(harness_sessions.memory_claims):
                                if (claim['operation'] in scoped or (claim['state'] == 'reclaiming'
                                        and await asyncio.to_thread(harness_sessions.plugin_reclaim, claim['operation']))):
                                    continue
                                member_id = claim['member']
                                try:
                                    busy = lambda member=member_id: _member_busy(harness, canvas, render, member, media, memory)
                                    if claim['kind'] == 'job':
                                        await memory.reclaim_job(claim['operation'], busy=busy)
                                    elif await memory.retire_replaced_container(claim['operation'], sleep):
                                        continue
                                    elif claim['state'] == 'reclaiming':
                                        await memory.reconcile_reclaim(claim['operation'], sleep)
                                    elif claim['state'] in {'reserved', 'unknown'}:
                                        if claim['sent']:
                                            await memory.apply_container(claim['operation'])
                                        else:
                                            await asyncio.to_thread(harness_sessions.cancel_memory_reservation, claim['operation'])
                                    elif claim['state'] == 'active':
                                        container = claim['resource_name']
                                        plugin = 'huobao' if container == 'dsh' else container
                                        minimum = memory_bytes(configured[container]) if container in configured else None
                                        async def probe(epoch=None, member=member_id, plugin_id=plugin):
                                            return await _plugin_stopped(harness, member, plugin_id, epoch)
                                        await memory.reclaim_plugin(claim['operation'], sleep, probe=probe,
                                                                    minimum_limit_bytes=minimum)
                                except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, TypeError, ValueError):
                                    continue
                            local_plugins = {item['id'] for item in runtime_manifests()
                                             if item.get('runtime', {}).get('lifecycle')
                                             and not item.get('deployment', {}).get('shared')}
                            for member_id in settings.runtime_slots:
                                try:
                                    states = await _memory_plugins(harness, member_id)
                                    candidates = [(item['id'], _stopped_memory(item, item['id'])) for item in states
                                                  if item.get('id') in local_plugins]
                                    candidates = [(plugin, info) for plugin, info in candidates if info]
                                    if not candidates:
                                        continue
                                    snapshot, pod = await memory.snapshot(member_id)
                                    if pod is None:
                                        continue
                                    uid = pod['metadata']['uid']
                                    existing = await asyncio.to_thread(harness_sessions.memory_claims)
                                    for plugin, info in candidates:
                                        if (info.get('pod_uid') != uid or any(row['kind'] == 'container'
                                                and row['resource_id'] == uid and row['resource_name'] == plugin for row in existing)):
                                            continue
                                        containers = [item for item in pod['spec']['containers'] if item.get('name') == plugin]
                                        base = snapshot['base_requests'].get((member_id, plugin), 0)
                                        base_limit = snapshot['base_limits'].get((member_id, plugin), 0)
                                        usage = snapshot['container_usage'].get((uid, plugin))
                                        if len(containers) != 1 or not base or not base_limit or usage is None:
                                            continue
                                        limit = memory_bytes(containers[0]['resources']['limits']['memory'])
                                        minimum = memory_bytes(configured[plugin]) if plugin in configured else base
                                        target = max(base, base_limit, minimum, (max(usage, info['memory_current_bytes']) * 13 + 9) // 10)
                                        if target >= limit:
                                            continue
                                        async def probe(epoch=None, member=member_id, plugin_id=plugin):
                                            return await _plugin_stopped(harness, member, plugin_id, epoch)
                                        operation = 'legacy:' + uid + ':' + plugin
                                        legacy = {'member': member_id, 'resource_id': uid, 'resource_name': plugin,
                                                  'object_name': pod['metadata']['name']}
                                        await memory.reclaim_plugin(operation, sleep, probe=probe,
                                                                    minimum_limit_bytes=minimum, legacy=legacy)
                                        break
                                except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, KeyError, TypeError, ValueError):
                                    continue
                    if sleep.enabled or sleep.memory_active():
                        warm = await _warm_idle_members(
                            harness, sleep, memory, warm_limit,
                            busy=lambda member: _member_busy(harness, canvas, render, member, media, memory))
                        for member_id in settings.runtime_slots:
                            if member_id in warm:
                                continue
                            try:
                                await sleep.sleep_if_idle(
                                    member_id,
                                    probe=lambda member=member_id: _member_idle(harness, member),
                                    busy=lambda member=member_id: _member_busy(harness, canvas, render, member, media, memory))
                            except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, TypeError, ValueError):
                                continue
                    if memory is not None and sleep.memory_active():
                        for member_id in settings.runtime_slots:
                            failure = await asyncio.to_thread(harness_sessions.start_failure, member_id)
                            if failure:
                                operation = await asyncio.to_thread(harness_sessions.retry_failed_start_retirement, member_id)
                                if operation:
                                    try:
                                        await sleep._scale(member_id, 0, operation=operation)
                                    except AuthError:
                                        pass
                            entry = await asyncio.to_thread(harness_sessions.entry, member_id)
                            if sleep.replicas.get(member_id) != 0 and not (entry and entry['state'] == 'retiring'):
                                continue
                            try:
                                await memory.reconcile_retirement(member_id)
                            except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, TypeError, ValueError):
                                continue
            async def release_warm_for_waiters():
                while True:
                    await asyncio.sleep(5)
                    if memory is None or not sleep.memory_active() or warm_limit <= 0:
                        continue
                    if not await asyncio.to_thread(harness_sessions.memory_waiters):
                        continue
                    candidates = await asyncio.to_thread(harness_sessions.warm_candidates,
                                                         min(sleep.idle_ms, 60_000), newest=False)
                    for candidate in candidates:
                        member_id = candidate['member']
                        try:
                            if await sleep.sleep_if_idle(
                                    member_id, waiting_only=True,
                                    probe=lambda member=member_id: _member_idle(harness, member),
                                    busy=lambda member=member_id: _member_busy(harness, canvas, render, member, media, memory)):
                                break
                        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, TypeError, ValueError):
                            continue
            idle = asyncio.create_task(idle_members())
            warm_release = asyncio.create_task(release_warm_for_waiters())
            try:
                yield
            finally:
                task.cancel()
                idle.cancel()
                warm_release.cancel()
                await asyncio.gather(task, idle, warm_release, return_exceptions=True)
    app = FastAPI(lifespan=lifespan, title="Greenroom", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.spaces = spaces
    app.state.identities = identity_store
    app.state.auth = auth
    app.state.media = media
    app.state.harness = harness
    app.state.feishu = feishu
    app.state.canvas = canvas

    @app.exception_handler(AuthError)
    async def auth_error(_, exc: AuthError):
        return JSONResponse({"detail": exc.message}, status_code=exc.status, headers={"Cache-Control": "no-store"})

    @app.exception_handler(JSONDecodeError)
    @app.exception_handler(RequestValidationError)
    async def validation_error(_, _exc: RequestValidationError):
        return JSONResponse({"detail": "请求格式无效"}, status_code=422, headers={"Cache-Control": "no-store"})

    @app.get("/api/health")
    @app.get("/healthz")
    async def health():
        return {
            "ok": True,
            "service": "greenroom" if settings.standalone else "greenroom",
            "auth_enabled": auth.enabled,
            "registration_enabled": False,
            "roster_size": 1 if settings.standalone else len(directory()),
            "build_sha": settings.build_sha,
            "product_version": PRODUCT_VERSION,
            "asset_backend": "asset-service" if settings.asset_service_url else "unconfigured",
            "dsh_version": settings.dsh_version,
            "members_configured": len(settings.member_emails),
        }

    app.include_router(auth_router(auth))
    app.include_router(_space_router(spaces, media))
    app.include_router(media_router(media))
    app.include_router(harness_router(harness, media, spaces))
    app.include_router(canvas_router(canvas))
    app.include_router(proxy_router(settings, transport=transport, governance=governance))
    app.include_router(feishu_router(feishu))
    app.include_router(usage_router(settings, governance, transport=transport))
    app.include_router(admin_router(settings, spaces, governance=governance))
    if settings.standalone:
        from app.local_models.app import create_portal_apps

        local_models_api, local_models_ui = create_portal_apps(data_dir / "local-models", port=settings.port)
        app.mount("/api/local-models", local_models_api)
        app.mount("/local-models", local_models_ui)
    app.add_middleware(AuthenticationMiddleware, auth=auth)
    app.add_middleware(RuntimeOriginMiddleware, edge=harness)
    return app


def _space_router(spaces: SpaceStore, media: MediaService) -> APIRouter:
    router = APIRouter(prefix="/api/spaces")
    mutation_lock = asyncio.Lock()

    def actor():
        member = current_member.get()
        if member is None:
            raise AuthError(401, "请先登录")
        profile = spaces.members_by_id[member.member_id]
        return member.member_id, profile["role"]

    @router.get("/personal")
    async def personal(type: Optional[str] = None, search: Optional[str] = None):
        member_id, _role = actor()
        return {"assets": await asyncio.to_thread(spaces.list_personal, member_id, type_filter=type, search=search)}

    @router.get("/public")
    async def public(type: Optional[str] = None, search: Optional[str] = None, ownerId: Optional[str] = None):
        actor()
        return {"assets": await asyncio.to_thread(spaces.list_public, type_filter=type, search=search, owner_id=ownerId)}

    @router.get("/stats")
    async def stats():
        member_id, _role = actor()
        return await asyncio.to_thread(spaces.stats, member_id)

    @router.post("/assets")
    async def create(request: Request):
        async with mutation_lock:
            return await create_locked(request)

    async def create_locked(request):
        member_id, _role = actor()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        for forbidden in ("ownerId", "ownerName", "ownerRole", "id", "visibility"):
            payload.pop(forbidden, None)
        if payload.get('mediaMeta') is not None:
            payload['mediaMeta'] = await asyncio.to_thread(media.metadata, payload['mediaMeta'], current_member.get())
        elif payload.get('source') == 'asset_service':
            raise AuthError(422, '缺少已登记媒体')
        try:
            asset = await asyncio.to_thread(spaces.create, member_id, payload)
        except ValueError as exc:
            raise AuthError(422, str(exc)) from exc
        storage_id = (asset.get('mediaMeta') or {}).get('storageAssetId')
        if storage_id:
            await media.publish(storage_id)
        return {"asset": asset}

    @router.delete("/assets/{asset_id}")
    async def delete(asset_id: str):
        async with mutation_lock:
            return await delete_locked(asset_id)

    async def delete_locked(asset_id):
        member_id, role = actor()
        try:
            def delete_asset():
                return spaces.get(asset_id), spaces.delete(asset_id, member_id, role)
            existing, result = await asyncio.to_thread(delete_asset)
            storage_id = (existing.get('mediaMeta') or {}).get('storageAssetId')
            if storage_id:
                await asyncio.to_thread(media.store.update, storage_id, desired='deleted')
                await media.retry_pending()
            return result
        except LookupError as exc:
            raise AuthError(404, str(exc)) from exc
        except PermissionError as exc:
            raise AuthError(403, str(exc)) from exc

    return router


app = create_app()
