"""Admin management router for the production admin or standalone local user.

Non-admin members are rejected with HTTP 403.
Provides high-density system parameters inspection, member statuses,
DSH runtime slot overview, third-party model provider governance,
and multimodal usage auditing (LLM tokens, image/video parameters).
"""

from __future__ import annotations

import re
import time
from urllib.parse import urlsplit
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.identity.auth import AuthError, current_member
from app.identity.standalone import STANDALONE_MEMBER, STANDALONE_MEMBER_ID
from app.core.config import Settings
from app.creative.creative import CREATIVE_KINDS, EXTERNAL_PROTOCOLS, CreativeService, creative_catalog, creative_plugin, validate_parameters
from app.governance.governance_store import CANVAS_KEY_FIELDS, CHARGE_SUMMARY, HUOBAO_MODEL_KINDS, GovernanceStore
from app.governance.provider_routing import (BINDABLE, LUNA_PROFILE, TEXT_PROTOCOLS,
    model_alias, provider_allows, validate_model_profile)
from app.core.roster import ROSTER
from app.assets.spaces import SpaceStore

ADMIN_ID = STANDALONE_MEMBER_ID


def gateway_model_directory(raw, routed):
    kinds = {
        'llm': 'llm', 'chat': 'llm', 'text': 'llm', 'text.generation': 'llm',
        'image': 'image', 'image.generation': 'image',
        'video': 'video', 'video.generation': 'video',
        'audio': 'audio', 'tts': 'audio', 'music': 'audio', 'speech': 'audio',
        'audio.generation': 'audio', 'audio.transcription': 'audio', 'transcription': 'audio',
        'embedding': 'embedding', 'embeddings': 'embedding', 'moderation': 'moderation',
        'rerank': 'rerank',
    }
    families = (
        ('audio', r'^(?:gpt-(?:audio|live|realtime|transcribe)|tts-|whisper-)|-(?:audio|transcribe|tts|realtime)(?:-|$)'),
        ('image', r'^(?:gpt-image|chatgpt-image|dall-e)'),
        ('video', r'^sora(?:-|$)'),
        ('embedding', r'^(?:text-embedding|embedding)'),
        ('moderation', r'^(?:omni-moderation|text-moderation)'),
        ('llm', r'^(?:gpt-[0-9]|chat-latest|chatgpt-|o[0-9]|davinci-|babbage-)'),
    )
    routed_by_id = {model['id']: (kind, model) for kind, models in routed.items() for model in models}
    rows = {}
    for model in [*(raw.get('data') or []), *(raw.get('models') or [])]:
        model_id = model.get('slug') or model.get('id')
        if not isinstance(model_id, str) or not model_id:
            continue
        active_kind, active_model = routed_by_id.get(model_id, (None, None))
        family = model_id.split(':', 2)[1] if model_id.startswith('ft:') else model_id
        kind = kinds.get(str(model.get('kind', ''))) or active_kind
        if not kind and raw.get('greenroom_local_openai'):
            kind = next((bucket for bucket, pattern in families if re.search(pattern, family)), None)
        rows[model_id] = {
            'id': model_id, 'kind': kind or 'other',
            'label': (active_model or {}).get('label') or model.get('display_name') or model_id,
            'connected': active_model is not None,
        }
    return sorted(rows.values(), key=lambda row: (not row['connected'], row['id'].casefold()))


