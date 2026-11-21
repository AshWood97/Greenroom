"""Loopback Greenroom sessions, issued through the trusted local proxy."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
import secrets
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.requests import Request as StarletteRequest

from app.core.roster import public_member
from app.identity.standalone import STANDALONE_MEMBER, STANDALONE_MEMBER_ID


SESSION_COOKIE = "__Host-greenroom-session"
REFRESH_COOKIE = "__Host-greenroom-refresh"
LOCAL_BOOTSTRAP_HEADER = "x-greenroom-local-bootstrap"
INTERNAL_SESSION_SECONDS = 12 * 60 * 60
_SPOOFED_HEADERS = {
    b"x-user-id",
    b"x-tenant-id",
    b"x-user-info",
    b"x-userinfo",
    b"x-roles",
    b"x-service-token",
    b"x-greenroom-member",
}


class AuthError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


def error_response(exc: AuthError) -> JSONResponse:
    return JSONResponse({"detail": exc.message}, status_code=exc.status, headers={"Cache-Control": "no-store"})


@dataclass
class MemberSession:
    user_id: str
    tenant_id: str
    email: str
    member_id: str
    access_token: str
    session_id: str


current_member: ContextVar[MemberSession | None] = ContextVar("greenroom_member", default=None)


def request_token(request) -> str:
    return request.cookies.get(SESSION_COOKIE, "")


class AuthClient:
    enabled = False

    def __init__(self, settings, identities, sessions, *, transport=None):
        self.settings = settings
        self.sessions = sessions
        self.origin = settings.origin
        self._attempts = {}
        self._loop = None
        self._storage_pool = None
        self.runtime_revoke = None
        self.runtime_prewarm = lambda identity: None

    async def start(self):
        self._loop = asyncio.get_running_loop()
        self._storage_pool = ThreadPoolExecutor(max_workers=1)

    async def aclose(self):
        pool, self._storage_pool = self._storage_pool, None
        self._loop = None
        if pool is not None:
            await asyncio.to_thread(pool.shutdown, wait=True)

    async def storage_call(self, operation, *args, **kwargs):
        loop = asyncio.get_running_loop()
        if self._storage_pool is not None and self._loop is loop:
            return await loop.run_in_executor(self._storage_pool, partial(operation, *args, **kwargs))
        return await asyncio.to_thread(operation, *args, **kwargs)

    def same_origin(self, request) -> None:
        if request.headers.get("origin") != self.origin:
            raise AuthError(403, "请求来源校验失败")

    def rate_limit(self, request) -> None:
        now = time.monotonic()
        self._attempts = {key: value for key, value in self._attempts.items() if value[0] > now - 60}
        key = request.client.host if request.client else "unknown"
        start, count = self._attempts.get(key, (now, 0))
        if count >= 30 or len(self._attempts) > 4096:
            raise AuthError(429, "登录尝试过多，请稍后重试")
        self._attempts[key] = (start, count + 1)

    async def verify(self, token):
        if not token or await self.storage_call(self.sessions.resolve, token) != STANDALONE_MEMBER_ID:
            raise AuthError(401, "请先登录")
        return MemberSession(STANDALONE_MEMBER_ID, STANDALONE_MEMBER_ID, "",
                             STANDALONE_MEMBER_ID, token, "internal")

    def session_payload(self, identity):
        return {"user": public_member(STANDALONE_MEMBER), "loginAt": datetime.now(timezone.utc).isoformat()}


class AuthenticationMiddleware:
    def __init__(self, app, auth: AuthClient):
        self.app = app
        self.auth = auth

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        # 若已由前置可信运行时中间件完成凭据校验与身份绑定，则直接放行并注入上下文
        if scope.get("state", {}).get("member") is not None:
            context_token = current_member.set(scope["state"]["member"])
            try:
                return await self.app(scope, receive, send)
            finally:
                current_member.reset(context_token)
        path = scope["path"]
        public = {
            "/api/health",
            "/healthz",
            "/api/auth/options",
            "/api/auth/refresh",
            "/api/auth/logout",
        }
        if not path.startswith(("/api/", "/canvas/api/")) or path in public:
            return await self.app(scope, receive, send)
        request = StarletteRequest(scope, receive)
        context_token = None
        try:
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                self.auth.same_origin(request)
            identity = await self.auth.verify(request_token(request))
            scope["headers"] = [
                (key, value)
                for key, value in scope["headers"]
                if key.lower() not in _SPOOFED_HEADERS and not key.lower().startswith(b"x-greenroom-")
            ]
            scope.setdefault("state", {})["member"] = identity
            context_token = current_member.set(identity)

            async def private_send(message):
                if message["type"] == "http.response.start":
                    headers = [(key, value) for key, value in message["headers"] if key.lower() != b"cache-control"]
                    headers.append((b"cache-control", b"no-store"))
                    message["headers"] = headers
                await send(message)

            await self.app(scope, receive, private_send)
        except AuthError as exc:
            await error_response(exc)(scope, receive, send)
        finally:
            if context_token is not None:
                current_member.reset(context_token)


def auth_router(auth: AuthClient) -> APIRouter:
    router = APIRouter(prefix="/api/auth")
    flags = {"external_auth_active": False, "external_auth_available": False,
             "registration_enabled": False, "access_mode": "internal"}

    @router.get("/options")
    async def options():
        return {**flags, "roster_size": 1, "emails_configured": 1,
                "members_pending": 0, "local_member_name": STANDALONE_MEMBER["name"]}

    @router.post("/refresh")
    async def refresh(request: Request):
        auth.same_origin(request)
        supplied = request.headers.get(LOCAL_BOOTSTRAP_HEADER, "")
        expected = auth.settings.local_bootstrap_token
        if not expected or not secrets.compare_digest(supplied.encode(), expected.encode()):
            raise AuthError(403, "本地入口校验失败")
        auth.rate_limit(request)
        token = await auth.storage_call(auth.sessions.issue, STANDALONE_MEMBER_ID)
        identity = await auth.verify(token)
        auth.runtime_prewarm(identity)
        response = JSONResponse({"user_info": auth.session_payload(identity), **flags},
                                headers={"Cache-Control": "no-store"})
        response.set_cookie(SESSION_COOKIE, token, max_age=INTERNAL_SESSION_SECONDS,
                            secure=True, httponly=True, samesite="lax", path="/")
        return response

    @router.get("/me")
    async def me():
        identity = current_member.get()
        if identity is None:
            raise AuthError(401, "请先登录")
        return {**flags, "enabled": False, "user_info": auth.session_payload(identity),
                "members": [{**public_member(STANDALONE_MEMBER), "accountStatus": "configured"}]}

    @router.post("/logout")
    async def logout(request: Request):
        auth.same_origin(request)
        token = request_token(request)
        if auth.runtime_revoke is not None:
            await auth.runtime_revoke(token)
        if token:
            await auth.storage_call(auth.sessions.revoke, token)
        response = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
        for name in (SESSION_COOKIE, REFRESH_COOKIE):
            response.delete_cookie(name, secure=True, httponly=True, samesite="lax", path="/")
        return response

    return router
