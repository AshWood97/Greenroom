"""Local model routes for the dedicated and standalone Greenroom entry points."""
from __future__ import annotations

import ipaddress
import json
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool

from .core import HTTPTransport, LocalModels, ModelError

MAX_BODY = 16 * 1024 * 1024


def _configure_app(app, *, local_port=None):
    allowed_hosts = ({f"127.0.0.1:{local_port}", f"localhost:{local_port}", f"[::1]:{local_port}"}
                     if local_port is not None else None)
    @app.middleware("http")
    async def local_boundary(request, call_next):
        response = None
        if allowed_hosts is not None:
            try:
                local = request.client and ipaddress.ip_address(request.client.host).is_loopback
            except ValueError:
                local = False
            host = request.headers.get("host", "").lower()
            origin = request.headers.get("origin")
            if not local or host not in allowed_hosts or (origin is not None and origin != "http://" + host) or request.headers.get("sec-fetch-site") == "cross-site":
                response = JSONResponse({"error": {"code": "local_only", "message": "只允许本机同源访问；不支持公网、跨站或代理转发"}}, status_code=403)
        if response is None and request.method not in {"GET", "HEAD"}:
            if request.method == "OPTIONS" or request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                response = JSONResponse({"error": {"code": "json_required", "message": "状态变更必须由本机同源 JSON 请求发起"}}, status_code=415)
        if response is None:
            try:
                response = await call_next(request)
            except Exception:
                response = unexpected_error_response()
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        return response

    @app.exception_handler(ModelError)
    async def known_error(_request, exc):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)

    @app.exception_handler(Exception)
    async def unexpected_error(_request, _exc):
        return unexpected_error_response()


def unexpected_error_response():
    # Do not expose request bodies, credentials, provider responses or traceback.
    return JSONResponse({"error": {"code": "local_error", "message": "本机保存或执行暂不可用；请读回原请求确认状态，不要自动重发"}}, status_code=500)


async def payload(request):
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY:
            raise ModelError("body_too_large", "请求超出 16 MiB 限制", 413)
        chunks.append(chunk)
    try:
        value = json.loads(b"".join(chunks))
    except (ValueError, UnicodeError):
        raise ModelError("invalid_json", "请求必须是有效 JSON", 400) from None
    if not isinstance(value, dict):
        raise ModelError("invalid_json", "请求必须是 JSON 对象", 400)
    return value


def _api_router(service):
    router = APIRouter()

    @router.get("/profiles")
    def profiles():
        return {"profiles": service.profiles()}

    @router.put("/profiles/{profile_id}")
    async def put_profile(profile_id: str, request: Request):
        body = await payload(request)
        if set(body) - {"profile", "api_key", "clear_key"} or not isinstance(body.get("profile"), dict) or body["profile"].get("id") != profile_id:
            raise ModelError("profile_mismatch", "配置 ID 与路径不匹配或字段不受支持")
        if not isinstance(body.get("clear_key", False), bool):
            raise ModelError("invalid_key", "clear_key 必须是布尔值")
        return await run_in_threadpool(service.put_profile, body["profile"], api_key=body.get("api_key"), clear_key=body.get("clear_key", False))

    @router.get("/runs")
    def runs():
        return {"runs": service.runs()}

    @router.post("/runs")
    async def start(request: Request):
        body = await payload(request)
        if set(body) - {"request_id", "profile_id", "inputs", "files"}:
            raise ModelError("unsupported_input", "请求包含不支持的字段")
        return await run_in_threadpool(service.start, body.get("request_id"), body.get("profile_id"), body.get("inputs"), body.get("files", {}))

    @router.get("/runs/{request_id}")
    def read(request_id: str):
        return service.read(request_id)

    @router.post("/runs/{request_id}/poll")
    async def poll(request_id: str, request: Request):
        if await payload(request) != {}:
            raise ModelError("query_input", "查询只消费原任务冻结配置，不接受新输入")
        return await run_in_threadpool(service.poll, request_id)

    return router


def _ui_router(ui_directory=None):
    router = APIRouter()
    ui = Path(ui_directory) if ui_directory is not None else Path(__file__).parent / "ui"
    # Plain Response deliberately avoids FileResponse/StaticFiles stat-derived ETags.
    # The project forbids adding content/stat digests; only these fixed UI assets are served.
    @router.get("/")
    def index():
        if not (ui / "index.html").is_file():
            raise ModelError("ui_missing", "专属配置 UI 尚未与本机服务装配；API 模块不等于页面已交付", 503)
        return Response((ui / "index.html").read_bytes(), media_type="text/html")

    @router.get("/{filename}")
    def ui_file(filename: str):
        mime = {"app.mjs": "text/javascript", "config.mjs": "text/javascript", "styles.css": "text/css"}.get(filename)
        if not mime or not (ui / filename).is_file():
            raise ModelError("file_not_found", "页面文件不存在", 404)
        return Response((ui / filename).read_bytes(), media_type=mime)
    return router


def _new_app(*, local_port=None):
    app = FastAPI(title="Greenroom Local Models", docs_url=None, redoc_url=None, openapi_url=None)
    _configure_app(app, local_port=local_port)
    return app


def create_app(directory, *, port=3099, service=None, ui_directory=None):
    service = service or LocalModels(directory, transport=HTTPTransport(local_port=port))
    app = _new_app(local_port=port)
    app.state.local_models = service
    app.include_router(_api_router(service), prefix="/api/local-models")
    app.include_router(_ui_router(ui_directory), prefix="/local-models")

    @app.get("/")
    def home():
        return RedirectResponse("/local-models/", status_code=307)

    return app


def create_portal_apps(directory, *, port):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    service = LocalModels(directory, transport=HTTPTransport(local_port=port))
    api = _new_app()
    api.state.local_models = service
    api.include_router(_api_router(service))
    ui = _new_app()
    ui.include_router(_ui_router())
    return api, ui
