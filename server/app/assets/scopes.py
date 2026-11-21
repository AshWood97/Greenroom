"""Stable resource identifiers derived exclusively from verified identities."""
import hashlib
import json


def personal_scope(member) -> dict[str, str]:
    key = hashlib.sha256(json.dumps([member.tenant_id, member.user_id], separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return {
        "resource_tenant_id": member.tenant_id,
        "workspace_id": "ogr_" + key[:32],
        "kind": "project",
        "resource_id": "ogrp_" + key,
        "actor_id": member.user_id,
    }


def public_scope(settings, actor_id: str) -> dict[str, str]:
    candidates = [
        t.strip()
        for t in (settings.auth_tenant_id or "").replace(",", " ").split()
        if t.strip() and t.strip() != "*"
    ]
    tenant = candidates[0] if candidates else (settings.asset_tenant_id or "greenroom")
    return {"resource_tenant_id": tenant,
            "workspace_id": settings.asset_workspace_id, "kind": "organization",
            "resource_id": settings.asset_scope_id, "actor_id": actor_id}


def scope_query(scope: dict) -> dict[str, str]:
    return {"resource_tenant_id": scope["resource_tenant_id"], "scope_kind": scope["kind"],
            "scope_id": scope["resource_id"], "actor_id": scope["actor_id"]}


def scope_headers(scope: dict) -> dict[str, str]:
    return {"X-GREENROOM-Resource-Tenant": scope["resource_tenant_id"],
            "X-GREENROOM-Workspace-ID": scope["workspace_id"],
            "X-GREENROOM-Resource-Scope": scope["kind"],
            "X-GREENROOM-Resource-ID": scope["resource_id"], "X-GREENROOM-Actor-ID": scope["actor_id"]}