def admin_router(
    settings: Settings,
    spaces: SpaceStore,
    governance: Optional[GovernanceStore] = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/admin")
    gov = governance or GovernanceStore(Path(settings.data_dir) / "admin_governance.sqlite3")
    members = (STANDALONE_MEMBER,) if settings.standalone else ROSTER

    def require_admin() -> Any:
        member = current_member.get()
        if member is None:
            raise AuthError(401, "请先登录")
        if member.member_id != (STANDALONE_MEMBER_ID if settings.standalone else ADMIN_ID):
            detail = "权限不足：仅本地管理员可访问管理系统" if settings.standalone else "权限不足：仅唯一管理员（徐子寒）可访问管理系统"
            raise AuthError(403, detail)
        return member

    def managed_api() -> dict[str, Any]:
        effective = gov.gateway_settings(settings)
        key = effective.gateway_api_key
        return {
            "baseUrl": effective.openai_base_url or effective.gateway_service_url.rstrip("/") + "/v1",
            "configured": bool(effective.gateway_service_url and key),
            "apiKeyConfigured": bool(key),
            "apiKeyMasked": "********" if key else None,
            "models": list(effective.gateway_models),
            "source": "管理员配置" if gov.has_gateway_settings() else "环境变量",
        }

    def guard_gateway_change(request, base):
        current = gov.gateway_settings(settings)
        current_base = current.openai_base_url or current.gateway_service_url.rstrip('/') + '/v1'
        if base == current_base:
            return
        canvas = getattr(request.app.state, 'canvas', None)
        has_tasks = False
        if canvas is not None:
            with canvas.lock:
                has_tasks = canvas.db.execute('SELECT 1 FROM tasks LIMIT 1').fetchone() is not None
        if has_tasks or gov.has_gateway_usage():
            raise AuthError(409, "已有生成任务或账单记录，不能切换网关地址；历史查询依赖原来源，请保留数据并由运维处理迁移")

    @router.get("/gateway-settings")
    async def gateway_settings() -> JSONResponse:
        require_admin()
        return JSONResponse(managed_api(), headers={"Cache-Control": "no-store"})

    @router.put("/gateway-settings")
    async def update_gateway_settings(request: Request) -> JSONResponse:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict) or set(payload) - {"baseUrl", "apiKey"}:
            raise AuthError(422, "网关配置格式无效")
        base = payload.get("baseUrl")
        key = payload.get("apiKey", "")
        if not isinstance(base, str) or not isinstance(key, str):
            raise AuthError(422, "网关地址和密钥格式无效")
        base = base.strip().rstrip("/")
        try:
            url = urlsplit(base)
            valid = (url.scheme in {"http", "https"} and url.hostname and url.port != 0
                     and not url.username and not url.password and not url.query and not url.fragment
                     and url.path.endswith("/v1") and not any(c.isspace() for c in base))
        except ValueError:
            valid = False
        if not valid:
            raise AuthError(422, "请填写以 /v1 结尾、不含凭据或查询参数的 HTTP(S) 网关地址")
        if settings.environment == "production" and "staging" in url.hostname:
            raise AuthError(422, "生产网关地址不能指向 staging 服务")
        current = gov.gateway_settings(settings)
        current_base = current.openai_base_url or current.gateway_service_url.rstrip("/") + "/v1"
        if base != current_base and not key.strip():
            raise AuthError(422, "切换地址时必须填写对应 API Key，不能沿用另一网关的密钥")
        key = key.strip() or current.gateway_api_key
        if not key or any(c in key for c in "\r\n"):
            raise AuthError(422, "请配置有效的网关 API Key")
        guard_gateway_change(request, base)
        try:
            gov.update_gateway_settings(base, key)
        except ValueError as exc:
            raise AuthError(409, str(exc)) from exc
        return JSONResponse(managed_api(), headers={"Cache-Control": "no-store"})

    @router.delete("/gateway-settings")
    async def reset_gateway_settings(request: Request) -> JSONResponse:
        require_admin()
        guard_gateway_change(request, settings.openai_base_url or settings.gateway_service_url.rstrip("/") + "/v1")
        try:
            gov.clear_gateway_settings(settings.openai_base_url or settings.gateway_service_url.rstrip("/") + "/v1")
        except ValueError as exc:
            raise AuthError(409, str(exc)) from exc
        return JSONResponse(managed_api(), headers={"Cache-Control": "no-store"})

    # --- Existing endpoints ---

    @router.get("/overview")
    async def overview(timeRange: Optional[str] = "all") -> dict[str, Any]:
        require_admin()
        start_time = 0
        if timeRange in {"today", "7d", "30d"}:
            start_time = int(time.time()) - {"today": 1, "7d": 7, "30d": 30}[timeRange] * 86400
        await gov.refresh_gateway_charges(settings, start_time=start_time)
        member_list = []
        for m in members:
            mid = m["id"]
            has_email = bool(settings.member_emails.get(mid))
            member_list.append(
                {
                    "id": mid,
                    "name": m["name"],
                    "displayName": m["display_name"],
                    "role": m["role"],
                    "accountStatus": "configured" if settings.standalone or has_email else "pending",
                    "email": settings.member_emails.get(mid) if has_email else None,
                }
            )

        public_assets = spaces.list_public()
        providers = gov.list_providers(include_key=False)
        active_providers_count = sum(1 for p in providers if p.get("isActive"))
        usage_summary = gov.get_usage_overview(start_time=start_time)

        return {
            "admin": STANDALONE_MEMBER_ID if settings.standalone else ADMIN_ID,
            "buildSha": settings.build_sha,
            "environment": settings.environment,
            "dshVersion": settings.dsh_version,
            "externalAuthActive": settings.external_auth_enabled,
            "members": member_list,
            "providersCount": len(providers),
            "activeProvidersCount": active_providers_count,
            "usageSummary": usage_summary,
            "stats": {
                "rosterCount": len(members),
                "configuredCount": 1 if settings.standalone else len(settings.member_emails),
                "publicAssetsCount": len(public_assets),
                "totalSlots": len(settings.runtime_slots or {}),
            },
        }

    @router.get("/params")
    async def get_params() -> dict[str, Any]:
        require_admin()
        return {
            "buildSha": settings.build_sha,
            "environment": settings.environment,
            "dshVersion": settings.dsh_version,
            "cookieSecure": settings.cookie_secure,
            "externalAuthEnabled": settings.external_auth_enabled,
            "authServiceUrl": settings.auth_service_url,
            "authTenantId": settings.auth_tenant_id,
            "authAudience": settings.auth_audience,
            "assetServiceUrl": settings.asset_service_url,
            "gatewayServiceUrl": gov.gateway_settings(settings).gateway_service_url,
            "managedApi": managed_api(),
            "dataDir": settings.data_dir,
            "storageBudgetGiB": len(members) + 5,
            "storageHeadroomGiB": 5,
            "slotBudgetGiB": 1,
            "appBudgetGiB": 5,
        }

    @router.post("/params")
    async def update_params(request: Request) -> dict[str, Any]:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        return {
            "success": True,
            "message": "参数已更新",
            "updated": payload,
        }

    # --- Unified Canvas Settings ---

    @router.get("/canvas-settings")
    async def canvas_settings() -> JSONResponse:
        require_admin()
        return JSONResponse({"success": True, "data": gov.get_canvas_settings()},
                            headers={"Cache-Control": "no-store"})

    @router.get("/canvas-settings/raw")
    async def raw_canvas_settings() -> JSONResponse:
        require_admin()
        return JSONResponse({"success": True, "data": gov.get_canvas_settings(include_keys=True)},
                            headers={"Cache-Control": "no-store"})

    @router.put("/canvas-settings")
    async def update_canvas_settings(request: Request) -> JSONResponse:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        preset = payload.get("uiFontPreset")
        if preset is not None and (not isinstance(preset, str) or preset not in {"readable", "system", "theme", "custom"}):
            raise AuthError(422, "界面字体选项无效")
        custom_font = payload.get("customUiFont")
        if custom_font is not None:
            if not isinstance(custom_font, str):
                raise AuthError(422, "自定义字体格式无效")
            custom_font = " ".join(re.sub(r"[;{}<>]", "", custom_font).split())[:220]
        keys = payload.get("keys", {})
        clear_keys = payload.get("clearKeys", [])
        if not isinstance(keys, dict) or any(
            field not in CANVAS_KEY_FIELDS or not isinstance(value, str) for field, value in keys.items()
        ):
            raise AuthError(422, "API Key 配置格式无效")
        if not isinstance(clear_keys, list) or any(field not in CANVAS_KEY_FIELDS for field in clear_keys):
            raise AuthError(422, "清除 API Key 选项无效")
        result = gov.update_canvas_settings(ui_font_preset=preset, custom_ui_font=custom_font,
                                            keys=keys, clear_keys=clear_keys)
        return JSONResponse({"success": True, "data": result}, headers={"Cache-Control": "no-store"})

    # --- API Catalog and Huobao Managed Models ---

    @router.get("/api-catalog")
    async def api_catalog(request: Request) -> JSONResponse:
        member = require_admin()
        canvas = getattr(request.app.state, "canvas", None)
        catalog_error = None
        directory = None
        if canvas is None:
            models = {
                "llm": [{"id": model_id, "label": model_id, "capabilities": {}}
                        for model_id in settings.gateway_models],
                "image": [],
                "video": [],
            }
            catalog_error = "画布服务暂不可用"
        else:
            try:
                raw = await canvas.catalog(member)
                models = canvas.grouped_models(raw)
                directory = gateway_model_directory(raw, models)
            except AuthError as exc:
                catalog_error = exc.message
                models = {
                    "llm": [{"id": model_id, "label": model_id, "capabilities": {}}
                            for model_id in settings.gateway_models],
                    "image": [],
                    "video": [],
                }
        selected = gov.get_huobao_settings()
        return JSONResponse({
            "success": True,
            "data": {
                "gateway": managed_api(),
                "models": models,
                "directory": directory,
                "modelProfiles": {"gpt-6-luna": LUNA_PROFILE, **gov.gateway_model_profiles()},
                "huobao": {"configured": selected is not None, "selected": selected},
                "providers": gov.list_providers(include_key=False),
                "runninghub": {
                    "cn": gov.list_runninghub_keys(site="cn", include_key=False),
                    "intl": gov.list_runninghub_keys(site="intl", include_key=False),
                },
                "catalogError": catalog_error,
            },
        }, headers={"Cache-Control": "no-store"})

    @router.put("/gateway-model-profile")
    async def save_gateway_model_profile(request: Request):
        member = require_admin()
        payload = await request.json()
        if not isinstance(payload, dict) or not isinstance(payload.get('modelId'), str):
            raise AuthError(422, '请选择模型')
        canvas = request.app.state.canvas
        catalog = canvas.grouped_models(await canvas.catalog(member))
        model_id = payload['modelId']
        kind = next((kind for kind in ('llm', 'image') if any(row['id'] == model_id for row in catalog[kind])), None)
        if kind is None or kind == 'image' and model_id not in {'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'}:
            raise AuthError(404, '此型号暂无可编辑参数')
        profile = validate_model_profile(payload.get('profile', {}), kind)
        gov.save_gateway_model_profile(model_id, profile)
        return {'success': True}

    @router.put("/huobao-settings")
    async def update_huobao_settings(request: Request) -> JSONResponse:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        models = payload.get("models")
        if models is None:
            gov.clear_huobao_settings()
            return JSONResponse({"success": True, "data": {"configured": False, "selected": None}},
                                headers={"Cache-Control": "no-store"})
        if not isinstance(models, dict) or any(kind not in HUOBAO_MODEL_KINDS for kind in models):
            raise AuthError(422, "模型配置格式无效")
        cleaned: dict[str, list[str]] = {}
        for kind in HUOBAO_MODEL_KINDS:
            values = models.get(kind, [])
            if not isinstance(values, list) or len(values) > 200:
                raise AuthError(422, "模型配置格式无效")
            normalized = []
            for value in values:
                if not isinstance(value, str) or not value.strip() or len(value.strip()) > 200:
                    raise AuthError(422, "模型配置格式无效")
                normalized.append(value.strip())
            cleaned[kind] = list(dict.fromkeys(normalized))
        saved = gov.update_huobao_settings(cleaned)
        return JSONResponse({"success": True, "data": {"configured": True, "selected": saved}},
                            headers={"Cache-Control": "no-store"})

    # --- Managed creative plugin settings (administrator only) ---

    @router.get("/creative-plugins")
    async def creative_plugins(request: Request) -> JSONResponse:
        member = require_admin()
        canvas = getattr(request.app.state, "canvas", None)
        models = {kind: [] for kind in CREATIVE_KINDS}
        catalog_error = None
        if canvas is not None:
            # Administration reads the same capability registry as member MCP calls.
            creative = getattr(request.app.state, 'creative', None)
            if creative is None:
                creative = CreativeService(canvas)
                request.app.state.creative = creative
            models.update(creative.external_models())
            try:
                models = await creative.models(member, management=True)
            except AuthError as exc:
                catalog_error = exc.message
        else:
            catalog_error = "画布服务暂不可用"
        catalog = creative_catalog()
        plugins = []
        providers = gov.list_providers(include_key=False)
        by_id = {provider['id']: provider for provider in providers}
        for plugin in catalog['plugins']:
            if plugin.get('kind') == 'website':
                continue
            saved = gov.get_creative_settings(plugin['id'])
            bindings = gov.provider_bindings(plugin['id'])
            selection = {}
            for kind in CREATIVE_KINDS:
                bound = bindings.get(kind)
                allowed = []
                for row in models[kind]:
                    provider_id = row.get('providerId')
                    if bound and provider_id != bound:
                        continue
                    if not provider_id or (provider_id in by_id and provider_allows(by_id[provider_id], plugin['id'])):
                        allowed.append(row['id'])
                selection[kind] = allowed if saved is None else [
                    value for value in saved['models'][kind] if value in allowed]
            plugins.append({**plugin, 'configured': saved is not None,
                'bindings': bindings, 'selected': selection,
                'parameters': saved['parameters'] if saved else {}})
        return JSONResponse({'success': True, 'data': {'releaseReady': catalog['releaseReady'],
            'aigcSkillsReady': catalog.get('aigcSkillsReady', False),
            'plugins': plugins, 'models': models, 'catalogError': catalog_error,
            'providers': providers}}, headers={'Cache-Control': 'no-store'})

    @router.put("/creative-plugins/{plugin_id}")
    async def update_creative_plugin(plugin_id: str, request: Request) -> JSONResponse:
        require_admin()
        creative_plugin(plugin_id)
        payload = await request.json()
        if not isinstance(payload, dict) or set(payload) - {'models', 'parameters'} or 'models' not in payload:
            raise AuthError(422, '创作插件设置格式无效')
        models = payload['models']
        if models is not None:
            if (not isinstance(models, dict) or set(models) != set(CREATIVE_KINDS)
                    or any(not isinstance(values, list) or any(not isinstance(value, str) or not value.strip()
                        for value in values) for values in models.values())):
                raise AuthError(422, '请提供七类模型 ID 数组；空数组表示停用对应能力')
            models = {kind: list(dict.fromkeys(models[kind])) for kind in CREATIVE_KINDS}
        parameters = validate_parameters(payload.get('parameters', {}))
        gov.update_creative_settings(plugin_id, models, parameters)
        return JSONResponse({'success': True, 'data': {'configured': models is not None}},
                            headers={'Cache-Control': 'no-store'})

    def provider_plugin(plugin_id):
        if plugin_id not in {'t8', 'huobao'}:
            creative_plugin(plugin_id)

    @router.put("/creative-plugins/{plugin_id}/providers")
    async def update_plugin_providers(plugin_id: str, request: Request):
        require_admin()
        provider_plugin(plugin_id)
        bindings = await request.json()
        if not isinstance(bindings, dict) or set(bindings) - set(BINDABLE):
            raise AuthError(422, '供应商绑定须按文字、生图或语音配置')
        for kind, provider_id in bindings.items():
            provider = gov.get_provider(provider_id) if isinstance(provider_id, str) else None
            if (provider is None or not provider_allows(provider, plugin_id)
                    or not any(model.get('modality', 'llm') == kind and (kind != 'image' or model.get('protocol') == 'openai-images')
                               for model in provider['models'])):
                raise AuthError(422, '此插件或能力未获得所选供应商授权')
        previous = gov.provider_bindings(plugin_id)
        saved = gov.get_creative_settings(plugin_id)
        if saved:
            for kind in BINDABLE:
                if previous.get(kind) == bindings.get(kind) or not saved['models'][kind]:
                    continue
                if kind in bindings:
                    provider = gov.get_provider(bindings[kind])
                    saved['models'][kind] = [model_alias(provider, model) for model in provider['models']
                                             if model.get('modality', 'llm') == kind]
                else:
                    canvas = request.app.state.canvas
                    creative = getattr(request.app.state, 'creative', None) or CreativeService(canvas)
                    defaults = await creative.models(current_member.get())
                    saved['models'][kind] = [row['id'] for row in defaults[kind] if not row.get('providerId')]
        gov.save_provider_bindings(plugin_id, bindings, model_selection=saved['models'] if saved else None)
        return {'success': True}

    def validate_provider_scope(payload):
        ids = payload.get('pluginIds')
        if ids is None:
            return None
        if not isinstance(ids, list) or not ids or any(not isinstance(value, str) for value in ids):
            raise AuthError(422, '请至少选择一个可使用此供应商的插件')
        for plugin_id in ids:
            provider_plugin(plugin_id)
        return list(dict.fromkeys(ids))

    # --- Provider Management Endpoints ---

    def validate_provider_url(url):
        if not isinstance(url, str):
            raise AuthError(422, '供应商地址格式无效')
        try:
            parts = urlsplit(url.strip())
            hostname = (parts.hostname or '').rstrip('.')
            port = parts.port
        except ValueError as exc:
            raise AuthError(422, '供应商地址格式无效') from exc
        loopback = settings.standalone and hostname in {'localhost', '127.0.0.1', '::1'}
        if (not hostname or parts.scheme != 'https' and not (loopback and parts.scheme == 'http')
                or parts.username or parts.password or parts.query or parts.fragment or port == 0):
            raise AuthError(422, '请输入允许使用的 HTTPS API 地址')
        return url.strip().rstrip('/')

    def validate_provider_models(models):
        if not isinstance(models, list):
            raise AuthError(422, 'Provider 模型须为数组')
        seen = set()
        for model in models:
            if not isinstance(model, dict) or not isinstance(model.get('id'), str) or not model['id'].strip():
                raise AuthError(422, 'Provider 模型 ID 无效')
            kind = model.get('modality', 'llm')
            if not isinstance(kind, str) or kind not in {'llm', 'image', 'video', *EXTERNAL_PROTOCOLS}:
                raise AuthError(422, 'Provider 模型能力无效')
            if kind == 'image' and model.get('protocol') not in (None, 'openai-images'):
                raise AuthError(422, '生图供应商须支持 Images API')
            if kind == 'llm' and model.get('protocol') not in (None, *TEXT_PROTOCOLS):
                raise AuthError(422, '文字供应商须选择 Chat Completions 或 Responses')
            key = (kind, model['id'])
            if key in seen:
                raise AuthError(422, '供应商内的同类模型 ID 须唯一')
            seen.add(key)
            if 'profile' in model and kind in ('llm', 'image'):
                validate_model_profile(model['profile'], kind)
            if kind in EXTERNAL_PROTOCOLS and model.get('protocol') != EXTERNAL_PROTOCOLS[kind][0]:
                raise AuthError(422, f'{kind} 须选择已支持的协议 {EXTERNAL_PROTOCOLS[kind][0]}')
        return models

    @router.get("/providers")
    async def list_providers() -> dict[str, Any]:
        require_admin()
        return {"providers": gov.list_providers(include_key=False)}

    @router.post("/providers")
    async def create_provider(request: Request) -> dict[str, Any]:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        name = payload.get("name")
        base_url = payload.get("baseUrl")
        api_key = payload.get("apiKey")
        model_prefix = payload.get("modelPrefix", "")
        models = payload.get("models", [])
        is_active = payload.get("isActive", True)

        if not name or not base_url or not api_key:
            raise AuthError(422, "缺少必要的 Provider 字段 (name, baseUrl, apiKey)")

        created = gov.create_provider(
            name=name,
            base_url=validate_provider_url(base_url),
            api_key=api_key,
            model_prefix=model_prefix,
            models=validate_provider_models(models),
            is_active=is_active,
            plugin_ids=validate_provider_scope(payload),
        )
        return {"success": True, "provider": created}

    @router.put("/providers/{provider_id}")
    async def update_provider(provider_id: str, request: Request) -> dict[str, Any]:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        updated = gov.update_provider(
            provider_id,
            name=payload.get("name"),
            base_url=validate_provider_url(payload["baseUrl"]) if "baseUrl" in payload else None,
            api_key=payload.get("apiKey"),
            model_prefix=payload.get("modelPrefix"),
            models=validate_provider_models(payload['models']) if 'models' in payload else None,
            is_active=payload.get("isActive"),
            plugin_ids=validate_provider_scope(payload) if "pluginIds" in payload else ...,
        )
        if not updated:
            raise AuthError(404, "Provider 不存在")
        return {"success": True, "provider": updated}

    @router.delete("/providers/{provider_id}")
    async def delete_provider(provider_id: str) -> dict[str, Any]:
        require_admin()
        deleted = gov.delete_provider(provider_id)
        if not deleted:
            raise AuthError(404, "Provider 不存在")
        return {"success": True, "message": "已删除 Provider"}

    @router.post("/providers/test")
    async def test_provider_connectivity(request: Request) -> dict[str, Any]:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        provider_id = payload.get("providerId")
        base_url = payload.get("baseUrl")
        api_key = payload.get("apiKey")

        if provider_id:
            prov = gov.get_provider(provider_id, include_key=True)
            if not prov:
                raise AuthError(404, "Provider 不存在")
            base_url = prov["baseUrl"]
            api_key = prov["apiKey"]

        if not base_url or not api_key or api_key.startswith("***"):
            raise AuthError(422, "无法测试：Base URL 或 API Key 不完整")

        start = time.time()
        test_url = validate_provider_url(base_url) + "/models"
        headers = {"Authorization": f"Bearer {api_key}"}
        canvas = getattr(request.app.state, "canvas", None)
        session = canvas.client('admin') if canvas is not None else httpx.AsyncClient(timeout=8.0)
        try:
            async with session as client:
                resp = await client.get(test_url, headers=headers, timeout=8.0)
                latency_ms = int((time.time() - start) * 1000)
                if resp.status_code == 200:
                    models = []
                    try:
                        data = resp.json()
                        entries = data.get("data") if isinstance(data, dict) else None
                        if not isinstance(entries, list):
                            entries = data.get("models") if isinstance(data, dict) else None
                        if isinstance(entries, list):
                            for entry in entries:
                                if isinstance(entry, dict):
                                    model_id = entry.get("id") or entry.get("slug")
                                elif isinstance(entry, str):
                                    model_id = entry
                                else:
                                    model_id = None
                                if isinstance(model_id, str) and model_id and model_id not in models:
                                    models.append(model_id)
                                if len(models) >= 200:
                                    break
                    except Exception:
                        pass
                    models_count = len(models)
                    return {
                        "success": True,
                        "status": resp.status_code,
                        "latencyMs": latency_ms,
                        "modelsFound": models_count,
                        "models": models,
                        "message": f"连接成功 (拉取到 {models_count} 个模型，延时 {latency_ms}ms)",
                    }
                return {
                    "success": False,
                    "status": resp.status_code,
                    "latencyMs": latency_ms,
                    "message": f"上游响应错误 HTTP {resp.status_code}",
                }
        except Exception as exc:
            latency_ms = int((time.time() - start) * 1000)
            return {
                "success": False,
                "latencyMs": latency_ms,
                "message": "连接失败，请检查供应商地址和网络",
            }

    # --- RunningHub Multi-Key Pool Endpoints ---

    @router.get("/runninghub/keys")
    async def list_runninghub_keys(site: Optional[str] = None) -> JSONResponse:
        require_admin()
        if site in ("cn", "intl"):
            data = {site: gov.list_runninghub_keys(site=site, include_key=False)}
        else:
            data = {
                "cn": gov.list_runninghub_keys(site="cn", include_key=False),
                "intl": gov.list_runninghub_keys(site="intl", include_key=False),
            }
        return JSONResponse({"success": True, "data": data}, headers={"Cache-Control": "no-store"})

    @router.put("/runninghub/keys")
    async def update_runninghub_keys(request: Request) -> JSONResponse:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")

        if "site" in payload:
            site = payload.get("site")
            if site not in ("cn", "intl"):
                raise AuthError(422, "站点参数无效 (仅支持 cn 或 intl)")
            keys = payload.get("keys", [])
            if not isinstance(keys, list):
                raise AuthError(422, "keys 必须为列表")
            gov.save_runninghub_keys(site, keys)
        else:
            for s in ("cn", "intl"):
                if s in payload:
                    keys = payload[s]
                    if isinstance(keys, list):
                        gov.save_runninghub_keys(s, keys)

        data = {
            "cn": gov.list_runninghub_keys(site="cn", include_key=False),
            "intl": gov.list_runninghub_keys(site="intl", include_key=False),
        }
        return JSONResponse({"success": True, "data": data}, headers={"Cache-Control": "no-store"})

    @router.post("/runninghub/test-key")
    async def test_runninghub_key(request: Request) -> dict[str, Any]:
        require_admin()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        site = payload.get("site")
        if site not in ("cn", "intl"):
            raise AuthError(422, "站点参数无效 (仅支持 cn 或 intl)")
        key_id = payload.get("keyId")
        api_key = payload.get("apiKey")

        if key_id:
            record = gov.get_runninghub_key(key_id, include_key=True)
            if not record:
                raise AuthError(404, "指定的 Key 不存在")
            actual_key = record["apiKey"]
        elif api_key and not ("..." in api_key or api_key.startswith("***")):
            actual_key = api_key.strip()
        else:
            raise AuthError(422, "缺少有效的 API Key")

        origin = "https://www.runninghub.cn" if site == "cn" else "https://www.runninghub.ai"
        start = time.time()
        canvas = getattr(request.app.state, "canvas", None)
        transport = getattr(canvas, "transport", None) if canvas else None
        session = canvas.client('admin') if canvas is not None else httpx.AsyncClient(transport=transport, timeout=10.0)
        try:
            async with session as client:
                resp = await client.post(
                    f"{origin}/uc/openapi/accountStatus",
                    json={"apikey": actual_key}, timeout=10.0,
                )
                latency_ms = int((time.time() - start) * 1000)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict) and data.get("code") == 0:
                        account_data = data.get("data") or {}
                        remain_coins = account_data.get("remainCoins")
                        remain_money = account_data.get("remainMoney")
                        currency = account_data.get("currency")
                        current_tasks = account_data.get("currentTaskCounts")
                        if key_id:
                            gov.mark_runninghub_key_exhausted(key_id, cooldown_seconds=0)
                        return {
                            "success": True,
                            "latencyMs": latency_ms,
                            "remainCoins": remain_coins,
                            "remainMoney": remain_money,
                            "currency": currency,
                            "currentTasks": current_tasks,
                            "message": f"连接成功 (剩余积分: {remain_coins or 0}, 现金余额: {remain_money or '0.00'})",
                        }
                    err_msg = data.get("msg") or data.get("errorMessages") or "查询失败"
                    return {
                        "success": False,
                        "latencyMs": latency_ms,
                        "message": f"RunningHub 返回业务错误: {err_msg}",
                    }
                return {
                    "success": False,
                    "status": resp.status_code,
                    "latencyMs": latency_ms,
                    "message": f"上游响应错误 HTTP {resp.status_code}: {resp.text[:120]}",
                }
        except Exception as exc:
            latency_ms = int((time.time() - start) * 1000)
            return {
                "success": False,
                "latencyMs": latency_ms,
                "message": f"连接失败: {str(exc)}",
            }

    # --- Multimodal Usage Analytics Endpoints ---

    @router.get("/usage/overview")
    async def get_usage_overview(timeRange: Optional[str] = "all") -> dict[str, Any]:
        require_admin()
        start_time = 0
        now = int(time.time())
        if timeRange == "today":
            start_time = now - 86400
        elif timeRange == "7d":
            start_time = now - 7 * 86400
        elif timeRange == "30d":
            start_time = now - 30 * 86400

        overview_data = gov.get_usage_overview(start_time=start_time)
        return {"timeRange": timeRange, "overview": overview_data}

    @router.get("/usage/members")
    async def get_member_usage(timeRange: Optional[str] = "all") -> dict[str, Any]:
        require_admin()
        start_time = 0
        now = int(time.time())
        if timeRange == "today":
            start_time = now - 86400
        elif timeRange == "7d":
            start_time = now - 7 * 86400
        elif timeRange == "30d":
            start_time = now - 30 * 86400

        raw_usage = gov.get_member_usage(start_time=start_time)
        usage_by_member = {item["memberId"]: item for item in raw_usage}

        # Ensure all configured members appear in the analytics table.
        members_result = []
        for m in members:
            mid = m["id"]
            u = usage_by_member.get(mid, {
                "memberId": mid,
                "totalRequests": 0,
                "llmTokens": 0,
                "promptTokens": 0,
                "completionTokens": 0,
                "imageCount": 0,
                "imageParameterProfiles": [],
                "videoCount": 0,
                "videoSeconds": 0.0,
                "videoParameterProfiles": [],
                **CHARGE_SUMMARY,
            })
            members_result.append({
                "id": mid,
                "name": m["name"],
                "displayName": m["display_name"],
                "role": m["role"],
                "avatarInitials": m["avatar_initials"],
                "avatarBgColor": m["avatar_bg_color"],
                "avatarTextColor": m["avatar_text_color"],
                **u,
            })

        members_result.sort(key=lambda x: x["totalRequests"], reverse=True)
        return {"timeRange": timeRange, "members": members_result}

    @router.get("/usage/logs")
    async def get_usage_logs(
        limit: int = 50,
        offset: int = 0,
        memberId: Optional[str] = None,
        modality: Optional[str] = None,
    ) -> dict[str, Any]:
        require_admin()
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
        logs, total = gov.get_usage_logs(
            limit=limit,
            offset=offset,
            member_id=memberId,
            modality=modality,
        )
        return {
            "logs": logs,
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    return router
