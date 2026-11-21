"""Authenticated reverse proxy. Browser credentials never reach upstream services."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

from app.identity.auth import AuthError, current_member
from app.governance.governance_store import GovernanceStore


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "authorization",
    "cookie",
}


def proxy_router(settings, *, transport=None, governance: Optional[GovernanceStore] = None) -> APIRouter:
    router = APIRouter()
    store = governance or GovernanceStore(Path(settings.data_dir) / "admin_governance.sqlite3")

    @router.api_route("/api/gateway/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    async def gateway(path: str, request: Request):
        allowed = {('GET', 'v1/models')}
        if (request.method, path) not in allowed:
            raise AuthError(404, '网关操作未开放')
        canvas = request.app.state.canvas
        catalog = dict(await canvas.catalog(_require_member()))
        if 'models' in catalog or 'data' in catalog:
            try:
                if isinstance(catalog.get('models', catalog.get('data')), list):
                    models_list = [{'id': model['id'], 'object': 'model', 'owned_by': 'greenroom'}
                                   for model in canvas.grouped_models(catalog)['llm']]
                    # Also include models from active external providers
                    active_providers = [p for p in store.list_providers() if p.get("isActive")]
                    for prov in active_providers:
                        prefix = prov.get("modelPrefix", "")
                        for m in prov.get("models", []):
                            if m.get('modality', 'llm') != 'llm':
                                continue
                            m_id = m.get("id", "")
                            full_id = f"{prefix}{m_id}" if prefix and not m_id.startswith(prefix) else m_id
                            models_list.append({
                                "id": full_id,
                                "object": "model",
                                "created": prov.get("createdAt", 0),
                                "owned_by": prov.get("name", "external"),
                                "modality": m.get("modality", "llm"),
                            })
                    catalog['data'] = models_list
            except (ValueError, AttributeError):
                raise AuthError(502, '模型目录格式异常')
        return Response(content=json.dumps(catalog), media_type='application/json', headers={'Cache-Control': 'no-store'})

    return router


def _require_member():
    member = current_member.get()
    if member is None:
        raise AuthError(401, "请先登录")
    return member


async def _forward(
    request: Request,
    base: str,
    path: str,
    extra_headers: dict[str, str],
    *,
    body: bytes,
    params: list[tuple[str, str]],
    stream: bool = False,
    transport=None,
):
    if not base:
        raise AuthError(503, "上游服务未配置")
    target = _safe_target(base, path)
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_BY_HOP and not key.lower().startswith("x-greenroom-")
    }
    headers.update(extra_headers)
    headers['Accept-Encoding'] = 'identity'
    if body and "content-type" not in {key.lower() for key in headers}:
        headers["content-type"] = request.headers.get("content-type", "application/json")
    timeout = httpx.Timeout(300.0 if stream else 60.0, connect=10.0)
    client = httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False, transport=transport)
    try:
        upstream = await client.send(
            client.build_request(request.method, target, params=params, headers=headers, content=body),
            stream=stream,
        )
    except httpx.HTTPError as exc:
        await client.aclose()
        raise AuthError(502, "上游服务暂不可用") from exc
    response_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() not in HOP_BY_HOP and key.lower() != "set-cookie" and (stream or key.lower() != 'content-encoding')
    }
    if stream:
        response_headers["X-Accel-Buffering"] = "no"
        async def chunks():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(chunks(), status_code=upstream.status_code, headers=response_headers)
    payload = upstream.content
    await upstream.aclose()
    await client.aclose()
    return Response(content=payload, status_code=upstream.status_code, headers=response_headers)


def _safe_target(base: str, path: str) -> str:
    if path.startswith("/") or "\\" in path or "://" in path or ".." in path.split("/"):
        raise AuthError(400, "代理路径无效")
    root = urlsplit(base)
    if root.scheme not in {"http", "https"} or not root.netloc:
        raise AuthError(503, "上游地址无效")
    return f"{base.rstrip('/')}/{path}"
