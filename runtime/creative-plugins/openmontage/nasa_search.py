"""NASA-only metadata transport and provenance; never downloads media or grants rights."""
from dataclasses import asdict
from datetime import datetime, timezone
import json
import urllib.error
import urllib.parse
import urllib.request

POLICY_URL = "https://www.nasa.gov/nasa-brand-center/images-and-media/"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("NASA 元数据请求不跟随重定向")


def nasa_json(url, params=None):
    if not isinstance(url, str):
        raise ValueError("NASA 元数据地址无效")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.fragment):
        raise ValueError("只允许固定 NASA HTTPS 元数据端点")
    api = parsed.hostname == "images-api.nasa.gov" and (
        parsed.path == "/search" or parsed.path.startswith("/metadata/"))
    assets = parsed.hostname == "images-assets.nasa.gov" and parsed.path.endswith(".json")
    if not (api or assets):
        raise ValueError("只允许 NASA 搜索与原始 JSON 清单，不读取媒体或其它站点")
    if params is not None:
        if parsed.query:
            raise ValueError("NASA 搜索参数不能覆盖现有查询")
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError("NASA 元数据超出 2 MiB 限制")
        value = json.loads(body)
        if api and parsed.path == "/search":
            collection = value.get("collection") if isinstance(value, dict) else None
            items = collection.get("items") if isinstance(collection, dict) else None
            if (not isinstance(value, dict) or "error" in value or "errors" in value
                    or not isinstance(items, list) or not all(isinstance(item, dict) for item in items)):
                raise ValueError("NASA 搜索响应结构无效或包含业务错误；不作为空搜索结果")
        return value
    except (urllib.error.URLError, OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"NASA 元数据读取失败：{error}") from None


def search_nasa(query, kind="image", limit=1):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 160:
        raise ValueError("NASA 搜索词须为 1 至 160 个字符")
    if kind not in {"image", "video"} or type(limit) is not int or not 1 <= limit <= 3:
        raise ValueError("只允许图片或视频候选，每次最多 3 项")
    # Use the fixed upstream provider, not direct_clip_search, which immediately
    # downloads and may fan out to unrelated sources.
    from tools.video.stock_sources.nasa import NasaSource
    from tools.video.stock_sources.base import SearchFilters
    candidates = NasaSource().search(query.strip(), SearchFilters(kind=kind, per_page=limit))
    output = []
    for candidate in candidates:
        value = asdict(candidate)
        nasa_id = value["extra"].pop("nasa_id")
        item = value["extra"].pop("raw_search_item")
        endpoint = "https://images-api.nasa.gov/metadata/" + urllib.parse.quote(nasa_id, safe="")
        location = nasa_json(endpoint)["location"]
        metadata = nasa_json(location)
        value["nativeLicenseLabel"] = value.pop("license")
        value["rights"] = {"status": "unreviewed", "policyUrl": POLICY_URL}
        value["provenance"] = {"rawNasaId": nasa_id, "searchItem": item,
                               "metadataEndpoint": endpoint, "metadataLocation": location, "metadata": metadata}
        for field in ("width", "height", "duration"):
            if not value[field]:
                value[field] = None  # Provider zero means unknown, not measured.
        output.append(value)
    return {"source": "nasa", "query": query.strip(), "kind": kind,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "candidates": output, "mediaDownloaded": False}
