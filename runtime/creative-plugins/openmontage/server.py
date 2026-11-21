"""OpenMontage Backlot with explicit managed project and production operations."""
from __future__ import annotations

import asyncio
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import yaml
from fastapi import HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

SOURCE = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ.get("GREENROOM_PLUGIN_ROOT", "/var/lib/dsh/creative-plugins/openmontage")).resolve()
PROJECTS = ROOT / "projects"
PROJECTS.mkdir(parents=True, exist_ok=True)
os.environ["OPENMONTAGE_PROJECTS_DIR"] = str(PROJECTS)
sys.path.insert(0, str(SOURCE))
from backlot.server import app, _invalidate_summary
from backlot.state import load_board_state
from tools.analysis.audio_probe import AudioProbe
from tools.analysis.audio_energy import AudioEnergy
from tools.video.silence_cutter import SilenceCutter
import backlot.server as backlot_server
backlot_server.THUMB_CACHE_DIR = ROOT / ".backlot/thumbs"

MANAGED = os.environ.get("GREENROOM_MANAGED_URL", "http://127.0.0.1:18767/managed").rstrip("/")
BASE = os.environ.get("GREENROOM_BASE_PATH", "/plugins/openmontage/").rstrip("/")
LOCK = threading.RLock()
ACTIVE: set[str] = set()
PIPELINES = {path.stem: yaml.safe_load(path.read_text(encoding="utf-8"))
             for path in (SOURCE / "pipeline_defs").glob("*.yaml") if path.stem != "framework-smoke"}


def now():
    return datetime.now(timezone.utc).isoformat()


