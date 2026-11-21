"""Local-only configurable HTTP models. No corporate broker, billing or retry loop."""
from __future__ import annotations

import base64
import http.client
import ipaddress
import json
import re
import socket
import sqlite3
import ssl
import threading
import time
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

MAX_FILES = 10 * 1024 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
KINDS = {"image", "video", "text", "audio"}
TERMINAL = {"succeeded", "failed", "not_accepted"}


class ModelError(Exception):
    def __init__(self, code, message, status=422):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def require_id(value, label="ID"):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ModelError("invalid_id", f"{label} 仅支持 1–128 位字母、数字、下划线或连字符")
    return value


def address(url):
    if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 33 for c in url):
        raise ModelError("invalid_url", "地址须为不含空白的 HTTP/HTTPS URL")
    try:
        value = urlsplit(url)
        if value.scheme not in {"http", "https"} or not value.hostname or value.username is not None or value.password is not None or value.fragment:
            raise ValueError()
        _ = value.port
    except ValueError:
        raise ModelError("invalid_url", "仅支持 HTTP/HTTPS；URL 不得包含用户密码或片段") from None
    credential_names = {"key", "apikey", "token", "secret", "authorization", "signature", "accesstoken", "accesskey", "credential", "password"}
    if any(re.sub(r"[-_]", "", name).lower() in credential_names for name, _ in parse_qsl(value.query, keep_blank_values=True)):
        raise ModelError("url_secret", "请把凭据配置在服务端认证字段，不能放在 URL 查询参数")
    return value


def pointer(value, path, *, many=False):
    if not isinstance(path, str) or (path and not path.startswith("/")):
        raise ModelError("invalid_pointer", "响应映射须为 JSON Pointer，例如 /data/id")
    parts = [] if path == "" else [p.replace("~1", "/").replace("~0", "~") for p in path[1:].split("/")]
    def walk(item, rest):
        if not rest:
            return [item]
        p, tail = rest[0], rest[1:]
        if p == "*" and many:
            if not isinstance(item, list):
                return []
            return [v for child in item for v in walk(child, tail)]
        if isinstance(item, dict) and p in item:
            return walk(item[p], tail)
        if isinstance(item, list) and p.isdecimal() and int(p) < len(item):
            return walk(item[int(p)], tail)
        return []
    found = walk(value, parts)
    return found if many else (found[0] if len(found) == 1 else None)


def source_value(inputs, path):
    value = inputs
    if not isinstance(path, str) or not path:
        raise ModelError("invalid_field", "输入来源字段不能为空")
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            raise ModelError("missing_input", f"缺少输入字段：{path}")
        value = value[part]
    return value


def set_field(payload, path, value):
    if not isinstance(path, str) or not path or len(path) > 256:
        raise ModelError("invalid_field", "请求字段名无效")
    parts = path.split(".")
    if any(not p or p in {"__proto__", "prototype", "constructor"} for p in parts):
        raise ModelError("invalid_field", "请求字段路径无效")
    at = payload
    for part in parts[:-1]:
        if part not in at:
            at[part] = {}
        if not isinstance(at[part], dict):
            raise ModelError("field_conflict", "请求映射与固定字段冲突")
        at = at[part]
    at[parts[-1]] = value


