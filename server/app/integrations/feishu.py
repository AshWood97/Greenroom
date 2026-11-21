"""Feishu/Lark CLI integration with strict per-member isolation.

Each roster member gets an isolated configuration directory:
  <data_dir>/feishu_users/<member_id>/config/
Credentials, access tokens, device codes, and history are NEVER shared,
NEVER exposed to frontend, and NEVER printed to application logs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request
from app.identity.auth import AuthError, current_member
from app.core.roster import ROSTER, ROSTER_BY_ID
from app.identity.standalone import STANDALONE_MEMBER_ID

logger = logging.getLogger("greenroom.feishu")


def _mask_openid(openid: Optional[str]) -> Optional[str]:
    if not openid or not isinstance(openid, str):
        return None
    cleaned = openid.strip()
    if len(cleaned) <= 8:
        return "****"
    return f"{cleaned[:4]}****{cleaned[-4:]}"

# Predefined safe business read operations mapped to immutable argument tuples.
# Auth status & token introspection are strictly handled via get_status().
SAFE_OPERATIONS: dict[str, tuple[str, ...]] = {
    "whoami": ("whoami",),
    "docs_list": ("docs", "list", "--json"),
    "drive_list": ("drive", "list", "--json"),
    "calendar_list": ("calendar", "list", "--json"),
    "task_list": ("task", "list", "--json"),
}


def _find_lark_cli() -> Optional[str]:
    # Prefer direct binary over shell wrapper to ensure HOME isolation doesn't break wrapper
    pnpm_glob = list(Path.home().glob(".local/share/pnpm/global/*/*/node_modules/@larksuite/cli/bin/lark-cli"))
    if pnpm_glob and pnpm_glob[0].exists() and os.access(pnpm_glob[0], os.X_OK):
        return str(pnpm_glob[0])
    found = shutil.which("lark-cli")
    if found:
        return found
    candidates = [
        Path.home() / ".local" / "bin" / "lark-cli",
        Path("/usr/local/bin/lark-cli"),
        Path.home() / ".local" / "share" / "pnpm" / "global" / "bin" / "lark-cli",
    ]
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


class FeishuService:
    def __init__(self, data_dir: Path):
        self.base_dir = data_dir / "feishu_users"
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.cli_path = _find_lark_cli()
        self._master_config_path = self._discover_master_config()

    def _discover_master_config(self) -> Optional[Path]:
        std_path = Path.home() / ".lark-cli" / "config.json"
        if std_path.exists():
            return std_path
        return None

    def get_user_dirs(self, member_id: str) -> tuple[Path, Path]:
        if member_id not in ROSTER_BY_ID:
            raise AuthError(403, "非受邀名单成员")
        user_dir = self.base_dir / member_id
        config_dir = user_dir / "config"
        home_dir = user_dir / "home"
        config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        home_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        return config_dir, home_dir

    def _resolve_app_secret(self, raw_secret: Any) -> Any:
        env_secret = os.environ.get("FEISHU_APP_SECRET", "").strip()
        if env_secret:
            return env_secret
        if isinstance(raw_secret, str) and raw_secret.strip():
            return raw_secret.strip()
        if isinstance(raw_secret, dict) and raw_secret.get("source") == "keychain":
            item_id = raw_secret.get("id")
            if item_id:
                try:
                    res = subprocess.run(
                        ["security", "find-generic-password", "-s", item_id, "-w"],
                        capture_output=True,
                        text=True,
                        timeout=3,
                    )
                    if res.returncode == 0 and res.stdout.strip():
                        return res.stdout.strip()
                except Exception:
                    pass
        return raw_secret

    def ensure_user_config(self, member_id: str) -> Path:
        config_dir, _ = self.get_user_dirs(member_id)
        config_file = config_dir / "config.json"
        env_app_id = os.environ.get("FEISHU_APP_ID", "cli_aae2d14050f89bef")
        env_secret = os.environ.get("FEISHU_APP_SECRET", "").strip() or None

        base_apps = []
        if self._master_config_path and self._master_config_path.exists():
            try:
                with open(self._master_config_path, "r", encoding="utf-8") as f:
                    master_data = json.load(f)
                base_apps = [
                    {
                        "appId": a.get("appId"),
                        "appSecret": self._resolve_app_secret(a.get("appSecret")),
                        "brand": a.get("brand", "feishu"),
                        "users": [],
                    }
                    for a in master_data.get("apps", [])
                    if a.get("appId")
                ]
            except Exception as exc:
                logger.warning("Failed to read master lark-cli config: %s", exc)

        if not base_apps:
            base_apps = [
                {
                    "appId": env_app_id,
                    "appSecret": self._resolve_app_secret(None),
                    "brand": "feishu",
                    "users": [],
                }
            ]

        if not config_file.exists():
            isolated_config = {"apps": base_apps}
            config_file.write_text(json.dumps(isolated_config, ensure_ascii=False, indent=2), encoding="utf-8")
            os.chmod(config_file, 0o600)
        else:
            # If config already exists but has empty/dict keychain secret while env secret is present, patch it
            try:
                conf = json.loads(config_file.read_text(encoding="utf-8"))
                modified = False
                for app in conf.get("apps", []):
                    current_secret = app.get("appSecret")
                    resolved = self._resolve_app_secret(current_secret)
                    if resolved and resolved != current_secret:
                        app["appSecret"] = resolved
                        modified = True
                if modified:
                    config_file.write_text(json.dumps(conf, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception as exc:
                logger.warning("Failed to auto-repair user config %s: %s", member_id, exc)

        return config_file

    def _exec_cli(
        self, member_id: str, command_args: list[str], timeout: int = 20
    ) -> tuple[int, str, str]:
        if not self.cli_path:
            raise AuthError(503, "系统未安装或未定位到 lark-cli 运行环境")
        config_dir, home_dir = self.get_user_dirs(member_id)
        self.ensure_user_config(member_id)

        env = os.environ.copy()
        env["HOME"] = str(home_dir)
        env["LARKSUITE_CLI_CONFIG_DIR"] = str(config_dir)
        env["LANG"] = "en_US.UTF-8"
        env["LC_ALL"] = "en_US.UTF-8"

        full_cmd = [str(self.cli_path)] + command_args
        try:
            res = subprocess.run(
                full_cmd,
                env=env,
                shell=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return res.returncode, res.stdout, res.stderr
        except subprocess.TimeoutExpired:
            raise AuthError(504, "飞书 CLI 执行超时")
        except Exception as exc:
            logger.error("CLI execution failed for member %s: %s", member_id, exc)
            raise AuthError(500, "飞书 CLI 执行失败")

    def get_status(self, member_id: str) -> dict[str, Any]:
        self.ensure_user_config(member_id)
        if not self.cli_path:
            return {
                "available": False,
                "is_logged_in": False,
                "message": "宿主机未检测到 lark-cli 运行环境",
            }
        code, stdout, stderr = self._exec_cli(member_id, ["auth", "status", "--json"])
        if code != 0 and not stdout:
            try:
                err_json = json.loads(stderr or "{}")
                msg = err_json.get("error", {}).get("message", "未配置")
            except Exception:
                msg = stderr.strip() or "未登录"
            return {
                "available": True,
                "is_logged_in": False,
                "message": msg,
                "user": None,
            }
        try:
            data = json.loads(stdout or stderr or "{}")
            identities = data.get("identities", {})
            user_info = identities.get("user", {})
            is_valid = user_info.get("status") == "ready" and user_info.get("available") is True
            raw_scopes = user_info.get("scope", "")
            scope_list = [s.strip() for s in raw_scopes.split() if s.strip()] if isinstance(raw_scopes, str) else []
            return {
                "available": True,
                "is_logged_in": is_valid,
                "appId": data.get("appId"),
                "brand": data.get("brand", "feishu"),
                "message": user_info.get("message", "已就绪" if is_valid else "未登录"),
                "user": {
                    "openId": user_info.get("openId"),
                    "userName": user_info.get("userName"),
                    "tokenStatus": user_info.get("tokenStatus"),
                    "expiresAt": user_info.get("expiresAt"),
                    "refreshExpiresAt": user_info.get("refreshExpiresAt"),
                    "scopes": scope_list,
                }
                if is_valid
                else None,
            }
        except Exception as exc:
            logger.error("Failed to parse auth status for %s: %s", member_id, exc)
            return {
                "available": True,
                "is_logged_in": False,
                "message": "状态解析异常",
                "user": None,
            }

    def start_auth(self, member_id: str) -> dict[str, Any]:
        user_dir = self.base_dir / member_id
        code, stdout, stderr = self._exec_cli(
            member_id,
            ["auth", "login", "--no-wait", "--json", "--domain", "calendar,task,docs,drive,im"],
        )
        if code != 0:
            err_msg = "发起飞书授权失败"
            try:
                err_data = json.loads(stderr or stdout or "{}")
                err_msg = err_data.get("error", {}).get("message") or err_msg
            except Exception:
                if stderr.strip():
                    err_msg = stderr.strip()
            if "client_secret" in err_msg.lower():
                err_msg = "飞书设备授权失败：缺少 client_secret，请在服务端环境变量或Secret配置 FEISHU_APP_SECRET"
            raise AuthError(500, err_msg)
        try:
            data = json.loads(stdout)
            device_code = data.get("device_code")
            expires_in = data.get("expires_in", 600)
            verification_url = data.get("verification_url")
            user_code = data.get("user_code")
            if not user_code and verification_url and "user_code=" in verification_url:
                match = re.search(r"user_code=([A-Z0-9-]+)", verification_url)
                if match:
                    user_code = match.group(1)

            pending_file = user_dir / "auth_pending.json"
            pending_file.write_text(
                json.dumps(
                    {
                        "device_code": device_code,
                        "created_at": time.time(),
                        "expires_in": expires_in,
                        "verification_url": verification_url,
                        "user_code": user_code,
                    }
                ),
                encoding="utf-8",
            )
            os.chmod(pending_file, 0o600)
            return {
                "verification_url": verification_url,
                "user_code": user_code,
                "expires_in": expires_in,
            }
        except Exception as exc:
            logger.error("Failed to parse start_auth for %s: %s", member_id, exc)
            raise AuthError(500, "授权凭证解析失败")

    def poll_auth(self, member_id: str) -> dict[str, Any]:
        user_dir = self.base_dir / member_id
        pending_file = user_dir / "auth_pending.json"
        if not pending_file.exists():
            raise AuthError(400, "无进行中的授权流程，请先点击发起授权")
        try:
            pending_data = json.loads(pending_file.read_text(encoding="utf-8"))
            device_code = pending_data.get("device_code")
            created_at = pending_data.get("created_at", 0)
            expires_in = pending_data.get("expires_in", 600)
            if time.time() - created_at > expires_in:
                pending_file.unlink(missing_ok=True)
                raise AuthError(400, "授权已超时，请重新发起")
        except Exception as exc:
            if isinstance(exc, AuthError):
                raise
            raise AuthError(400, "授权状态损坏，请重新发起")

        # device_code is verified to be safe string
        if not isinstance(device_code, str) or not re.match(r"^[A-Za-z0-9._-]+$", device_code):
            pending_file.unlink(missing_ok=True)
            raise AuthError(400, "无效的设备授权码")

        code, stdout, stderr = self._exec_cli(
            member_id, ["auth", "login", "--device-code", device_code, "--json"], timeout=15
        )
        if code == 0:
            pending_file.unlink(missing_ok=True)
            status = self.get_status(member_id)
            return {
                "status": "ready",
                "message": "飞书授权成功",
                "user": status.get("user"),
            }
        err_msg = "等待用户在飞书中确认授权"
        try:
            err_data = json.loads(stderr or stdout or "{}")
            msg = err_data.get("error", {}).get("message", "")
            if "invalid" in msg.lower() or "expired" in msg.lower():
                pending_file.unlink(missing_ok=True)
                raise AuthError(400, "设备码已失效，请重新发起授权")
        except Exception as exc:
            if isinstance(exc, AuthError):
                raise
        return {
            "status": "pending",
            "message": err_msg,
        }

    def logout(self, member_id: str) -> dict[str, Any]:
        user_dir = self.base_dir / member_id
        pending_file = user_dir / "auth_pending.json"
        pending_file.unlink(missing_ok=True)
        try:
            self._exec_cli(member_id, ["auth", "logout", "--json"], timeout=10)
        except Exception as exc:
            logger.warning("CLI logout call failed for %s: %s", member_id, exc)

        config_file = user_dir / "config" / "config.json"
        if config_file.exists():
            try:
                data = json.loads(config_file.read_text(encoding="utf-8"))
                for app in data.get("apps", []):
                    app["users"] = []
                config_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                pass
        return {"success": True, "message": "已成功退出飞书授权并清除本地凭据"}

    def run_action(self, member_id: str, action: str) -> dict[str, Any]:
        if action not in SAFE_OPERATIONS:
            allowed = ", ".join(SAFE_OPERATIONS.keys())
            raise AuthError(403, f"不支持的操作: {action}。支持的操作: {allowed}")

        cmd_tuple = SAFE_OPERATIONS[action]
        code, stdout, stderr = self._exec_cli(member_id, list(cmd_tuple), timeout=25)
        parsed_result = None
        if stdout:
            try:
                parsed_result = json.loads(stdout)
            except Exception:
                parsed_result = stdout.strip()

        return {
            "success": code == 0,
            "action": action,
            "returncode": code,
            "result": parsed_result,
            "error": stderr.strip() if code != 0 else None,
        }

    def get_roster_status(self) -> dict[str, Any]:
        """Collect Feishu authorization statuses across all 19 roster members.

        Strictly reads metadata non-blockingly, strips tokens/credentials,
        masks OpenIDs, and never executes subprocesses for instant inspection.
        """
        members_status: list[dict[str, Any]] = []
        authorized_count = 0
        now = time.time()

        for member in ROSTER:
            member_id = member["id"]
            user_dir = self.base_dir / member_id
            config_file = user_dir / "config" / "config.json"
            pending_file = user_dir / "auth_pending.json"

            is_logged_in = False
            status_key = "unbound"
            status_text = "未绑定"
            feishu_user: dict[str, Any] | None = None

            # 1. 检查是否存在未过期的待确认授权流程
            if pending_file.exists():
                try:
                    p_data = json.loads(pending_file.read_text(encoding="utf-8"))
                    created_at = p_data.get("created_at", 0)
                    expires_in = p_data.get("expires_in", 600)
                    if now - created_at <= expires_in:
                        status_key = "pending"
                        status_text = "等待授权确认"
                except Exception:
                    pass

            # 2. 检查 config.json 中是否有 user
            has_configured_user = False
            stored_user_data: dict[str, Any] = {}
            if config_file.exists():
                try:
                    conf = json.loads(config_file.read_text(encoding="utf-8"))
                    for app in conf.get("apps", []):
                        users = app.get("users", [])
                        if users and isinstance(users, list) and len(users) > 0:
                            first_u = users[0]
                            if isinstance(first_u, dict) and (first_u.get("userOpenId") or first_u.get("openId") or first_u.get("userName")):
                                has_configured_user = True
                                stored_user_data = first_u
                                break
                except Exception:
                    pass

            # 3. 提取脱敏的用户元数据
            if has_configured_user:
                is_logged_in = True
                status_key = "ready"
                status_text = "已授权"
                raw_openid = stored_user_data.get("openId") or stored_user_data.get("userOpenId")
                raw_scopes = stored_user_data.get("scope", "")
                scope_list = [s.strip() for s in raw_scopes.split() if s.strip()] if isinstance(raw_scopes, str) else []
                feishu_user = {
                    "userName": stored_user_data.get("userName") or "已授权用户",
                    "openId": _mask_openid(raw_openid),
                    "expiresAt": stored_user_data.get("expiresAt"),
                    "scopes": scope_list,
                }
                authorized_count += 1

            members_status.append(
                {
                    "id": member_id,
                    "name": member["name"],
                    "displayName": member["display_name"],
                    "role": member["role"],
                    "avatarInitials": member["avatar_initials"],
                    "avatarBgColor": member["avatar_bg_color"],
                    "avatarTextColor": member["avatar_text_color"],
                    "isLoggedIn": is_logged_in,
                    "status": status_key,
                    "statusText": status_text,
                    "user": feishu_user,
                }
            )

        return {
            "summary": {
                "total": len(ROSTER),
                "authorizedCount": authorized_count,
                "unboundCount": len(ROSTER) - authorized_count,
                "cliAvailable": bool(self.cli_path),
            },
            "members": members_status,
        }


def feishu_router(service: FeishuService) -> APIRouter:
    router = APIRouter(prefix="/api/feishu")

    def require_member() -> str:
        member = current_member.get()
        if member is None:
            raise AuthError(401, "请先登录")
        return member.member_id

    def require_admin() -> str:
        member = current_member.get()
        if member is None:
            raise AuthError(401, "请先登录")
        if member.member_id != STANDALONE_MEMBER_ID:
            raise AuthError(403, "权限不足：仅唯一管理员（徐子寒）可查看全员飞书授权状态")
        return member.member_id

    @router.get("/roster-status")
    async def roster_status():
        require_admin()
        return await asyncio.to_thread(service.get_roster_status)

    @router.get("/status")
    async def status():
        member_id = require_member()
        return await asyncio.to_thread(service.get_status, member_id)

    @router.post("/auth/start")
    async def start():
        member_id = require_member()
        return await asyncio.to_thread(service.start_auth, member_id)

    @router.post("/auth/poll")
    async def poll():
        member_id = require_member()
        return await asyncio.to_thread(service.poll_auth, member_id)

    @router.post("/auth/logout")
    async def logout():
        member_id = require_member()
        return await asyncio.to_thread(service.logout, member_id)

    @router.post("/run")
    async def handle_run(request: Request):
        member_id = require_member()
        payload = await request.json()
        if not isinstance(payload, dict):
            raise AuthError(422, "请求格式无效")
        action = payload.get("action")
        if not isinstance(action, str) or not action:
            raise AuthError(422, "action 必须是非空字符串")
        return await asyncio.to_thread(service.run_action, member_id, action)

    return router