def load(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def project(project_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(project_id)):
        raise ValueError("项目编号无效")
    root = PROJECTS / project_id
    if not (root / "project.json").is_file():
        raise ValueError("当前成员没有此工程")
    return root


def state(root):
    return load(root / ".greenroom/state.json", {"tasks": {}})


def persist(root, data):
    save(root / ".greenroom/state.json", data)
    _invalidate_summary(root.name)


def stage(root, name):
    pipeline = PIPELINES[load(root / "project.json")["pipeline_type"]]
    match = next((item for item in pipeline["stages"] if item["name"] == name), None)
    if not match:
        raise ValueError("当前流水线没有此阶段")
    return match


def write_artifact(args):
    root = project(args["projectId"])
    definition = stage(root, args["stage"])
    if args["artifact"] not in definition.get("produces", []):
        raise ValueError("产物名不属于当前原生阶段")
    if not isinstance(args["content"], dict):
        raise ValueError("阶段产物必须是 JSON 对象")
    marker = load(root / "project.json")
    checkpoint_path = root / f"checkpoint_{args['stage']}.json"
    checkpoint = load(checkpoint_path, {"version": "1.0", "project_id": root.name,
        "pipeline_type": marker["pipeline_type"], "stage": args["stage"], "artifacts": {}})
    revisions = checkpoint.setdefault("artifact_revisions", {})
    revision = revisions.get(args["artifact"], 0) + 1
    revisions[args["artifact"]] = revision
    # Version metadata belongs to the checkpoint, not the strict upstream artifact schema.
    artifact = dict(args["content"])
    save(root / "artifacts" / (args["artifact"] + ".json"), artifact)
    checkpoint["artifacts"][args["artifact"]] = artifact
    if args["stage"] == "proposal":
        proposal = checkpoint["artifacts"].get("proposal_packet")
        if isinstance(proposal, dict):
            approval = proposal.get("approval")
            proposal["approval"] = {**(approval if isinstance(approval, dict) else {}), "status": "pending"}
            save(root / "artifacts/proposal_packet.json", proposal)
    checkpoint.update(timestamp=now(), human_approval_required=definition.get("human_approval_default", False),
                      human_approved=False, status="awaiting_human" if definition.get("human_approval_default") else "completed")
    save(checkpoint_path, checkpoint)
    pipeline = PIPELINES[marker["pipeline_type"]]
    changed = False
    for dependent in pipeline["stages"]:
        if dependent["name"] == args["stage"]:
            changed = True
            continue
        dependent_path = root / f"checkpoint_{dependent['name']}.json"
        previous = load(dependent_path)
        if changed and previous and dependent.get("human_approval_default"):
            previous.update(human_approved=False, status="awaiting_human", timestamp=now())
            save(dependent_path, previous)
    _invalidate_summary(root.name)
    return checkpoint


def knowledge(args):
    resources = []
    for folder in ("skills", ".agents/skills", "pipeline_defs", "styles", "schemas", "remotion-composer"):
        for path in (SOURCE / folder).rglob("*"):
            if path.is_file() and path.suffix in {".md", ".yaml", ".json"} and "node_modules" not in path.parts:
                resources.append(path.relative_to(SOURCE).as_posix())
    name = args.get("resource")
    if name is None:
        return {"resources": sorted(resources)}
    if name not in resources:
        raise ValueError("资源不属于已批准的 OpenMontage 创作知识")
    return {"resource": name, "content": (SOURCE / name).read_text(encoding="utf-8")}


def managed_json(path, body=None):
    request = urllib.request.Request(MANAGED + path, method="POST" if body is not None else "GET",
        data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            value = json.loads(error.read())
            reason = value.get("error", value.get("message", "服务商未返回具体失败原因"))
            if isinstance(reason, dict):
                reason = reason.get("message", "服务商未返回具体失败原因")
        except (ValueError, UnicodeError):
            reason = "服务商未返回具体失败原因"
        raise ValueError(f"HTTP {error.code}: {reason}") from None


def download_asset(root, asset, asset_id, label, mime_type):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(asset)):
        raise ValueError("素材必须使用当前成员的资产编号")
    if not re.fullmatch(r"[\w.-]+", str(asset_id)) or asset_id in {".", ".."}:
        raise ValueError("工程素材编号无效")
    suffix = ".wav" if mime_type == "audio/wav" else mimetypes.guess_extension(mime_type) or ".bin"
    directory = root / "assets"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{asset_id}-{asset}{suffix}"
    if not path.exists():
        temporary = path.with_suffix(suffix + ".part")
        try:
            with urllib.request.urlopen(MANAGED + "/media/" + asset, timeout=180) as response, temporary.open("wb") as out:
                shutil.copyfileobj(response, out)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    record = {"id": asset_id, "assetId": asset, "label": label, "path": path.relative_to(root).as_posix(),
              "type": mime_type.split("/")[0], "mimeType": mime_type, "url": "/api/media/" + asset}
    manifest_path = root / "artifacts/asset_manifest.json"
    manifest = load(manifest_path, {"version": "1.0", "assets": []})
    manifest["assets"] = [item for item in manifest.get("assets", []) if item.get("id") != asset_id] + [record]
    save(manifest_path, manifest)
    _invalidate_summary(root.name)
    return record


def audio_probe(args):
    root = project(args["projectId"]).resolve()
    if not root.is_relative_to(PROJECTS.resolve()):
        raise ValueError("工程不能越过当前成员目录")
    manifest = load(root / "artifacts/asset_manifest.json", {"assets": []})
    asset = next((item for item in manifest.get("assets", []) if item.get("assetId") == args["assetId"]), None)
    if not asset or asset.get("type") not in {"audio", "video"}:
        raise ValueError("先将当前成员的音视频资产导入本工程")
    path = (root / asset["path"]).resolve()
    if not path.is_relative_to(root / "assets") or not path.is_file():
        raise ValueError("素材必须是本工程 assets 内的已导入文件")
    result = AudioProbe().execute({"input_path": str(path)})
    if not result.success:
        raise ValueError(result.error or "原生音视频元数据读取失败")
    return {"projectId": root.name, "assetId": args["assetId"],
            "probe": {**result.data, "file": path.relative_to(root).as_posix()},
            "capabilities": {"speechToText": False, "wordTimestamps": False}}


def audio_energy(args):
    root = project(args["projectId"]).resolve()
    if not root.is_relative_to(PROJECTS.resolve()):
        raise ValueError("工程不能越过当前成员目录")
    manifest = load(root / "artifacts/asset_manifest.json", {"assets": []})
    asset = next((item for item in manifest.get("assets", []) if item.get("assetId") == args["assetId"]), None)
    if not asset or asset.get("type") != "audio":
        raise ValueError("先将当前成员的 WAV 音频资产导入本工程")
    path = (root / asset["path"]).resolve()
    if not path.is_relative_to(root / "assets") or not path.is_file():
        raise ValueError("素材必须是本工程 assets 内的已导入文件")
    if path.stat().st_size > 120 * 1024 * 1024:
        raise ValueError("音频能量分析仅支持不超过 120 MiB 的 WAV")
    inputs = {"input_path": str(path)}
    if "videoDurationSeconds" in args:
        value = args["videoDurationSeconds"]
        if type(value) not in (int, float) or not 1 <= value <= 600 or not math.isfinite(value) or int(value) != value:
            raise ValueError("videoDurationSeconds 必须为 1 至 600 的有限整数秒")
        inputs["video_duration_seconds"] = int(value)
    if "energyThresholdLufs" in args:
        value = args["energyThresholdLufs"]
        if type(value) not in (int, float) or not -120 <= value <= 0 or not math.isfinite(value):
            raise ValueError("energyThresholdLufs 必须为 -120 至 0 的有限数值")
        inputs["energy_threshold_lufs"] = value
    result = AudioEnergy().execute(inputs)
    relative_path = path.relative_to(root).as_posix()
    if not result.success:
        raise ValueError((result.error or "原生音频能量分析失败").replace(str(path), relative_path))
    return {"projectId": root.name, "assetId": args["assetId"],
            "energy": {**result.data, "file": relative_path},
            "capabilities": {"speechToText": False, "wordTimestamps": False, "automaticEditing": False}}


def mark_silence(args):
    allowed = {"projectId", "assetId", "silenceThresholdDb", "minSilenceDuration", "paddingSeconds"}
    if set(args) - allowed:
        raise ValueError("静音标记不接受路径、URL、模式或输出参数")
    root = project(args["projectId"]).resolve()
    if not root.is_relative_to(PROJECTS.resolve()):
        raise ValueError("工程不能越过当前成员目录")
    manifest = load(root / "artifacts/asset_manifest.json", {"assets": []})
    asset = next((item for item in manifest.get("assets", []) if item.get("assetId") == args["assetId"]), None)
    if not asset or asset.get("type") != "audio":
        raise ValueError("先将当前成员的 WAV 音频资产导入本工程")
    path = (root / asset["path"]).resolve()
    if not path.is_relative_to(root / "assets") or not path.is_file():
        raise ValueError("素材必须是本工程 assets 内的已导入文件")
    if path.stat().st_size > 120 * 1024 * 1024:
        raise ValueError("静音标记仅支持不超过 120 MiB 的 WAV")
    inputs = {"input_path": str(path), "mode": "mark"}
    for public, native, low, high in (
        ("silenceThresholdDb", "silence_threshold_db", -120, 0),
        ("minSilenceDuration", "min_silence_duration", 0.1, 600),
        ("paddingSeconds", "padding_seconds", 0, 1),
    ):
        if public in args:
            value = args[public]
            if type(value) not in (int, float) or not low <= value <= high or not math.isfinite(value):
                raise ValueError(f"{public} 必须为 {low} 至 {high} 的有限数值")
            inputs[native] = value
    research = root / "research"
    if not research.resolve().is_relative_to(root):
        raise ValueError("研究结果不能越过当前工程目录")
    output = research / ("silence-" + uuid.uuid4().hex + ".json")
    inputs["output_path"] = str(output)
    relative_input = path.relative_to(root).as_posix()
    try:
        result = SilenceCutter().execute(inputs)
        if not result.success:
            raise ValueError(result.error or "原生静音标记失败")
        analysis = load(output)
    except Exception as error:
        raise ValueError(str(error).replace(str(root) + "/", "")) from None
    return {"projectId": root.name, "assetId": args["assetId"],
            "analysis": {**analysis, "input": relative_input, "output": output.relative_to(root).as_posix()},
            "capabilities": {"speechToText": False, "wordTimestamps": False, "automaticEditing": False}}


def generate(args, settings):
    root = project(args["projectId"])
    pipeline = PIPELINES[load(root / "project.json")["pipeline_type"]]
    for definition in pipeline["stages"]:
        if definition["name"] in {"proposal", "idea", "script", "scene_plan"} and definition.get("human_approval_default"):
            if not load(root / f"checkpoint_{definition['name']}.json", {}).get("human_approved"):
                raise ValueError("先展示并批准当前流水线的制作方案，再生成素材")
    models = managed_json("/models").get("data", {})
    data = state(root)
    submissions = []
    for item in args["jobs"]:
        kind = item["kind"]
        raw = {**settings.get("parameters", {}).get(kind, {}), **item}
        available = settings.get("models", {}).get(kind, []) if settings.get("configured") else [model["id"] for model in models.get(kind, [])]
        model = raw.get("model") or (available[0] if available else None)
        if model not in available:
            raise ValueError(f"{kind} 模型未由管理员配置或授权")
        if not re.fullmatch(r"[\w.-]+", str(raw["assetId"])) or raw["assetId"] in {".", ".."}:
            raise ValueError("工程素材编号无效")
        job_id = uuid.uuid4().hex
        body = {"model": model, "text" if kind == "tts" else "prompt": raw["prompt"]}
        fields = {"image": ("size", "aspect_ratio", "n", "seed"),
                  "video": ("duration", "resolution", "aspect_ratio", "seed", "generate_audio"),
                  "tts": ("voice", "speed", "response_format"), "music": ("duration", "instrumental")}[kind]
        body.update({key: raw[key] for key in fields if key in raw})
        if kind in {"image", "video"} and "aspectRatio" in raw:
            body["aspect_ratio"] = raw["aspectRatio"]
        if kind == "image" and "quality" in raw:
            body["providerParams"] = {"quality": raw["quality"]}
        refs = raw.get("referenceAssetIds", [])
        frames = [("first_frame", raw.get("firstFrameAssetId")), ("last_frame", raw.get("lastFrameAssetId"))]
        videos = raw.get("referenceVideoAssetIds", [])
        audio = raw.get("referenceAudioAssetIds", [])
        if any(value is not None for _, value in frames) or videos or audio:
            if kind != "video":
                raise ValueError("首尾帧和音视频参考仅适用于视频生成")
            inputs = [(role, value) for role, value in frames if value is not None]
            inputs += [("reference_image", value) for value in refs]
            inputs += [("reference_video", value) for value in videos]
            inputs += [("reference_audio", value) for value in audio]
            if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value) for _, value in inputs):
                raise ValueError("参考素材必须使用当前成员的资产编号")
            body["input_refs"] = [{"role": role, "asset_id": value} for role, value in inputs]
        else:
            if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value) for value in refs):
                raise ValueError("参考素材必须使用当前成员的资产编号")
            if refs and kind in {"image", "video"}:
                body["reference_images" if kind == "image" else "reference_image_urls"] = ["/api/media/" + asset for asset in refs]
        job = {**raw, "model": model, "jobId": job_id, "status": "submitting", "createdAt": now(),
               "submissionId": f"openmontage:{root.name}:{job_id}"}
        data["tasks"][job_id] = job
        submissions.append({"jobId": job_id, "kind": kind, "body": body, "submissionId": job["submissionId"]})
    persist(root, data)
    return {"submissions": submissions}