def validate_profile(profile):
    if not isinstance(profile, dict):
        raise ModelError("invalid_profile", "配置须为 JSON 对象")
    p = json.loads(encode(profile))
    allowed = {"id", "name", "kind", "allow_private_network", "request", "auth", "response", "poll"}
    if set(p) - allowed:
        raise ModelError("unsupported_profile", "配置包含当前不支持的字段")
    require_id(p.get("id"), "配置 ID")
    if not isinstance(p.get("name"), str) or not p["name"].strip() or len(p["name"]) > 100 or p.get("kind") not in KINDS:
        raise ModelError("invalid_profile", "请填写名称和明确媒体类型")
    if not isinstance(p.get("allow_private_network", False), bool):
        raise ModelError("invalid_profile", "私网许可必须是布尔值")
    p["allow_private_network"] = p.get("allow_private_network", False)
    r = p.get("request", {})
    if not isinstance(r, dict) or set(r) - {"url", "method", "encoding", "constants", "fields", "files"}:
        raise ModelError("unsupported_request", "请求配置字段不受支持")
    address(r.get("url"))
    if r.get("method") not in {"GET", "POST", "PUT", "PATCH"} or r.get("encoding") not in {"json", "multipart"}:
        raise ModelError("unsupported_request", "只支持 GET/POST/PUT/PATCH 与 JSON 或 multipart 文件输入")
    for key in ("constants", "fields", "files"):
        if not isinstance(r.get(key, {}), dict):
            raise ModelError("invalid_request", "固定参数、字段映射和文件映射须为对象")
        r.setdefault(key, {})
    if (r["method"] == "GET" and r["encoding"] != "json") or (r["encoding"] == "json" and r["files"]):
        raise ModelError("unsupported_request", "文件只支持 multipart POST/PUT/PATCH；GET 输入作为查询参数")
    for target, source in r["fields"].items():
        set_field({}, target, None)
        if not isinstance(source, str) or not source:
            raise ModelError("invalid_field", "输入来源字段不能为空")
    for target, source in r["files"].items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", target) or not isinstance(source, str) or not source:
            raise ModelError("invalid_file_field", "文件字段名无效")
    a = p.setdefault("auth", {"type": "none"})
    if not isinstance(a, dict) or set(a) - {"type", "header"} or a.get("type") not in {"none", "bearer", "header"}:
        raise ModelError("unsupported_auth", "仅支持无认证、Bearer 或自定义 Key 请求头；特殊签名不支持")
    if a["type"] == "header":
        h = a.get("header", "")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,80}", h) or h.lower() in {"host", "cookie", "content-type", "content-length", "connection", "transfer-encoding", "proxy-authorization", "origin", "referer"}:
            raise ModelError("invalid_auth", "认证请求头名称不受支持")
    m = p.get("response", {})
    if not isinstance(m, dict) or set(m) - {"task_id_path", "status_path", "success_values", "failure_values", "not_accepted_values", "error_path", "outputs"}:
        raise ModelError("invalid_response", "响应配置字段不受支持")
    for key in ("task_id_path", "status_path", "error_path"):
        if m.get(key) == "":
            m[key] = None  # Optional UI mappings use blank for absent, not the JSON root.
        if m.get(key) is not None:
            pointer({}, m[key])
    groups = []
    for key in ("success_values", "failure_values", "not_accepted_values"):
        values = m.setdefault(key, [])
        if not isinstance(values, list) or any(not isinstance(v, (str, int, bool)) for v in values):
            raise ModelError("invalid_response", "状态值须为字符串/整数/布尔值数组")
        groups.append({encode(v) for v in values})
    if groups[0] & groups[1] or groups[0] & groups[2] or groups[1] & groups[2]:
        raise ModelError("invalid_response", "成功、失败、明确未受理状态值不得重叠")
    outputs = m.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        raise ModelError("missing_outputs", "请至少配置一项结果映射")
    for output in outputs:
        if not isinstance(output, dict) or set(output) != {"type", "path"} or output["type"] != p["kind"]:
            raise ModelError("invalid_outputs", "结果类型须与配置媒体类型一致")
        pointer({}, output["path"], many=True)
    poll = p.get("poll")
    if poll:
        if not isinstance(poll, dict) or set(poll) - {"url", "method", "task_id_field", "constants"} or poll.get("method") not in {"GET", "POST"}:
            raise ModelError("unsupported_poll", "查询仅支持 GET/POST JSON，不支持 WebSocket")
        url = poll.get("url", "")
        parsed_poll = address(url.replace("{task_id}", "id"))
        if "{task_id}" in urlsplit(url).netloc or "{task_id}" in urlsplit(url).scheme:
            raise ModelError("poll_origin", "原任务编号只能映射到 URL 路径或查询，不能改变目标主机")
        if "{task_id}" not in url and not poll.get("task_id_field"):
            raise ModelError("missing_poll_id", "查询须在 URL 或字段映射原任务编号")
        if poll.get("task_id_field"):
            set_field({}, poll["task_id_field"], "id")
        if not isinstance(poll.get("constants", {}), dict):
            raise ModelError("invalid_poll", "查询固定参数须为对象")
        # A key must never be forwarded to a second origin during task polling.
        if (address(url.replace("{task_id}", "id")).scheme, address(url.replace("{task_id}", "id")).netloc) != (address(r["url"]).scheme, address(r["url"]).netloc):
            raise ModelError("poll_origin", "查询地址必须与提交地址同源，避免把密钥转交其他主机")
    return p


