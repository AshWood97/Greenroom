"""Managed drama-skills business API and the original creator Dashboard.

The member runtime selects this process and its private root. Only the fixed
business operations below write a project; upstream CLI/export gates are not run.
"""
from __future__ import annotations

import contextlib
import importlib.util
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ.get("GREENROOM_PLUGIN_ROOT", "/var/lib/dsh/creative-plugins/drama-skills")).resolve()
PROJECTS = ROOT / "projects"
PROJECTS.mkdir(parents=True, exist_ok=True)
MANAGED = os.environ.get("GREENROOM_MANAGED_URL", "http://127.0.0.1:18767/managed").rstrip("/")
BASE = os.environ.get("GREENROOM_BASE_PATH", "/plugins/drama-skills/").rstrip("/")
LOCK = threading.RLock()
ACTIVE: set[str] = set()
DOCUMENTS = {
    "source": "输入/原著.txt", "creative-brief": "项目开发/creative-brief.md",
    "story-engine": "项目开发/story-engine.md", "episode-map": "项目开发/episode-map.jsonl",
    "script": "剧本.md", "visual-setting": "视觉设定.md", "storyboard": "分镜.md",
    "image-prompts": "图片提示词.md", "video-prompts": "视频提示词.md", "cut-list": "剪辑单.md",
    "review": "审查.md", "breakdown-report": "项目开发/对标拆解.md",
    "adaptation-map": "项目开发/adaptation-map.jsonl",
}
PROJECT_DOCUMENTS = {"source", "creative-brief", "story-engine", "episode-map", "adaptation-map", "breakdown-report"}
ANALYSIS_PARTS = {"progress": "_progress.md", "triage": "triage.md", "story-units": "story-units.md",
                  "rhythm-and-emotion": "rhythm-and-emotion.md", "characters": "characters.md", "world": "world.md",
                  "adaptation-value": "adaptation-value.md", "episode-candidates": "episode-candidates.jsonl"}