def find_job(job_id):
    for root in PROJECTS.iterdir():
        if root.is_dir():
            data = state(root)
            if job_id in data["tasks"]:
                return root, data, data["tasks"][job_id]
    raise ValueError("当前成员没有此任务")


def task_update(args):
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
    if "archiveError" in args and not job.get("archived"):
        job["archiveError"] = args["archiveError"]
    if job.get("platformTaskId") and job["status"] == "succeeded" and not job.get("downloaded"):
        try:
            outputs = []
            for index, output in enumerate(job["outputs"]):
                record = download_asset(root, output["assetId"], job["assetId"] + (f"-{index}" if index else ""),
                                        job["assetId"], output.get("mimeType", "application/octet-stream"))
                outputs.append({**output, "projectPath": record["path"]})
            job.update(outputs=outputs, downloaded=True)
            job.pop("archiveError", None)
        except (OSError, ValueError, KeyError) as error:
            job["archiveError"] = str(error)
    persist(root, data)
    return job


def pending():
    tasks = []
    for root in PROJECTS.iterdir():
        if root.is_dir():
            for job in state(root)["tasks"].values():
                if job.get("platformTaskId") and job.get("queryCount", 0) < 120 and (
                    job["status"] in {"pending", "running"} or (job["status"] == "succeeded" and not job.get("downloaded"))):
                    tasks.append(job)
                elif job.get("localFile") and not job.get("archived"):
                    tasks.append(job)
    return {"tasks": tasks}