def safe_error(value, secret=""):
    if not isinstance(value, (str, int, float)):
        return "服务商未返回可映射的具体原因"
    text = str(value)
    if secret:
        text = text.replace(secret, "[已隐藏密钥]")
    text = re.sub(r"(?i)(bearer\s+)\S+", r"\1[已隐藏]", text)
    text = re.sub(r"(?i)((?:key|token|secret|authorization|signature)\s*[=:]\s*)[^\s&,;]+", r"\1[已隐藏]", text)
    text = re.sub(r"https?://[^\s<>]+", "[上游地址]", text)
    return "".join(c for c in text[:600] if ord(c) >= 32)


def files_decoded(files):
    if not isinstance(files, dict) or len(files) > 16:
        raise ModelError("invalid_files", "文件必须为至多 16 项对象，不能传本地文件路径")
    total, decoded = 0, {}
    for key, entry in files.items():
        if not isinstance(entry, dict) or set(entry) != {"name", "mime", "base64"}:
            raise ModelError("invalid_file", "文件须包含 name、mime、base64，不接受本地路径")
        name, mime, data = entry["name"], entry["mime"], entry["base64"]
        if not isinstance(name, str) or not name or any(c in name for c in '\r\n"/\\') or len(name) > 200:
            raise ModelError("invalid_filename", "文件名须是不含路径的普通名称")
        if not isinstance(mime, str) or not re.fullmatch(r"[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+", mime):
            raise ModelError("invalid_mime", "文件 MIME 类型无效")
        if not isinstance(data, str) or len(data) > MAX_FILES * 4 // 3 + 4:
            raise ModelError("file_too_large", "全部文件上限 10 MiB")
        try:
            content = base64.b64decode(data, validate=True)
        except (ValueError, base64.binascii.Error):
            raise ModelError("invalid_file", "文件 base64 无效") from None
        total += len(content)
        if total > MAX_FILES:
            raise ModelError("file_too_large", "全部文件上限 10 MiB")
        decoded[key] = (name, mime, content)
    return decoded


