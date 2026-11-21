"""Public view of the configured local Greenroom identity."""

from app.identity.standalone import STANDALONE_MEMBER, STANDALONE_MEMBER_ID

ROSTER = (STANDALONE_MEMBER,)
ROSTER_BY_ID = {STANDALONE_MEMBER_ID: STANDALONE_MEMBER}

def public_member(member: dict[str, str]) -> dict[str, object]:
    aliases = [alias for alias in member["aliases"].split(",") if alias]
    return {
        "id": member["id"],
        "name": member["name"],
        "displayName": member["display_name"],
        "role": member["role"],
        "avatarInitials": member["avatar_initials"],
        "avatarBgColor": member["avatar_bg_color"],
        "avatarTextColor": member["avatar_text_color"],
        "aliases": aliases,
    }


def directory() -> list[dict[str, object]]:
    return [public_member(member) for member in ROSTER]
