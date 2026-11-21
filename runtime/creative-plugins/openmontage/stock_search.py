"""Bounded Commons/Archive metadata access; no media download or rights approval."""
from dataclasses import asdict
from datetime import datetime, timezone
import json
import re
import urllib.error
import urllib.parse
import urllib.request

WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"
ARCHIVE_SEARCH = "https://archive.org/advancedsearch.php"
USER_AGENT = "OpenMontageBot/0.1 (https://github.com/calesthio/OpenMontage)"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("素材元数据请求不跟随重定向")


def archive_metadata_url(identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", identifier):
        raise ValueError("Archive.org 素材编号无效")
    return "https://archive.org/metadata/" + identifier


def stock_json(source, url, params=None):
    if source not in ("wikimedia", "archive_org") or not isinstance(url, str):
        raise ValueError("素材来源或元数据地址无效")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.query or parsed.fragment):
        raise ValueError("只允许固定来源的 HTTPS 元数据端点")
    if source == "wikimedia":
        allowed = parsed.hostname == "commons.wikimedia.org" and parsed.path == "/w/api.php"
    else:
        allowed = parsed.hostname == "archive.org" and (parsed.path == "/advancedsearch.php"
            or re.fullmatch(r"/metadata/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", parsed.path))
    if not allowed:
        raise ValueError("只允许对应来源的搜索与 JSON 元数据，不读取媒体或其它站点")
    if params is not None:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError("素材元数据超出 2 MiB 限制")
        value = json.loads(body)
        if not isinstance(value, dict) or "error" in value or "errors" in value:
            raise ValueError("来源返回无效元数据或业务错误；不作为空搜索结果")
        if source == "wikimedia":
            if "query" in value:
                query = value["query"]
                pages = query.get("pages") if isinstance(query, dict) else None
                valid = isinstance(pages, dict) and all(isinstance(page, dict)
                    and ("imageinfo" not in page or isinstance(page["imageinfo"], list)
                         and all(isinstance(info, dict) for info in page["imageinfo"]))
                    for page in pages.values())
            else:
                # MediaWiki generator search legitimately omits query/pages on
                # no hits, but still returns its batchcomplete marker.
                valid = value.get("batchcomplete") is True or value.get("batchcomplete") == ""
        elif parsed.path == "/advancedsearch.php":
            response = value.get("response")
            docs = response.get("docs") if isinstance(response, dict) else None
            valid = isinstance(docs, list) and all(isinstance(doc, dict)
                and isinstance(doc.get("identifier"), str) and doc["identifier"] for doc in docs)
        else:
            valid = isinstance(value.get("metadata"), dict) and isinstance(value.get("files"), list)
            valid = valid and all(isinstance(item, dict) for item in value["files"])
        if not valid:
            raise ValueError("来源元数据响应结构无效；不作为空搜索结果")
        return value
    except (urllib.error.URLError, OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{source} 元数据读取失败：{error}") from None


def search_stock(source, query, kind="video", limit=1):
    if source not in ("wikimedia", "archive_org"):
        raise ValueError("仅支持 Wikimedia Commons 或 Archive.org")
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 160:
        raise ValueError("公开搜索词须为 1 至 160 个字符")
    if kind not in {"image", "video"} or type(limit) is not int or not 1 <= limit <= 3:
        raise ValueError("只允许图片或视频候选，每次最多 3 项")
    if source == "archive_org" and kind != "video":
        raise ValueError("当前 Archive.org 原生入口仅支持视频")
    from tools.video.stock_sources.base import SearchFilters
    if source == "wikimedia":
        from tools.video.stock_sources.wikimedia import WikimediaSource
        provider = WikimediaSource()
    else:
        from tools.video.stock_sources.archive_org import ArchiveOrgSource
        provider = ArchiveOrgSource()
    # prepare.mjs binds these fixed native providers to stock_json. A network or
    # parse error propagates immediately instead of triggering another query.
    candidates = provider.search(query.strip(), SearchFilters(kind=kind, per_page=limit))
    output = []
    for candidate in candidates:
        value = asdict(candidate)
        value["nativeLicenseLabel"] = value.pop("license")
        value["rights"] = {"status": "unreviewed"}
        value["provenance"] = value["extra"].pop("managed_provenance")
        for field in ("width", "height", "duration"):
            if not value[field]:
                value[field] = None
        output.append(value)
    return {"source": source, "query": query.strip(), "kind": kind,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "candidates": output, "mediaDownloaded": False}
