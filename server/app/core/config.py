"""Process configuration. Secrets stay in the environment, never in the image."""

from __future__ import annotations

import os
import re
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from app.identity.standalone import STANDALONE_MEMBER_ID

DSH_VERSION = json.loads(
    (Path(__file__).resolve().parents[3] / "runtime/dsh/package.json").read_text()
)["dependencies"]["@deepseek-ai/dsh"]


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    data_dir: str
    public_base_url: str
    auth_service_url: str
    auth_tenant_id: str
    auth_audience: str
    asset_service_url: str
    asset_tenant_id: str
    asset_workspace_id: str
    asset_scope_id: str
    gateway_service_url: str
    gateway_api_key: str
    staging_asset_token: str
    staging_gateway_token: str
    member_emails: dict[str, str]
    external_auth_enabled: bool
    internal_access_key: str
    cookie_secure: bool
    allow_insecure_public_url: bool
    environment: str = "development"
    build_sha: str = "development"
    gateway_models: tuple[str, ...] = ()
    upload_max_bytes: int = 50 * 1024 * 1024
    object_hosts: tuple[str, ...] = ("asset",)
    runtime_slots: dict = None
    runtime_session_key: str = ""
    runtime_tls_dir: str = ""
    dsh_version: str = DSH_VERSION
    openai_base_url: str = ""
    openai_api_key: str = ""
    local_member_id: str = ""
    local_user_id: str = ""
    local_tenant_id: str = ""
    standalone: bool = False
    local_bootstrap_token: str = ""
    local_asset: bool = False
    member_sleep_enabled: bool = False
    member_sleep_idle_ms: int = 30 * 60_000
    member_warm_idle_limit: int = 4
    member_resident_target: int = 4
    member_wake_concurrency: int = 2
    member_wake_timeout_ms: int = 90_000
    member_sleep_members: tuple[str, ...] = ()

    @property
    def origin(self) -> str:
        return self.public_base_url.rstrip("/")

    @property
    def auth_enabled(self) -> bool:
        return bool(self.auth_service_url)