def start_local(root, job_id):
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
                from render_worker import render
                output = render(SOURCE, root, job)
                asset_type = "video"
                save(root / "artifacts/render_report.json", {"version": "1.0", "output_path": output.relative_to(root).as_posix(),
                     "renderer": "revideo-ffmpeg", "completed_at": now()})
                save(root / "checkpoint_compose.json", {"version": "1.0", "project_id": root.name,
                     "pipeline_type": load(root / "project.json")["pipeline_type"], "stage": "compose", "status": "completed",
                     "timestamp": now(), "artifacts": {"render_report": load(root / "artifacts/render_report.json")}})
            else:
                output = root / "exports" / f"{root.name}-{job_id[:8]}.zip"
                output.parent.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                    for path in root.rglob("*"):
                        if path.is_file() and not {".greenroom", "exports"}.intersection(path.relative_to(root).parts):
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


def call(name, args, settings):
    if name == "openmontage_list_pipelines":
        return list(PIPELINES.values())
    if name == "openmontage_list_projects":
        return [load(path / "project.json") for path in PROJECTS.iterdir() if (path / "project.json").is_file()]
    if name == "openmontage_create_project":
        if args["pipeline"] not in PIPELINES:
            raise ValueError("未知流水线")
        root = PROJECTS / ("montage-" + uuid.uuid4().hex[:12])
        root.mkdir()
        marker = {"project_id": root.name, "title": args["title"], "pipeline_type": args["pipeline"],
                  "created_at": now(), "style_playbook": args.get("stylePlaybook")}
        if args.get("series", "").strip():
            marker["series"] = args["series"].strip()
        save(root / "project.json", marker)
        return marker
    if name == "openmontage_set_series":
        root = project(args["projectId"])
        marker = load(root / "project.json")
        series = args["series"].strip()
        if series:
            marker["series"] = series
        else:
            marker.pop("series", None)
        save(root / "project.json", marker)
        _invalidate_summary(root.name)
        return marker
    if name == "openmontage_get_project":
        root = project(args["projectId"])
        return {"board": load_board_state(root), "tasks": list(state(root)["tasks"].values())}
    if name == "openmontage_write_artifact":
        return write_artifact(args)
    if name == "openmontage_approve_stage":
        root = project(args["projectId"])
        stage(root, args["stage"])
        path = root / f"checkpoint_{args['stage']}.json"
        value = load(path)
        if args.get("approved") is not True or not value or value["status"] != "awaiting_human":
            raise ValueError("先展示并明确认可此阶段当前产物")
        if args["stage"] == "proposal":
            proposal = value.get("artifacts", {}).get("proposal_packet")
            plan = proposal.get("production_plan") if isinstance(proposal, dict) else None
            if not isinstance(plan, dict) or plan.get("render_runtime") != "revideo":
                raise ValueError("请先展示选择 revideo 的完整制作方案，再批准")
            approval = proposal.get("approval")
            proposal["approval"] = {**(approval if isinstance(approval, dict) else {}), "status": "approved"}
            save(root / "artifacts/proposal_packet.json", proposal)
        value.update(status="completed", human_approved=True, timestamp=now())
        save(path, value)
        _invalidate_summary(root.name)
        return value
    if name == "openmontage_read_knowledge":
        return knowledge(args)
    if name == "openmontage_import_asset":
        root = project(args["projectId"])
        return download_asset(root, args["assetId"], args["assetId"], args["label"], args["mimeType"])
    if name == "openmontage_audio_probe":
        return audio_probe(args)
    if name == "openmontage_mark_silence":
        return mark_silence(args)
    if name == "openmontage_audio_energy":
        return audio_energy(args)
    if name in ("openmontage_search_wikimedia", "openmontage_search_archive_org"):
        root = project(args["projectId"]).resolve()
        if not root.is_relative_to(PROJECTS.resolve()):
            raise ValueError("工程不能越过当前成员目录")
        if not (root / "research").resolve().is_relative_to(root):
            raise ValueError("来源记录不能越过当前工程")
        from greenroom.stock_search import search_stock
        source = "wikimedia" if name == "openmontage_search_wikimedia" else "archive_org"
        result = search_stock(source, args["query"], args.get("kind", "video"), args.get("limit", 1))
        search_id = uuid.uuid4().hex
        artifact = f"research/{source}-search-{search_id}.json"
        result.update(projectId=root.name, searchId=search_id, artifact=artifact)
        save(root / artifact, result)
        return result
    if name == "openmontage_search_nasa":
        root = project(args["projectId"]).resolve()
        if not root.is_relative_to(PROJECTS.resolve()):
            raise ValueError("工程不能越过当前成员目录")
        if not (root / "research").resolve().is_relative_to(root):
            raise ValueError("来源记录不能越过当前工程")
        from greenroom.nasa_search import search_nasa
        result = search_nasa(args["query"], args.get("kind", "image"), args.get("limit", 1))
        search_id = uuid.uuid4().hex
        artifact = "research/nasa-search-" + search_id + ".json"
        result.update(projectId=root.name, searchId=search_id, artifact=artifact)
        save(root / artifact, result)
        return result
    if name == "openmontage_run_text_stage":
        root = project(args["projectId"])
        definition = stage(root, args["stage"])
        skill = "skills/" + definition["skill"] + ".md"
        existing = {path.stem: load(path) for path in (root / "artifacts").glob("*.json")}
        models = managed_json("/models").get("data", {}).get("llm", [])
        available = settings.get("models", {}).get("llm", []) if settings.get("configured") else [m["id"] for m in models]
        model = args.get("model") or (available[0] if available else None)
        if model not in available:
            raise ValueError("文本模型未由管理员配置或授权")
        parameters = {**settings.get("parameters", {}).get("llm", {}),
                      **{key: args[key] for key in ("temperature", "max_tokens", "top_p") if key in args}}
        answer = managed_json("/chat/completions", {**parameters, "model": model, "stream": False, "messages": [
            {"role": "system", "content": knowledge({"resource": skill})["content"]
             + '\nGreenroom 托管模式：不执行命令、校验或生成媒体。只输出 JSON 对象 {"artifacts":{产物名:JSON对象}}。'},
            {"role": "user", "content": json.dumps({"stage": definition, "artifacts": existing,
                                                     "request": args["instruction"]}, ensure_ascii=False)}]})
        text = answer["choices"][0]["message"]["content"].strip()
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
        artifacts = json.loads(text)["artifacts"]
        results = []
        for artifact in definition.get("produces", []):
            if artifact in artifacts:
                results.append(write_artifact({"projectId": root.name, "stage": args["stage"],
                                               "artifact": artifact, "content": artifacts[artifact]}))
        if not results:
            raise ValueError("文本模型未返回此阶段声明的业务产物")
        return {"checkpoints": results}
    if name == "openmontage_generate_assets":
        return generate(args, settings)
    if name == "openmontage_get_tasks":
        root = project(args["projectId"])
        data = state(root)
        for job in data["tasks"].values():
            if job.get("platformTaskId") and job["status"] in {"pending", "running"} and job.get("queryCount", 0) >= 120:
                job["queryCount"] = 0
        persist(root, data)
        return {"projectId": root.name, "tasks": list(data["tasks"].values())}
    if name in {"openmontage_render", "openmontage_archive_project"}:
        root = project(args["projectId"])
        if name == "openmontage_render" and not (root / "artifacts/edit_decisions.json").is_file():
            raise ValueError("先保存 edit_decisions 剪辑产物")
        if name == "openmontage_render":
            for definition in PIPELINES[load(root / "project.json")["pipeline_type"]]["stages"]:
                if definition.get("human_approval_default") and definition.get("produces"):
                    if not load(root / f"checkpoint_{definition['name']}.json", {}).get("human_approved"):
                        raise ValueError("先明确批准当前版本的流水线产物，再渲染成片")
                if "edit_decisions" in definition.get("produces", []):
                    break
        data = state(root)
        job = {**args, "jobId": uuid.uuid4().hex,
               "kind": "render" if name == "openmontage_render" else "archive", "status": "pending", "createdAt": now()}
        job["archiveKey"] = "openmontage:local:" + job["jobId"]
        data["tasks"][job["jobId"]] = job
        persist(root, data)
        start_local(root, job["jobId"])
        return job
    raise ValueError("未知 OpenMontage 业务工具")