STAGES = {
    "creative-brief": "short-drama-develop", "story-engine": "short-drama-develop",
    "episode-map": "short-drama-develop", "adaptation-map": "short-drama-develop", "script": "short-drama-write",
    "visual-setting": "short-drama-assets", "storyboard": "short-drama-storyboard",
    "image-prompts": "short-drama-image-prompts", "video-prompts": "short-drama-video-prompts",
    "cut-list": "short-drama-edit", "review": "short-drama-review",
    "breakdown-report": "short-drama-breakdown",
}
SKILLS = {"short-drama", "short-drama-novel-analyze", *STAGES.values(), "short-drama-produce"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def project(project_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(project_id)):
        raise ValueError("项目编号无效")
    result = PROJECTS / project_id
    if not (result / "short-drama.json").is_file():
        raise ValueError("当前成员没有此项目")
    return result


def state(root: Path) -> dict:
    return load(root / ".greenroom/state.json", {"documents": {}, "previews": {}, "tasks": {}})


def persist(root: Path, value: dict) -> None:
    save(root / ".greenroom/state.json", value)


def episode_name(number) -> str:
    number = int(number)
    if number < 1:
        raise ValueError("集数必须大于零")
    return f"EP{number:03d}"


def document_path(root: Path, document: str, episode=None) -> Path:
    if document not in DOCUMENTS:
        raise ValueError("未知创作文档")
    relative = DOCUMENTS[document]
    if document in PROJECT_DOCUMENTS:
        return root / relative
    if episode is None:
        raise ValueError("此文档需要集数")
    return root / "剧集" / episode_name(episode) / relative


def document_identity(relative: str) -> tuple[str, int | None]:
    for name, path in DOCUMENTS.items():
        if relative == path and name in PROJECT_DOCUMENTS:
            return name, None
    match = re.fullmatch(r"剧集/EP(\d{3,})/([^/]+)", relative)
    if match:
        for name, path in DOCUMENTS.items():
            if path == match[2]:
                return name, int(match[1])
    raise ValueError("只能修改原套件的创作文档")


def write_document(args: dict) -> dict:
    root = project(args["projectId"])
    path = document_path(root, args["document"], args.get("episode"))
    if "expectedRevision" in args and (not path.exists() or str(path.stat().st_mtime_ns) != args["expectedRevision"]):
        raise ValueError("文档已改变，请重新打开后保存")
    content = str(args["content"])
    if path.suffix == ".jsonl":
        for line in content.splitlines():
            if line.strip():
                json.loads(line)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    data = state(root)
    relative = path.relative_to(root).as_posix()
    old = data["documents"].get(relative, {})
    data["documents"][relative] = {"revision": old.get("revision", 0) + 1,
                                    "accepted": args.get("accepted", False), "updatedAt": now()}
    for preview in data["previews"].values():
        if relative in preview["inputs"] and preview["status"] in {"preview", "confirmed"}:
            preview["status"] = "inputs_changed"
            preview.pop("confirmedAt", None)
    persist(root, data)
    return {"document": args["document"], "path": relative, "saved": True,
            **data["documents"][relative], "revision": str(path.stat().st_mtime_ns)}


def managed_json(path: str, body=None):
    request = urllib.request.Request(MANAGED + path, method="POST" if body is not None else "GET",
                                    data=None if body is None else json.dumps(body).encode(),
                                    headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
            reason = payload.get("error", payload.get("message", "服务商未返回具体失败原因"))
            if isinstance(reason, dict):
                reason = reason.get("message", "服务商未返回具体失败原因")
        except (ValueError, UnicodeError):
            reason = "服务商未返回具体失败原因"
        raise ValueError(f"HTTP {error.code}: {reason}") from None


def knowledge(args: dict) -> dict:
    skill = args["skill"]
    if skill not in SKILLS:
        raise ValueError("未知 Skill")
    directory = SOURCE / "skills" / skill
    resource = args.get("resource")
    resources = ["SKILL.md"] + [p.relative_to(directory).as_posix() for sub in ("references", "assets")
                                 for p in (directory / sub).rglob("*") if p.is_file() and p.suffix in {".md", ".json", ".jsonl", ".txt"}]
    if resource is None:
        return {"skill": skill, "resources": sorted(resources), "content": (directory / "SKILL.md").read_text(encoding="utf-8")}
    if resource not in resources:
        raise ValueError("资源不属于此 Skill 的只读知识文件")
    return {"skill": skill, "resource": resource, "content": (directory / resource).read_text(encoding="utf-8")}


def analysis_path(root, part, chapter=None):
    if part == "chapter":
        if not isinstance(chapter, int) or chapter < 1:
            raise ValueError("逐章分析需要正整数 chapter")
        relative = f"chapters/ch-{chapter}-extract.md"
    elif part in ANALYSIS_PARTS:
        relative = ANALYSIS_PARTS[part]
    else:
        raise ValueError("未知原著分析产物")
    return root / "项目开发/source-analysis" / relative


def analysis_identity(relative):
    prefix = "项目开发/source-analysis/"
    if not relative.startswith(prefix):
        raise ValueError("不是原著分析产物")
    name = relative[len(prefix):]
    for part, filename in ANALYSIS_PARTS.items():
        if name == filename:
            return part, None
    match = re.fullmatch(r"chapters/ch-(\d+)-extract\.md", name)
    if match:
        return "chapter", int(match[1])
    raise ValueError("不是可编辑的原著分析产物")


def novel_module():
    script = SOURCE / "skills/short-drama-novel-analyze/scripts/novel_index.py"
    spec = importlib.util.spec_from_file_location("managed_novel_index", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def project_view(root: Path) -> dict:
    files = [p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and ".greenroom" not in p.parts]
    return {"projectId": root.name, "project": load(root / "short-drama.json"), "files": files, **state(root)}


def production_module(name: str):
    # Only pinned official readers/compiler; never prepare_job/run/hash/export.
    path = SOURCE / "skills/short-drama-produce/scripts" / (name + ".py")
    spec = importlib.util.spec_from_file_location("managed_" + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reference_media(asset_id: str) -> tuple[bytes, str]:
    if not isinstance(asset_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", asset_id):
        raise ValueError("参考素材必须使用当前成员资产编号")
    # This bridge authenticates the member; no caller-supplied URL or file path.
    with urllib.request.urlopen(MANAGED + "/media/" + asset_id, timeout=180) as response:
        content = response.read(50 * 1024 * 1024 + 1)
        mime = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
    if not content or len(content) > 50 * 1024 * 1024:
        raise ValueError("参考素材为空或超过原生单文件 50 MiB 上限")
    return content, mime


def import_reference(args: dict) -> dict:
    root = project(args["projectId"])
    content, mime = reference_media(args["assetId"])
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
                 "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3",
                 "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac",
                 "audio/x-flac": ".flac"}.get(mime)
    if not extension:
        raise ValueError("当前官方来源选择器只支持图片与角色参考音频；此参考媒体类型不可用")
    relative = "输入/" + args["assetId"] + extension
    path = production_module("production_tool")._project_file(root, relative)
    if path.exists() and path.read_bytes() != content:
        raise ValueError("已导入参考文件已改变，不能覆盖或沿用旧确认")
    if not path.exists():
        path.write_bytes(content)
    data = state(root)
    receipt = {"assetId": args["assetId"], "projectPath": relative, "mimeType": mime}
    data.setdefault("referenceAssets", {})[relative] = receipt
    persist(root, data)
    return receipt


def bound_reference(root: Path, data: dict, binding: dict, native) -> None:
    relative, asset_id = binding["path"], binding["assetId"]
    receipts = list(data.get("referenceAssets", {}).values()) + [
        output for task in data["tasks"].values() if task.get("downloaded")
        for output in task.get("outputs", [])]
    if not any(item.get("projectPath") == relative and item.get("assetId") == asset_id for item in receipts):
        raise ValueError("参考路径必须对应本项目已导入或已下载的同一成员资产")
    content, mime = reference_media(asset_id)
    expected = "audio/" if binding["role"] == "reference_audio" else "image/"
    if not mime.startswith(expected):
        raise ValueError("参考资产媒体类型与用途不一致")
    path = native._project_file(root, relative)
    if not path.is_file() or path.read_bytes() != content:
        raise ValueError("参考路径字节与当前成员资产不一致，需要重新绑定并预览")


def production_contract(root: Path, data: dict, raw: dict, path: Path) -> dict:
    kind, prompt = raw["kind"], raw["prompt"]
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 100000:
        raise ValueError("生产提示词必须非空且不超过 100000 字符")
    native = production_module("production_tool")
    source = path.read_text(encoding="utf-8")
    entry = raw["sourceEntry"]
    if not isinstance(entry, str) or not entry:
        raise ValueError("必须选择当前创作文档的准确标题")
    supplied = raw.get("referenceBindings", [])
    if not isinstance(supplied, list) or any(not isinstance(b, dict) for b in supplied):
        raise ValueError("referenceBindings 必须是原生绑定列表")
    bindings = native._normalize_reference_bindings([
        {key: value for key, value in binding.items() if key != "assetId"} for binding in supplied])
    assets = {binding["slot_id"]: binding.get("assetId") for binding in supplied}
    bindings = [{**binding, "assetId": assets[binding["slot_id"]]} for binding in bindings]
    if "referenceAssetIds" in raw and raw["referenceAssetIds"] != [b["assetId"] for b in bindings]:
        raise ValueError("referenceAssetIds 必须逐项等于 referenceBindings 的资产顺序；不能省略引用语义")
    purposes = []
    if kind in {"image", "video"}:
        allowed = {"image": {"image-prompts": "IMG-", "storyboard": "SHOT-"},
                   "video": {"video-prompts": "MOTION-"}}[kind]
        prefix = allowed.get(raw["sourceDocument"])
        if not prefix or not entry.startswith(prefix) or not native.SOURCE_ENTRY_RE.fullmatch(entry):
            raise ValueError("image/video 必须选择 canonical IMG/SHOT/MOTION 来源，不能跨模态或使用 GROUP")
        native_bindings = [{k: v for k, v in b.items() if k != "assetId"} for b in bindings]
        native._verify_markdown_source(root, source=path.relative_to(root).as_posix(),
                                       source_entry=entry, prompt=prompt, bindings=native_bindings)
        section = native._markdown_section(source, entry)
        if kind == "video" and ("待续接" in section or "不可提交" in section):
            profile = load(root / "short-drama.json").get("creator_authority", {}).get("production_profile", {})
            route = profile.get("choices", {}).get("continuation_route")
            reason = {"independent_starts": "先补已接受的真实起始帧，由分镜/视频 owner 改写并接受独立起点正文，再重新预览",
                      "relay_external": "后续段仅移交创作者在外部工具提交，当前托管工具不能绑定续接视频"}.get(
                          route, "先请创作者选择 independent_starts 或 relay_external 并保存，不自动降级为文生视频")
            raise ValueError("当前 MOTION 待续接、不可提交：" + reason)
        field = native.CREATOR_SOURCE_ENTRIES[path.name][2]
        declarations = native._field_values(section, field)
        picture_matches = {match.group(1): match for match in native.REFERENCE_LINE_RE.finditer(declarations[0])}
        audio_matches = {match.group(1): match for value in native._field_values(section, "参考音频")
                         for match in native.AUDIO_REFERENCE_LINE_RE.finditer(value)}
        picture_purposes = {"身份", "造型状态", "地理", "构图", "尺度", "效果", "起始帧", "结束帧", "风格"}
        for binding in bindings:
            audio = binding["role"] == "reference_audio"
            match = (audio_matches if audio else picture_matches).get(binding["slot_id"])
            purpose_match = re.search(r"（用途：([^；）]+)；", match.group(0)) if match else None
            purpose = purpose_match[1] if purpose_match else None
            if purpose not in ({"音色"} if audio else picture_purposes):
                raise ValueError("参考用途必须来自官方闭集并与当前来源逐项一致")
            expected_role = "reference_audio" if audio else {"起始帧": "first_frame", "结束帧": "last_frame"}.get(purpose, "reference_image")
            if binding["role"] != expected_role:
                raise ValueError("reference binding role 与来源用途不一致；不得降级为 generic reference")
            if kind == "image" and binding["role"] != "reference_image":
                raise ValueError("当前托管图片能力只支持 reference_image，不支持首尾帧或音频 role")
            purposes.append(purpose)
        roles = [binding["role"] for binding in bindings]
        if roles.count("first_frame") > 1 or roles.count("last_frame") > 1 or ("last_frame" in roles and "first_frame" not in roles):
            raise ValueError("首尾帧用途要求至多各一张，结束帧必须同时绑定起始帧")
        compiled = production_module("provider_adapters")._prompt_with_reference_contract(
            prompt, {"reference_bindings": native_bindings, "references": [b["path"] for b in bindings]},
            prompt_language=load(root / "short-drama.json").get("format", {}).get("prompt_language", "en"))
        if purposes:
            compiled += "\nReference purposes / 参考用途：\n" + "\n".join(
                f"{i}: {purpose}" for i, purpose in enumerate(purposes, 1))
    else:
        if raw["sourceDocument"] != {"tts": "script", "music": "video-prompts"}[kind]:
            raise ValueError("TTS 必须来自剧本原句，音乐必须来自视频提示词时间线音乐章节")
        if kind == "tts":
            # The official screenplay uses `## EP001-SC001 内 · 地点 · 时间`,
            # unlike IMG/MOTION selectors whose title suffix starts with ` ·`.
            heading = re.compile(rf"^##[ \t]+`?{re.escape(entry)}`?(?:[ \t]+[^\r\n]*)?\r?$", re.MULTILINE)
            matches = list(heading.finditer(source))
            if len(matches) != 1:
                reason = "missing from" if not matches else "duplicated in"
                raise ValueError(f"source entry is {reason} Markdown: {entry}")
            match = matches[0]
            following = re.search(r"^##[ \t]+", source[match.end():], re.MULTILINE)
            end = match.end() + following.start() if following else len(source)
            section = source[match.start():end]
        else:
            section = native._markdown_section(source, entry)
        if prompt not in section:
            raise ValueError("语音/音乐 prompt 必须逐字来自所选当前章节，不得改写")
        if bindings:
            raise ValueError("当前托管 TTS/音乐未实现参考音色克隆或参考媒体能力")
        compiled = prompt
    for binding in bindings:
        bound_reference(root, data, binding, native)
    return {"referenceBindings": bindings, "referenceAssetIds": [b["assetId"] for b in bindings],
            "compiledPrompt": compiled}


def preview_production(args: dict, settings: dict) -> dict:
    root = project(args["projectId"])
    data = state(root)
    models = managed_json("/models").get("data", {})
    inputs = {}
    jobs = []
    if not args["jobs"]:
        raise ValueError("生产预览至少需要一项任务")
    if len({job["kind"] for job in args["jobs"]}) != 1:
        raise ValueError("一个生产批次只能包含一种 modality，分批展示并确认")
    for incoming in args["jobs"]:
        kind = incoming["kind"]
        raw = {**settings.get("parameters", {}).get(kind, {}), **incoming}
        if kind not in {"image", "video", "tts", "music"}:
            raise ValueError("未知生产类型")
        available = settings.get("models", {}).get(kind, []) if settings.get("configured") else [item["id"] for item in models.get(kind, [])]
        raw["model"] = raw.get("model") or (available[0] if available else None)
        if raw["model"] not in available:
            raise ValueError(f"{kind} 模型未由管理员配置或授权")
        path = document_path(root, raw["sourceDocument"], args["episode"])
        relative = path.relative_to(root).as_posix()
        entry = data["documents"].get(relative, {})
        if not path.is_file() or not entry.get("accepted"):
            raise ValueError("先接受对应创作文档，再预览生产")
        contract = production_contract(root, data, raw, path)
        inputs[relative] = entry.get("revision", 0)
        jobs.append({**raw, **contract, "jobId": uuid.uuid4().hex, "status": "preview", "episode": args["episode"]})
    preview = {"previewId": uuid.uuid4().hex, "episode": args["episode"], "status": "preview",
               "createdAt": now(), "inputs": inputs, "jobs": jobs}
    data["previews"][preview["previewId"]] = preview
    persist(root, data)
    return preview


def production(args: dict) -> dict:
    root = project(args["projectId"])
    data = state(root)
    previews = data["previews"]
    for job in data["tasks"].values():
        if job.get("platformTaskId") and job["status"] in {"pending", "running"} and job.get("queryCount", 0) >= 120:
            job["queryCount"] = 0
    persist(root, data)
    if args.get("previewId"):
        if args["previewId"] not in previews:
            raise ValueError("当前项目没有此生产预览")
        return previews[args["previewId"]]
    return {"projectId": root.name, "previews": list(previews.values()), "tasks": list(data["tasks"].values())}


def execute(args: dict) -> dict:
    root = project(args["projectId"])
    data = state(root)
    batch = data["previews"].get(args["previewId"])
    if not batch or batch["status"] not in {"confirmed", "submitted"}:
        raise ValueError("必须先展示准确预览并取得用户明确确认")
    for relative, revision in batch["inputs"].items():
        if data["documents"].get(relative, {}).get("revision") != revision:
            raise ValueError("生产输入已改变，需要重新预览并确认")
    # Recheck current source and scoped reference bytes before consuming any job.
    # A proven input change revokes confirmation; a transport outage proves no change.
    try:
        for job in batch["jobs"]:
            if job["status"] == "preview":
                current = production_contract(root, data, job, document_path(root, job["sourceDocument"], job["episode"]))
                if current["compiledPrompt"] != job.get("compiledPrompt"):
                    raise ValueError("生产引用合同已改变，需要重新预览并确认")
    except ValueError:
        batch["status"] = "inputs_changed"
        batch.pop("confirmedAt", None)
        persist(root, data)
        raise
    submissions = []
    for job in batch["jobs"]:
        if job["status"] != "preview":
            continue
        body = {"model": job["model"]}
        body["text" if job["kind"] == "tts" else "prompt"] = job["compiledPrompt"]
        kind = job["kind"]
        fields = {"image": ("size", "aspect_ratio", "n", "seed"),
                  "video": ("duration", "resolution", "aspect_ratio", "seed", "generate_audio"),
                  "tts": ("voice", "speed", "response_format"), "music": ("duration", "instrumental")}[kind]
        body.update({key: job[key] for key in fields if key in job})
        if kind in {"image", "video"} and "aspectRatio" in job:
            body["aspect_ratio"] = job["aspectRatio"]
        if kind == "image" and "quality" in job:
            body["providerParams"] = {"quality": job["quality"]}
        if job.get("referenceBindings"):
            if kind == "image":
                body["reference_images"] = ["/api/media/" + b["assetId"] for b in job["referenceBindings"]]
            elif kind == "video":
                body["input_refs"] = [{"role": b["role"], "asset_id": b["assetId"]} for b in job["referenceBindings"]]
        job["status"] = "submitting"
        job["submissionId"] = f"drama-skills:{root.name}:{batch['previewId']}:{job['jobId']}"
        job["submittedAt"] = now()
        data["tasks"][job["jobId"]] = job
        submissions.append({"jobId": job["jobId"], "submissionId": job["submissionId"], "kind": job["kind"], "body": body})
    batch["status"] = "submitted"
    persist(root, data)
    return {"previewId": batch["previewId"], "submissions": submissions}


def find_job(job_id: str):
    for root in PROJECTS.iterdir():
        if root.is_dir():
            data = state(root)
            if job_id in data["tasks"]:
                return root, data, data["tasks"][job_id]
    raise ValueError("当前成员没有此任务")


def copy_output(root: Path, job: dict, output: dict, index: int) -> dict:
    asset = str(output.get("assetId", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]+", asset):
        raise ValueError("平台未返回可读取的产物资产编号")
    mime_type = output.get("mimeType", "")
    suffix = ".wav" if mime_type == "audio/wav" else mimetypes.guess_extension(mime_type) or ".bin"
    directory = root / "剧集" / episode_name(job["episode"]) / "制作成果"
    directory.mkdir(parents=True, exist_ok=True)
    label = re.sub(r"[^\w\u3400-\u9fff.-]", "_", job["label"])
    path = directory / f"{label}-{job['jobId'][:8]}-{index}{suffix}"
    if not path.exists():
        request = urllib.request.Request(MANAGED + "/media/" + asset)
        temporary = path.with_suffix(path.suffix + ".part")
        try:
            with urllib.request.urlopen(request, timeout=180) as response, temporary.open("wb") as out:
                shutil.copyfileobj(response, out)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return {**output, "projectPath": path.relative_to(root).as_posix()}


def task_update(args: dict) -> dict:
    root, data, job = find_job(args["jobId"])
    if "submissionError" in args:
        job.update(status="submission_unknown", error=args["submissionError"])
    if "queryError" in args:
        job["lastQueryError"] = args["queryError"]
        job["queryCount"] = job.get("queryCount", 0) + 1
    if "task" in args:
        task = args["task"]
        if not task.get("taskId"):
            raise ValueError("平台未返回任务编号")
        job.update(platformTaskId=task["taskId"], status=task["status"], progress=task.get("progress"),
                   outputs=task.get("outputs", []), error=task.get("error"))
        job["queryCount"] = job.get("queryCount", 0) + 1
        job.pop("lastQueryError", None)
    if "archive" in args:
        job.update(archived=True, outputs=[args["archive"]])
        job.pop("archiveError", None)
    if "archiveError" in args:
        job["archiveError"] = args["archiveError"]
    if job.get("platformTaskId") and job["status"] == "succeeded" and not job.get("downloaded"):
        try:
            job["outputs"] = [copy_output(root, job, output, index) for index, output in enumerate(job["outputs"])]
            job["downloaded"] = True
            job.pop("archiveError", None)
        except (OSError, ValueError) as error:
            job["archiveError"] = str(error)
    for preview in data["previews"].values():
        for index, item in enumerate(preview["jobs"]):
            if item["jobId"] == job["jobId"]:
                preview["jobs"][index] = job
    persist(root, data)
    return job


def pending() -> dict:
    tasks = []
    for root in PROJECTS.iterdir():
        if not root.is_dir():
            continue
        for job in state(root)["tasks"].values():
            if (job.get("platformTaskId") and job.get("queryCount", 0) < 120
                    and (job["status"] in {"pending", "running"} or (job["status"] == "succeeded" and not job.get("downloaded")))):
                tasks.append(job)
            elif job.get("localFile") and not job.get("archived"):
                tasks.append(job)
    return {"tasks": tasks}


def local_task(root: Path, kind: str, episode=None, burn=True) -> dict:
    data = state(root)
    job = {"jobId": uuid.uuid4().hex, "kind": kind, "status": "pending", "createdAt": now(),
           "episode": episode, "burnSubtitles": burn}
    data["tasks"][job["jobId"]] = job
    persist(root, data)
    start_local(root, job["jobId"])
    return job


def start_local(root: Path, job_id: str):
    if job_id in ACTIVE:
        return
    ACTIVE.add(job_id)

    def run():
        try:
            with LOCK:
                data = state(root)
                job = data["tasks"][job_id]
                job["status"] = "running"
                persist(root, data)
            if job["kind"] == "render":
                from edit_worker import render_episode
                result = render_episode(SOURCE, root, int(job["episode"]), job["burnSubtitles"], job_id)
                output, asset_type = result, "video"
            else:
                output = root / "交付" / f"{root.name}-{job_id[:8]}.zip"
                output.parent.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                    for path in root.rglob("*"):
                        if (path.is_file() and ".greenroom" not in path.parts and "交付" not in path.relative_to(root).parts
                                and path.relative_to(root).parts[:2] != ("输入", "对标")):
                            archive.write(path, path.relative_to(root).as_posix())
                asset_type = "document"
            with LOCK:
                data = state(root)
                data["tasks"][job_id].update(status="succeeded", localFile=str(output), assetType=asset_type)
                persist(root, data)
        except Exception as error:
            with LOCK:
                data = state(root)
                data["tasks"][job_id].update(status="failed", error=str(error))
                persist(root, data)
        finally:
            ACTIVE.discard(job_id)

    threading.Thread(target=run, daemon=True).start()


def call(name: str, args: dict, settings=None):
    settings = settings or {}
    if name in {"drama_skills_register_benchmark", "drama_skills_run_breakdown", "drama_skills_get_breakdown",
                "drama_skills_set_continuation_route"}:
        from breakdown import dispatch
        return dispatch(sys.modules[__name__], name, args)
    if name == "drama_skills_list_projects":
        return [{"projectId": p.name, "project": load(p / "short-drama.json")} for p in PROJECTS.iterdir()
                if p.is_dir() and (p / "short-drama.json").is_file()]
    if name == "drama_skills_create_project":
        project_id = "drama-" + uuid.uuid4().hex[:12]
        root = PROJECTS / project_id
        template = load(SOURCE / "skills/short-drama/assets/project-template/short-drama.json")
        template.update(project_id=project_id, title=args["title"])
        template["format"].update(aspect_ratio=args.get("aspectRatio", "9:16"), episode_count=args.get("episodeCount"),
                                  prompt_language=args.get("promptLanguage", "en"))
        for directory in ("输入", "项目开发", "设定集", "剧集", "交付", "创作者决策", "审查"):
            (root / directory).mkdir(parents=True, exist_ok=True)
        save(root / "short-drama.json", template)
        persist(root, {"documents": {}, "previews": {}, "tasks": {}})
        return project_view(root)
    if name == "drama_skills_get_project":
        return project_view(project(args["projectId"]))
    if name == "drama_skills_read_document":
        root = project(args["projectId"])
        path = document_path(root, args["document"], args.get("episode"))
        return {"document": args["document"], "content": path.read_text(encoding="utf-8"),
                "path": path.relative_to(root).as_posix(), "revision": str(path.stat().st_mtime_ns)}
    if name == "drama_skills_import_reference":
        return import_reference(args)
    if name == "drama_skills_import_source":
        root = project(args["projectId"])
        asset = str(args["assetId"])
        if not re.fullmatch(r"[A-Za-z0-9_-]+", asset):
            raise ValueError("原著必须使用当前成员的资产编号")
        with urllib.request.urlopen(MANAGED + "/media/" + asset, timeout=180) as response:
            content = response.read().decode("utf-8-sig")
        return write_document({"projectId": root.name, "document": "source", "content": content, "accepted": True})
    if name == "drama_skills_index_source":
        root = project(args["projectId"])
        source = document_path(root, "source")
        index = novel_module().build_index(source, args.get("chapterUnit"))
        index["sourceRevision"] = state(root)["documents"].get("输入/原著.txt", {}).get("revision", 0)
        save(root / "项目开发/source-analysis/_index.json", index)
        return index
    if name == "drama_skills_read_source_chapters":
        root = project(args["projectId"])
        index_path = root / "项目开发/source-analysis/_index.json"
        index = load(index_path)
        if not index:
            raise ValueError("先为原著建立章节索引")
        if index["sourceRevision"] != state(root)["documents"].get("输入/原著.txt", {}).get("revision", 0):
            raise ValueError("原著已修改，需要重新建立章节索引")
        selected = set(args.get("chapters", []))
        if not selected:
            selected = {item["sequence"] for item in novel_module().sample_chapters(index_path, args.get("sampleCount", 12))["sampled"]}
        source_lines = document_path(root, "source").read_text(encoding="utf-8").splitlines()
        return {"chapters": [{**entry, "content": "\n".join(source_lines[entry["line_start"]-1:entry["line_end"]])}
                             for entry in index["chapters"] if entry["sequence"] in selected]}
    if name in {"drama_skills_read_analysis", "drama_skills_write_analysis"}:
        root = project(args["projectId"])
        path = analysis_path(root, args["part"], args.get("chapter"))
        if name == "drama_skills_read_analysis":
            return {"path": path.relative_to(root).as_posix(), "content": path.read_text(encoding="utf-8")}
        if path.suffix == ".jsonl":
            for line in args["content"].splitlines():
                if line.strip():
                    json.loads(line)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(args["content"], encoding="utf-8")
        return {"path": path.relative_to(root).as_posix(), "saved": True}
    if name == "drama_skills_write_document":
        return write_document(args)
    if name == "drama_skills_generate_document":
        root = project(args["projectId"])
        kind = args["document"]
        skill = STAGES[kind]
        folders = [root / "项目开发", root / "设定集"]
        if args.get("episode"):
            folders.append(root / "剧集" / episode_name(args["episode"]))
        context = [(p.relative_to(root).as_posix(), p.read_text(encoding="utf-8"))
                   for folder in folders for p in folder.rglob("*.md") if "source-analysis" not in p.parts]
        models = managed_json("/models").get("data", {}).get("llm", [])
        available = settings.get("models", {}).get("llm", []) if settings.get("configured") else [item["id"] for item in models]
        model = args.get("model") or (available[0] if available else None)
        if model not in available:
            raise ValueError("文本模型未由管理员配置或授权")
        parameters = {**settings.get("parameters", {}).get("llm", {}),
                      **{key: args[key] for key in ("temperature", "max_tokens", "top_p") if key in args}}
        answer = managed_json("/chat/completions", {**parameters, "model": model, "stream": False, "messages": [
            {"role": "system", "content": knowledge({"skill": skill})["content"]
             + "\n当前为 Greenroom 托管创作。仅输出所需文档正文，不运行命令、不生成媒体、不执行额外校验。"},
            {"role": "user", "content": json.dumps({"project": load(root / "short-drama.json"),
             "episode": args.get("episode"), "document": kind, "existingDocuments": context,
             "request": args["instruction"]}, ensure_ascii=False)}]})
        content = answer["choices"][0]["message"]["content"]
        return write_document({**args, "content": content, "accepted": False})
    if name == "drama_skills_read_knowledge":
        return knowledge(args)
    if name == "drama_skills_preview_production":
        return preview_production(args, settings)
    if name == "drama_skills_confirm_production":
        if args.get("confirmed") is not True:
            raise ValueError("需要用户明确确认")
        root = project(args["projectId"])
        data = state(root)
        preview = data["previews"].get(args["previewId"])
        if not preview or preview["status"] != "preview":
            raise ValueError("此预览不能确认，需要读取当前有效预览")
        preview.update(status="confirmed", confirmedAt=now())
        persist(root, data)
        return preview
    if name == "drama_skills_execute_production":
        return execute(args)
    if name == "drama_skills_get_production":
        return production(args)
    if name == "drama_skills_render_episode":
        root = project(args["projectId"])
        document_path(root, "cut-list", args["episode"]).read_text(encoding="utf-8")
        return local_task(root, "render", args["episode"], args.get("burnSubtitles", True))
    if name == "drama_skills_archive_project":
        return local_task(project(args["projectId"]), "archive")
    raise ValueError("未知 drama-skills 业务工具")


def load_dashboard():
    path = SOURCE / "skills/short-drama/scripts/dashboard_server.py"
    spec = importlib.util.spec_from_file_location("original_dashboard", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DASHBOARD = load_dashboard()
PROJECT_TOOL = DASHBOARD.load_project_tool(SOURCE)


def manifest_status(root: Path):
    manifest = load(root / "short-drama.json", {})
    rhythm, _ = PROJECT_TOOL.project_rhythm_profile(manifest)
    return {"title": manifest.get("title"), "format": manifest.get("format", {}),
            "rhythm_profile": rhythm,
            "lifecycle": {"artifact_state": "draft"}}


class ManagedStore(DASHBOARD.ProjectStore):
    @staticmethod
    def _project_id(relative):
        return relative

    def status(self, project_id):
        return manifest_status(project(project_id))

    def _creator_status(self, directory, root):
        return manifest_status(root)

    def _read_episode(self, directory, root, episode):
        parsed, paths, unreadable = super()._read_episode(directory, root, episode)
        # Managed write_document stores review next to the episode documents.
        # Keep an original upstream review authoritative when one already exists.
        if paths["review"] is None:
            relative = f"{root}/{episode}/{DOCUMENTS['review']}"
            text, problem = self._read_document(directory, relative)
            if text is not None or problem:
                paths["review"] = relative
            if problem:
                unreadable.append(problem)
                parsed["problems"].append(problem)
            if text is not None:
                parsed["review"] = DASHBOARD.views.parse_review(text)
                parsed["hasReviewText"] = True
        return parsed, paths, unreadable

    def _rendered_films(self, directory, root):
        # Read through the native pinned/no-follow store, never through a task's
        # absolute path. Failed, unarchived or inaccessible attempts stay hidden.
        text, _ = self._read_document(directory, ".greenroom/state.json")
        if text is None:
            return {}
        try:
            tasks = json.loads(text).get("tasks", {})
        except (ValueError, AttributeError):
            return {}
        if not isinstance(tasks, dict):
            return {}
        jobs = sorted((job for job in tasks.values() if isinstance(job, dict)),
                      key=lambda job: str(job.get("createdAt", "")), reverse=True)
        films = {}
        for job in jobs:
            if (job.get("kind") != "render" or job.get("status") != "succeeded"
                    or job.get("archived") is not True):
                continue
            outputs = job.get("outputs")
            if not isinstance(outputs, list) or not any(
                isinstance(output, dict) and output.get("mimeType") == "video/mp4"
                and isinstance(output.get("assetId"), str)
                and re.fullmatch(r"[A-Za-z0-9_-]+", output["assetId"])
                for output in outputs
            ):
                continue
            try:
                episode = episode_name(job["episode"])
                relative = Path(job["localFile"]).relative_to(root).as_posix()
                pure = self._safe_relative(relative)
                pure.relative_to(f"剧集/{episode}/制作成果/成片")
                if episode in films:
                    continue
                handle, content_type, size = self._open_media(directory, pure)
            except (KeyError, TypeError, ValueError, DASHBOARD.DashboardError):
                continue
            handle.close()
            if content_type == "video/mp4" and size > 0:
                films[episode] = relative
        return films

    def episode(self, project_id, episode):
        result = super().episode(project_id, episode)
        with self._pinned_project(project_id) as (directory, root):
            film = self._rendered_films(directory, root).get(episode)
        if film is not None:
            result["media"]["film"] = film
        return result

    def series(self, project_id):
        result = super().series(project_id)
        with self._pinned_project(project_id) as (directory, root):
            films = self._rendered_films(directory, root)
        for row in result["episodes"]:
            if row["id"] in films:
                row["has"]["film"] = True
        return result

    def read_text(self, project_id, relative):
        pure = self._safe_relative(relative)
        root = project(project_id)
        path = (root / pure).resolve()
        path.relative_to(root.resolve())
        if ".greenroom" in pure.parts:
            raise ValueError("内部任务状态不是创作文档")
        content = path.read_text(encoding="utf-8")
        try:
            document_identity(pure.as_posix())
            writable = True
        except ValueError:
            try:
                analysis_identity(pure.as_posix())
                writable = True
            except ValueError:
                writable = False
        return {"path": pure.as_posix(), "content": content, "version": str(path.stat().st_mtime_ns), "writable": writable}

    def write_text(self, project_id, relative, content, expected_version):
        relative = self._safe_relative(relative).as_posix()
        try:
            document, episode = document_identity(relative)
        except ValueError:
            part, chapter = analysis_identity(relative)
            path = analysis_path(project(project_id), part, chapter)
            with LOCK:
                if str(path.stat().st_mtime_ns) != expected_version:
                    raise ValueError("文档已改变，请重新打开后保存")
                call("drama_skills_write_analysis", {"projectId": project_id, "part": part, "chapter": chapter, "content": content})
            return {"path": relative, "version": str(path.stat().st_mtime_ns), "saved": True}
        with LOCK:
            result = write_document({"projectId": project_id, "document": document, "episode": episode,
                                     "content": content, "expectedRevision": expected_version})
        return {"path": relative, "version": result["revision"], "saved": True}


@contextlib.contextmanager
def unused_edit(*args, **kwargs):
    yield


TOOL = SimpleNamespace(project_status_at=lambda descriptor, project_root: manifest_status(Path(project_root)),
                       project_status_from_root=lambda root, **kwargs: manifest_status(root),
                       is_protected_project_text=lambda relative: relative == "short-drama.json" or relative.startswith(".greenroom/"),
                       coordinated_project_text_edit_at=unused_edit, coordinated_project_text_edit=unused_edit,
                       project_path_lifecycle_at=lambda *args: None, project_path_lifecycle=lambda *args: None)


class Handler(DASHBOARD.DashboardHandler):
    def _security_ok(self, **kwargs):
        # Authentication and member selection are enforced by the DSH proxy.
        return True

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        SimpleHTTPRequestHandler.end_headers(self)

    def _query(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        if path.startswith(BASE + "/"):
            path = path[len(BASE):]
        return path, urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

    def do_GET(self):
        path, _ = self._query()
        if path == "/api/greenroom/lifecycle":
            available = LOCK.acquire(blocking=False)
            if available:
                LOCK.release()
            self._json(HTTPStatus.OK, {"known": True, "busy": bool(ACTIVE) or not available})
        elif path == "/api/health":
            self._json(HTTPStatus.OK, {"ok": True, "app": "drama-skills"})
        elif path == "/greenroom/pending":
            with LOCK:
                self._json(HTTPStatus.OK, pending())
        else:
            return super().do_GET()

    def do_POST(self):
        path, _ = self._query()
        if path == "/api/session":
            return self._json(HTTPStatus.OK, {"status": "ready", "apiBase": BASE})
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            with LOCK:
                if path == "/greenroom/call":
                    result = call(payload["name"], payload.get("arguments", {}), payload.get("settings", {}))
                elif path == "/greenroom/task-update":
                    result = task_update(payload)
                else:
                    return self._json(HTTPStatus.NOT_FOUND, {"error": "业务接口不存在"})
            return self._json(HTTPStatus.OK, result)
        except (KeyError, ValueError, OSError) as error:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address):
        self.store = ManagedStore(PROJECTS, TOOL)
        self.api_prefix = BASE
        super().__init__(address, Handler)


def main():
    for root in PROJECTS.iterdir():
        if not root.is_dir():
            continue
        for job in state(root)["tasks"].values():
            if job["kind"] in {"render", "archive"} and job["status"] in {"pending", "running"}:
                start_local(root, job["jobId"])
    Server(("0.0.0.0", int(os.environ.get("PORT", "18812")))).serve_forever()


if __name__ == "__main__":
    main()