def load_settings() -> Settings:
    public = os.environ.get("PUBLIC_BASE_URL", "https://greenroom.localhost:18443").rstrip("/")
    parsed = urlsplit(public)
    allow_insecure = _flag("ALLOW_INSECURE_PUBLIC_URL", False)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise RuntimeError("PUBLIC_BASE_URL must be an absolute http(s) origin")
    local_dev = parsed.hostname in {"localhost", "127.0.0.1"}
    if parsed.scheme != "https" and not (allow_insecure or local_dev):
        raise RuntimeError("PUBLIC_BASE_URL must be https unless ALLOW_INSECURE_PUBLIC_URL=true")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise RuntimeError("PUBLIC_BASE_URL must be an origin without a path")
    openai_base_url = os.environ.get("OPENAI_BASE_URL", "").strip().rstrip("/")
    openai_api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    standalone = True
    settings = Settings(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8788")),
        data_dir=os.environ.get("DATA_DIR", "./data"),
        public_base_url=public,
        auth_service_url="",
        auth_tenant_id="",
        auth_audience="greenroom-local",
        asset_service_url=os.environ.get("ASSET_SERVICE_URL", "").rstrip("/"),
        asset_tenant_id=STANDALONE_MEMBER_ID,
        asset_workspace_id=os.environ.get("ASSET_WORKSPACE_ID", "greenroom-local").strip(),
        asset_scope_id=os.environ.get("ASSET_SCOPE_ID", "greenroom").strip() or "greenroom",
        gateway_service_url=(openai_base_url.removesuffix("/v1")
                             or os.environ.get("GATEWAY_SERVICE_URL", "").rstrip("/")),
        gateway_api_key=openai_api_key or os.environ.get("GATEWAY_API_KEY", ""),
        openai_base_url=openai_base_url,
        openai_api_key=openai_api_key,
        staging_asset_token=os.environ.get("GREENROOM_STAGING_ASSET_TOKEN", ""),
        staging_gateway_token=os.environ.get("GREENROOM_STAGING_GATEWAY_TOKEN", ""),
        member_emails={},
        external_auth_enabled=False,
        internal_access_key="",
        cookie_secure=parsed.scheme == "https" or parsed.hostname in {"localhost", "127.0.0.1"},
        allow_insecure_public_url=allow_insecure,
        environment=os.environ.get("APP_ENV", "development"),
        local_member_id=STANDALONE_MEMBER_ID if standalone else os.environ.get("GREENROOM_LOCAL_MEMBER_ID", "").strip(),
        local_user_id=STANDALONE_MEMBER_ID if standalone else os.environ.get("GREENROOM_LOCAL_USER_ID", "").strip(),
        local_tenant_id=STANDALONE_MEMBER_ID if standalone else os.environ.get("GREENROOM_LOCAL_TENANT_ID", "").strip(),
        standalone=standalone,
        dsh_version=os.environ.get("GREENROOM_DSH_VERSION", DSH_VERSION) if standalone else DSH_VERSION,
        local_bootstrap_token=os.environ.get("GREENROOM_LOCAL_BOOTSTRAP_TOKEN", ""),
        local_asset=_flag("GREENROOM_LOCAL_ASSET", False),
        build_sha=os.environ.get("BUILD_SHA", "development"),
        gateway_models=tuple(x.strip() for x in os.environ.get("GATEWAY_MODELS", "").split(",") if x.strip()),
        upload_max_bytes=int(os.environ.get("UPLOAD_MAX_BYTES", str(50 * 1024 * 1024))),
        object_hosts=tuple(x.strip() for x in os.environ.get("ASSET_OBJECT_HOSTS", "asset").split(",") if x.strip()),
        runtime_slots=json.loads(os.environ.get("DSH_RUNTIME_SLOTS", "{}")),
        runtime_session_key=os.environ.get("DSH_SESSION_KEY", ""),
        runtime_tls_dir=os.environ.get("DSH_TLS_DIR", ""),
        member_sleep_enabled=_flag("MEMBER_SLEEP_ENABLED", False),
        member_sleep_idle_ms=int(os.environ.get("MEMBER_SLEEP_IDLE_MS", str(30 * 60_000))),
        member_warm_idle_limit=max(0, int(os.environ.get("MEMBER_WARM_IDLE_LIMIT", "4"))),
        member_resident_target=max(0, int(os.environ.get("MEMBER_RESIDENT_TARGET", "4"))),
        member_wake_concurrency=max(1, int(os.environ.get("MEMBER_WAKE_CONCURRENCY", "2"))),
        member_wake_timeout_ms=max(1_000, int(os.environ.get("MEMBER_WAKE_TIMEOUT_MS", str(90_000)))),
        # Absent, empty or whitespace means an empty set: automatic sleep then
        # applies to nobody. Membership never changes login or workbench access.
        member_sleep_members=tuple(x.strip() for x in os.environ.get("MEMBER_SLEEP_MEMBERS", "").split(",") if x.strip()),
    )
    validate_settings(settings)
    return settings


def validate_settings(settings: Settings) -> None:
    if not settings.standalone:
        raise RuntimeError("Greenroom requires its local standalone identity")
    local_identity = (settings.local_member_id, settings.local_user_id, settings.local_tenant_id)
    if settings.standalone:
        if settings.environment != "development" or settings.external_auth_enabled:
            raise RuntimeError("Standalone requires development with external auth disabled")
        if not settings.local_bootstrap_token.strip():
            raise RuntimeError("Standalone requires GREENROOM_LOCAL_BOOTSTRAP_TOKEN")
        if local_identity != (STANDALONE_MEMBER_ID,) * 3:
            raise RuntimeError("Standalone requires the fixed local identity")
    if any(local_identity):
        if settings.environment != "development" or settings.external_auth_enabled:
            raise RuntimeError("Local identity requires development with external auth disabled")
        if not all(local_identity):
            raise RuntimeError("Local identity requires member, test user and test tenant")
    if settings.local_asset:
        local_asset = urlsplit(settings.asset_service_url)
        try:
            local_asset_port = local_asset.port
        except ValueError:
            local_asset_port = 0
        local_origins = {"127.0.0.1", "localhost"}
        if settings.standalone:
            local_origins.add("greenroom.localhost")
        if (settings.environment != "development" or settings.external_auth_enabled
                or settings.auth_service_url or settings.auth_tenant_id
                or not all(local_identity)
                or urlsplit(settings.public_base_url).hostname not in local_origins
                or local_asset.scheme != "http"
                or local_asset.hostname not in {"127.0.0.1", "asset"}
                or not local_asset_port
                or local_asset.netloc != f"{local_asset.hostname}:{local_asset_port}"
                or local_asset.path or local_asset.query or local_asset.fragment
                or settings.asset_tenant_id != settings.local_tenant_id
                or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", settings.staging_asset_token)):
            raise RuntimeError("Local assets require local development identity, loopback public origin, and a private asset service origin and credential")