active_requests = 0


@app.middleware("http")
async def lifecycle_requests(request, call_next):
    global active_requests
    if request.url.path == "/api/greenroom/lifecycle":
        return await call_next(request)
    active_requests += 1
    try:
        return await call_next(request)
    finally:
        active_requests -= 1


@app.get("/api/greenroom/lifecycle")
async def lifecycle_state():
    return {"known": True, "busy": bool(ACTIVE or active_requests)}


@app.post("/greenroom/call")
async def business(payload: dict):
    try:
        def execute():
            with LOCK:
                return call(payload["name"], payload.get("arguments", {}), payload.get("settings", {}))
        return await asyncio.to_thread(execute)
    except (ValueError, KeyError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@app.get("/greenroom/pending")
async def pending_tasks():
    with LOCK:
        return pending()


@app.post("/greenroom/task-update")
async def update_task(payload: dict):
    try:
        def update():
            with LOCK:
                return task_update(payload)
        return await asyncio.to_thread(update)
    except (ValueError, KeyError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


@app.get("/source")
@app.get("/greenroom/source")
async def corresponding_source():
    # Corresponding source includes the deployed modification and exact
    # upstream tree, build/installation instructions and original licence.
    output = ROOT / ("openmontage-source-" + uuid.uuid4().hex + ".zip")
    def build():
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in SOURCE.rglob("*"):
                if path.is_file() and not {".venv", "node_modules", "__pycache__", ".git"}.intersection(path.relative_to(SOURCE).parts):
                    archive.write(path, "OpenMontage/" + path.relative_to(SOURCE).as_posix())
    await asyncio.to_thread(build)
    return FileResponse(output, filename="OpenMontage-Greenroom-corresponding-source.zip", media_type="application/zip",
                        background=BackgroundTask(output.unlink, missing_ok=True))


if __name__ == "__main__":
    import uvicorn
    for root in PROJECTS.iterdir():
        if root.is_dir():
            for job in state(root)["tasks"].values():
                if job["kind"] in {"render", "archive"} and job["status"] in {"pending", "running"}:
                    start_local(root, job["jobId"])
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "18811")))
