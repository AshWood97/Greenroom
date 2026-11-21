"""Authenticated member usage and actual gateway charges."""

from __future__ import annotations

import time
from typing import Any, Literal

from fastapi import APIRouter, Response

from app.identity.auth import AuthError, current_member
from app.core.config import Settings
from app.governance.governance_store import GovernanceStore


def usage_router(settings: Settings, governance: GovernanceStore, *, transport=None) -> APIRouter:
    router = APIRouter(prefix="/api/usage")

    @router.get("/me")
    async def my_usage(
        response: Response,
        timeRange: Literal["all", "today", "7d", "30d"] = "all",
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        member = current_member.get()
        if member is None:
            raise AuthError(401, "请先登录")
        start_time = 0
        if timeRange != "all":
            start_time = int(time.time()) - {"today": 1, "7d": 7, "30d": 30}[timeRange] * 86400
        await governance.refresh_gateway_charges(
            settings, transport=transport, start_time=start_time, member_id=member.member_id,
        )
        summary = governance.get_usage_overview(start_time=start_time, member_id=member.member_id)
        logs, total = governance.get_usage_logs(
            limit=max(1, min(limit, 50)), offset=max(0, offset),
            start_time=start_time, member_id=member.member_id,
        )
        response.headers["Cache-Control"] = "no-store"
        return {
            "memberId": member.member_id,
            "timeRange": timeRange,
            "summary": summary,
            "logs": logs,
            "total": total,
        }

    return router