def build_request(profile, inputs, files):
    if not isinstance(inputs, dict):
        raise ModelError("invalid_inputs", "输入须为对象")
    config = profile["request"]
    payload = json.loads(encode(config["constants"]))
    for target, source in config["fields"].items():
        set_field(payload, target, source_value(inputs, source))
    decoded = files_decoded(files)
    if set(decoded) != set(config["files"].values()):
        raise ModelError("file_mapping", "提供的文件须与配置文件字段一致，不读取任何本地路径")
    if config["encoding"] == "json":
        return json_request(config["url"], config["method"], payload)
    # Pick a plain boundary absent from these bytes. No digest/fingerprint is computed.
    boundary = "greenroom-local-multipart"
    blobs = [content for _, _, content in decoded.values()] + [encode(payload).encode()]
    while any(boundary.encode() in content for content in blobs):
        boundary += "x"
    chunks = []
    for key, value in payload.items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", key):
            raise ModelError("invalid_field", "multipart 顶层字段名无效")
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        chunks.append((value if isinstance(value, str) else encode(value)).encode() + b"\r\n")
    for field, input_key in config["files"].items():
        name, mime, content = decoded[input_key]
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
        chunks.append(content + b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return config["url"], config["method"], b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def json_request(url, method, payload):
    if method == "GET":
        params = [(key, value if isinstance(value, str) else encode(value)) for key, value in payload.items()]
        query = urlencode(params)
        return url + (("&" if "?" in url else "?") + query if query else ""), method, None, "application/json"
    return url, method, encode(payload).encode(), "application/json"


class HTTPTransport:
    """Single bounded request, pinned DNS destination, no redirect or env proxy."""
    def __init__(self, *, resolver=socket.getaddrinfo, timeout=30, local_port=None):
        self.resolver, self.timeout, self.local_port = resolver, timeout, local_port

    def request(self, url, method, body, content_type, *, profile, secret):
        target = address(url)
        port = target.port or (443 if target.scheme == "https" else 80)
        try:
            choices = self.resolver(target.hostname, port, type=socket.SOCK_STREAM)
        except OSError:
            raise ModelError("dns_failed", "服务地址解析失败；请求尚未发送") from None
        if not choices:
            raise ModelError("dns_failed", "服务地址未解析；请求尚未发送")
        addresses = []
        for item in choices:
            ip = ipaddress.ip_address(item[4][0])
            if getattr(ip, "ipv4_mapped", None):
                ip = ip.ipv4_mapped
            if ip.is_link_local or ip.is_multicast or ip.is_unspecified or (ip.is_reserved and not ip.is_loopback):
                raise ModelError("unsafe_address", "不允许元数据/链路本地、组播、未指定或保留地址")
            if ip.is_loopback and port == self.local_port:
                raise ModelError("self_target", "不能把本机配置服务自身用作模型地址")
            if not ip.is_global and not profile.get("allow_private_network", False):
                raise ModelError("private_address", "服务地址是本机/私网；须先在该配置中明确允许")
            addresses.append(str(ip))
        connect_host = addresses[0]
        if target.scheme == "https":
            class PinnedHTTPS(http.client.HTTPSConnection):
                def connect(self):
                    raw = socket.create_connection((connect_host, port), timeout=self.timeout)
                    self.sock = self._context.wrap_socket(raw, server_hostname=target.hostname)
            connection = PinnedHTTPS(target.hostname, port, timeout=self.timeout, context=ssl.create_default_context())
        else:
            connection = http.client.HTTPConnection(connect_host, port, timeout=self.timeout)
        headers = {"Host": target.netloc, "Accept": "application/json", "Content-Type": content_type}
        auth = profile["auth"]
        if auth["type"] == "bearer":
            headers["Authorization"] = "Bearer " + secret
        elif auth["type"] == "header":
            headers[auth["header"]] = secret
        path = target.path or "/"
        if target.query:
            path += "?" + target.query
        try:
            # Connect first: failure here proves no HTTP request was sent.
            connection.connect()
        except (OSError, ssl.SSLError):
            connection.close()
            raise ModelError("connect_failed", "连接失败；HTTP 请求尚未发送") from None
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            content = response.read(MAX_RESPONSE + 1)
            if len(content) > MAX_RESPONSE:
                raise RuntimeError("response too large")
            try:
                value = json.loads(content)
            except (ValueError, UnicodeError):
                value = None
            return response.status, value
        finally:
            connection.close()


class LocalModels:
    def __init__(self, directory, *, transport=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / "models.sqlite3"
        if self.path.is_symlink():
            raise ModelError("unsafe_store", "模型配置数据库不能是符号链接", 500)
        self.transport = transport or HTTPTransport()
        self.lock = threading.RLock()
        self.polling = set()
        # Same-process receipt retention only; not a crash-durable journal.
        self.pending_receipts = {}
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, profile TEXT NOT NULL, secret TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        self.path.chmod(0o600)

    def db(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def put_profile(self, profile, *, api_key=None, clear_key=False):
        p = validate_profile(profile)
        if api_key is not None and (not isinstance(api_key, str) or len(api_key) > 4096 or any(ord(c) < 32 or ord(c) > 126 for c in api_key)):
            raise ModelError("invalid_key", "Key 须为不含控制字符的 ASCII 文本")
        if clear_key and api_key:
            raise ModelError("key_conflict", "不能同时设置与清除 Key")
        with self.lock, self.db() as db:
            old = db.execute("SELECT profile,secret FROM profiles WHERE id=?", (p["id"],)).fetchone()
            if old and api_key is None and not clear_key and p["auth"]["type"] != "none":
                previous = json.loads(old["profile"])
                old_url, new_url = address(previous["request"]["url"]), address(p["request"]["url"])
                if (old_url.scheme, old_url.netloc, previous["auth"]) != (new_url.scheme, new_url.netloc, p["auth"]):
                    raise ModelError("key_destination_changed", "目标主机或认证方式改变，请明确重新填写 Key；不会转交原保存密钥")
            key = "" if clear_key or p["auth"]["type"] == "none" else (api_key if api_key is not None else (old["secret"] if old else ""))
            db.execute("INSERT INTO profiles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,secret=excluded.secret", (p["id"], encode(p), key))
        return {**p, "has_key": bool(key)}

    def profiles(self):
        with self.db() as db:
            return [{**json.loads(row["profile"]), "has_key": bool(row["secret"])} for row in db.execute("SELECT * FROM profiles ORDER BY id")]

    def read_raw(self, request_id):
        require_id(request_id, "请求 ID")
        with self.lock:
            if request_id in self.pending_receipts:
                return json.loads(encode(self.pending_receipts[request_id]))
            with self.db() as db:
                row = db.execute("SELECT record FROM runs WHERE id=?", (request_id,)).fetchone()
            if not row:
                raise ModelError("run_not_found", "未找到本机原请求；不要因未知回执自动重发", 404)
            return json.loads(row["record"])

    def view(self, record):
        allowed = {"request_id", "profile_id", "state", "provider_task_id", "outputs", "error", "last_query_error", "created_at", "updated_at"}
        pending = record["request_id"] in self.pending_receipts
        view = {k: record.get(k) for k in allowed}
        if pending:
            view["error"] = "本机回执尚未保存；原任务编号/结果仅保留在当前进程。请勿关闭服务；点击原任务查询先重试保存，不会重新提交。" + (" " + view["error"] if view["error"] else "")
        return {**view, "receipt_pending": pending,
                "can_poll": pending or bool(record.get("provider_task_id") and record["profile"].get("poll") and record["state"] not in TERMINAL)}

    def runs(self):
        with self.db() as db:
            # SQLite rowid records insertion order; no input, Key or raw payload leaves the server.
            rows = db.execute("SELECT record FROM runs ORDER BY rowid DESC LIMIT 100").fetchall()
        with self.lock:
            return [self.view(self.pending_receipts.get(record["request_id"], record))
                    for record in (json.loads(row["record"]) for row in rows)]

    def read(self, request_id):
        return self.view(self.read_raw(request_id))

    def save(self, record):
        record["updated_at"] = time.time()
        with self.db() as db:
            updated = db.execute("UPDATE runs SET record=? WHERE id=?", (encode(record), record["request_id"]))
            if updated.rowcount != 1:
                raise sqlite3.OperationalError("original run record unavailable")

    def retain_receipt(self, record):
        # Caller holds self.lock. Retain before attempting UPDATE/commit, including
        # commits that may have succeeded even though their acknowledgement failed.
        request_id = record["request_id"]
        self.pending_receipts[request_id] = json.loads(encode(record))
        try:
            self.save(record)
        except (sqlite3.Error, OSError):
            return False
        self.pending_receipts.pop(request_id, None)
        return True

    def start(self, request_id, profile_id, inputs, files=None):
        require_id(request_id, "请求 ID")
        require_id(profile_id, "配置 ID")
        files = {} if files is None else files
        identity = encode({"profile_id": profile_id, "inputs": inputs, "files": files})
        with self.lock:
            pending = self.pending_receipts.get(request_id)
            if pending is not None:
                if pending["identity"] != identity:
                    raise ModelError("request_conflict", "原请求 ID 已绑定不同输入；保留原任务，新的生成须由用户明确使用新 ID", 409)
                record = json.loads(encode(pending))
                self.retain_receipt(record)
                return self.view(record)
        with self.lock, self.db() as db:
            old = db.execute("SELECT record FROM runs WHERE id=?", (request_id,)).fetchone()
            if old:
                record = self.pending_receipts.get(request_id) or json.loads(old["record"])
                if record["identity"] != identity:
                    raise ModelError("request_conflict", "原请求 ID 已绑定不同输入；保留原任务，新的生成须由用户明确使用新 ID", 409)
                return self.view(record)
            row = db.execute("SELECT profile,secret FROM profiles WHERE id=?", (profile_id,)).fetchone()
            if not row:
                raise ModelError("profile_not_found", "未配置此模型", 404)
            profile = json.loads(row["profile"])
            if profile["auth"]["type"] != "none" and not row["secret"]:
                raise ModelError("missing_key", "此配置未保存 Key；新请求尚未发送")
            request = build_request(profile, inputs, files)
            record = {"request_id": request_id, "profile_id": profile_id, "identity": identity,
                      "profile": profile, "secret": row["secret"], "state": "acceptance_unknown", "provider_task_id": None,
                      "outputs": [], "error": "提交回执尚未确认；不会自动重发", "last_query_error": None,
                      "created_at": time.time(), "updated_at": time.time()}
            db.execute("INSERT INTO runs VALUES (?,?)", (request_id, encode(record)))
        # Durable attempted state precedes network. A process crash cannot re-submit it.
        try:
            status, data = self.transport.request(*request, profile=profile, secret=record["secret"])
            self.observe(record, status, data, submitting=True)
        except ModelError as exc:
            record.update(state="not_accepted", error=exc.message)
        except Exception:
            record.update(error="提交回执无法确认；保留原请求，不会自动重发")
        with self.lock:
            self.retain_receipt(record)
        return self.view(record)

    def observe(self, record, http_status, data, *, submitting):
        p, secret = record["profile"], record["secret"]
        mapping = p["response"]
        if not isinstance(data, (dict, list)):
            if submitting:
                record["error"] = f"HTTP {http_status} 未返回可映射 JSON；受理结果未知"
            else:
                record["last_query_error"] = f"HTTP {http_status} 查询未返回可映射 JSON；原任务状态保留"
            return
        new_id = pointer(data, mapping["task_id_path"]) if mapping.get("task_id_path") is not None else None
        if isinstance(new_id, int) and not isinstance(new_id, bool):
            new_id = str(new_id)
        if isinstance(new_id, str) and new_id.strip():
            if secret and secret in new_id:
                record["error"] = "任务编号包含认证信息，不能公开或用于查询；请检查映射"
                return
            if record["provider_task_id"] and record["provider_task_id"] != new_id:
                record["last_query_error"] = "服务商返回冲突的任务编号，原任务身份保持不变"
                return
            record["provider_task_id"] = new_id
            if record["state"] not in TERMINAL:
                record["state"] = "accepted"
        status = pointer(data, mapping["status_path"]) if mapping.get("status_path") is not None else None
        status_key = encode(status)
        match = lambda name: status_key in {encode(v) for v in mapping.get(name, [])}
        message = safe_error(pointer(data, mapping["error_path"]) if mapping.get("error_path") is not None else None, secret)
        if not submitting and (http_status < 200 or http_status >= 300):
            record["last_query_error"] = f"HTTP {http_status}：{message}；原任务状态保留，仅查询原 ID"
            return
        if match("not_accepted_values") and not record["provider_task_id"] and submitting:
            record.update(state="not_accepted", error=message)
            return
        if http_status < 200 or http_status >= 300:
            key = "error" if submitting else "last_query_error"
            record[key] = f"HTTP {http_status}：{message}；不会自动重新提交"
            return
        if match("failure_values"):
            record.update(state="failed", error=message)
            return
        outputs = []
        invalid = False
        for spec in mapping["outputs"]:
            for value in pointer(data, spec["path"], many=True):
                if not isinstance(value, str) or not value:
                    invalid = True
                    continue
                if spec["type"] == "text":
                    outputs.append({"type": "text", "text": value.replace(secret, "[已隐藏密钥]") if secret else value})
                else:
                    try:
                        parts = urlsplit(value)
                        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username is not None or parts.password is not None or any(ord(c) < 32 for c in value) or (secret and secret in value):
                            raise ValueError()
                    except ValueError:
                        invalid = True
                        continue
                    outputs.append({"type": spec["type"], "url": value})
        finished = match("success_values") or (mapping.get("status_path") is None and bool(outputs))
        if finished and outputs and not invalid:
            record.update(state="succeeded", outputs=outputs, error=None, last_query_error=None)
        elif finished:
            record["error"] = "服务商声明完成，但结果映射缺失或无效；保留原任务，仅可查询原 ID"
        elif record["provider_task_id"]:
            record.update(state="accepted", error=None, last_query_error=None)
        else:
            record["error"] = "响应未能确认受理或结果；保留原请求，不会自动重发"

    def poll(self, request_id):
        with self.lock:
            record = self.read_raw(request_id)
            if request_id in self.pending_receipts:
                # This call only acknowledges local persistence. A later explicit
                # poll may query the provider; never query while receipt is unsaved.
                self.retain_receipt(record)
                return self.view(record)
            if record["state"] in TERMINAL:
                return self.view(record)
            if not record["provider_task_id"] or not record["profile"].get("poll"):
                raise ModelError("query_unavailable", "没有已确认的原任务 ID 或查询配置；不能自动重发")
            if request_id in self.polling:
                raise ModelError("query_busy", "原任务已有查询进行中，本次未排队；稍后读取本机状态", 409)
            self.polling.add(request_id)
        try:
            config = record["profile"]["poll"]
            url = config["url"].replace("{task_id}", quote(record["provider_task_id"], safe=""))
            actual, original = address(url), address(record["profile"]["request"]["url"])
            if (actual.scheme, actual.netloc) != (original.scheme, original.netloc):
                raise ModelError("poll_origin", "原任务查询地址发生跨主机变化；未发送密钥或查询")
            body = json.loads(encode(config.get("constants", {})))
            if config.get("task_id_field"):
                set_field(body, config["task_id_field"], record["provider_task_id"])
            try:
                response = self.transport.request(*json_request(url, config["method"], body), profile=record["profile"], secret=record["secret"])
                self.observe(record, *response, submitting=False)
            except Exception:
                record["last_query_error"] = "原任务查询暂不可用；已知任务与结果保留，不会重新生成"
            with self.lock:
                self.retain_receipt(record)
            return self.view(record)
        finally:
            with self.lock:
                self.polling.discard(request_id)
