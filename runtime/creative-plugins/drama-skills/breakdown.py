"""Fixed local breakdown functions. No external model, CLI, hash or auto-retry."""
from __future__ import annotations

import importlib.util
import math
import re
import threading
from pathlib import Path

OPERATIONS = {"measure", "audio", "shots", "subtitles", "subtitle-sheet", "transcript", "plan", "profile"}


def identifier(value, label, pattern=r"[A-Za-z0-9_-]{1,80}"):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(label + "无效")
    return value


def tool(source):
    path = source / "skills/short-drama-breakdown/scripts/breakdown_tool.py"
    spec = importlib.util.spec_from_file_location("managed_drama_breakdown", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def project_file(s, root, relative, create_parent=False):
    if (root / relative).is_symlink():
        raise ValueError("对标路径不能使用符号链接")
    return s.production_module("production_tool")._project_file(root, relative, create_parent=create_parent)


def register(s, args):
    root = s.project(args["projectId"])
    ref = identifier(args["referenceId"], "对标编号", r"REF-[A-Z0-9][A-Z0-9-]{0,59}")
    asset = identifier(args["assetId"], "成员资产编号")
    if not isinstance(args.get("episode"), int) or isinstance(args["episode"], bool) or args["episode"] < 1:
        raise ValueError("episode 必须为正整数")
    episode = s.episode_name(args["episode"])
    if args["permittedUse"] not in {"study", "owned", "licensed"}:
        raise ValueError("允许用途必须为 study/owned/licensed")
    if args["permittedUse"] != "study" and not str(args.get("basis", "")).strip():
        raise ValueError("自有或授权用途必须登记依据")
    if not isinstance(args["allowExternalModel"], bool) or not str(args["question"]).strip():
        raise ValueError("需明确外传许可和本轮问题")
    registration = {key: args.get(key, "") for key in (
        "permittedUse", "basis", "allowExternalModel", "question", "playbackSurface", "productionForm")}
    data = s.state(root)
    benchmarks = data.setdefault("benchmarks", {})
    benchmark = benchmarks.get(ref, {**registration, "episodes": {}})
    if any(benchmark.get(key) != value for key, value in registration.items()):
        raise ValueError("对标登记已存在且内容不同；使用新的 referenceId 保留原许可与证据")
    prior = benchmark["episodes"].get(episode)
    if prior:
        if prior["assetId"] != asset:
            raise ValueError("本对标集已绑定其他资产，不能覆盖；请使用新的 referenceId")
        return {"referenceId": ref, **benchmark}
    content, mime = s.reference_media(asset)
    extension = {"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov"}.get(mime)
    if not extension:
        raise ValueError("对标必须为当前成员的 MP4/WebM/MOV 视频 Asset")
    relative = (Path("输入/对标") / ref / "media" / (episode + extension)).as_posix()
    path = project_file(s, root, relative, create_parent=True)
    # A partial import from an unknown prior result is retained, never overwritten.
    if path.exists() and path.read_bytes() != content:
        raise ValueError("对标输入已有不同内容，不能覆盖")
    if not path.exists():
        path.write_bytes(content)
    benchmark["episodes"][episode] = {"assetId": asset, "projectPath": path.relative_to(root).as_posix(), "mimeType": mime}
    benchmarks[ref] = benchmark
    s.persist(root, data)
    return {"referenceId": ref, **benchmark}


def source_for(s, root, data, args):
    benchmark = data.get("benchmarks", {}).get(args.get("referenceId"))
    if not benchmark:
        raise ValueError("先登记当前成员的对标")
    media = benchmark["episodes"].get(s.episode_name(args.get("episode")))
    if not media:
        raise ValueError("该对标未登记此集成员视频")
    video = project_file(s, root, media["projectPath"])
    if not video.is_file():
        raise ValueError("对标输入不在本项目或已不可读")
    return media, video


def dependency(data, args, key, operations, source=None):
    job = data.get("breakdowns", {}).get(args.get(key))
    if not job or job["status"] != "succeeded" or job["request"]["operation"] not in operations:
        raise ValueError(key + " 必须为已成功的指定拆解任务")
    if source and any(job["request"].get(k) != args.get(k) for k in ("referenceId", "episode")):
        raise ValueError(key + " 必须来自同一对标、同一集")
    if source and job.get("assetId") != source["assetId"]:
        raise ValueError(key + " 必须来自同一成员资产")
    return job


def validate_request(s, root, data, args):
    operation = args.get("operation")
    if operation not in OPERATIONS:
        raise ValueError("未知拆解操作")
    allowed = {"projectId", "requestId", "operation"} | {
        "measure": {"referenceId", "episode", "sceneThreshold"},
        "audio": {"referenceId", "episode"}, "subtitle-sheet": {"referenceId", "episode"},
        "subtitles": {"referenceId", "episode", "band", "color", "audioTaskId"},
        "shots": {"referenceId", "episode", "measureTaskId"},
        "transcript": {"referenceId", "episode", "measureTaskId", "transcript", "transcriptFormat"},
        "plan": {"episode", "speakers"}, "profile": {"taskIds", "openingEpisodes"},
    }[operation]
    if set(args) - allowed:
        raise ValueError("此操作不接受其他参数、路径或命令")
    if operation == "profile":
        ids = args.get("taskIds", [])
        if not isinstance(ids, list) or not 1 <= len(ids) <= 100 or any(not isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
            raise ValueError("profile 需明确选择不重复的任务编号")
        seen = set()
        thresholds = set()
        for task_id in ids:
            job = dependency(data, {"taskId": task_id}, "taskId", {"measure", "transcript", "plan"})
            key = (job["request"].get("referenceId", "PLAN"), job["request"].get("episode"))
            if key in seen:
                raise ValueError("每个对标/计划每集只选一份测量，不能用历史任务覆盖")
            seen.add(key)
            record = job["result"]["record"]
            if record.get("kind") == "footage":
                thresholds.add(record["scene_threshold"])
        if len(thresholds) > 1:
            raise ValueError("profile 成片需相同切点阈值；不能混合测量口径")
        opening = args.get("openingEpisodes", 3)
        if not isinstance(opening, int) or isinstance(opening, bool) or opening < 1:
            raise ValueError("openingEpisodes 必须为正整数")
        return None
    if not isinstance(args.get("episode"), int) or isinstance(args["episode"], bool) or args["episode"] < 1:
        raise ValueError("episode 必须为正整数")
    if operation == "plan":
        folder = root / "剧集" / s.episode_name(args["episode"])
        files = [project_file(s, root, (folder / name).relative_to(root).as_posix()) for name in ("剧本.md", "分镜.md")]
        if not any(path.is_file() for path in files):
            raise ValueError("此集没有可测量的剧本或分镜")
        if not isinstance(args.get("speakers", []), list) or any(not isinstance(x, str) for x in args.get("speakers", [])):
            raise ValueError("speakers 必须为名称列表")
        return None
    media, video = source_for(s, root, data, args)
    if operation in {"shots", "transcript"}:
        dependency(data, args, "measureTaskId", {"measure", "transcript"}, media)
    if operation == "subtitles":
        band = args.get("band")
        if (not isinstance(band, list) or len(band) != 4 or
            any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in band)
            or not (0 <= band[0] < band[2] <= 1 and 0 <= band[1] < band[3] <= 1)):
            raise ValueError("band 须是已校准的左上右下四个 0–1 比例")
        if args.get("color") and not re.fullmatch(r"[0-9A-Fa-f]{6}", args["color"]):
            raise ValueError("color 须为六位十六进制字色")
        if args.get("audioTaskId"):
            dependency(data, args, "audioTaskId", {"audio"}, media)
    if operation == "measure":
        value = args.get("sceneThreshold", .28)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value <= 1:
            raise ValueError("sceneThreshold 必须在 0 到 1 之间")
    if operation == "transcript":
        if args.get("transcriptFormat") not in {"srt", "vtt", "json"} or not isinstance(args.get("transcript"), str):
            raise ValueError("转写格式须为 srt/vtt/json，内容须为文本")
        tool(s.SOURCE).parse_transcript(args["transcript"], "." + args["transcriptFormat"])
    return media


def run_operation(s, root, job):
    args = job["request"]
    operation = args["operation"]
    data = s.state(root)
    native = tool(s.SOURCE)
    out = project_file(s, root, job["outputDirectory"], create_parent=True)
    out.mkdir(exist_ok=False)
    if operation == "profile":
        groups = {}
        for task_id in args["taskIds"]:
            previous = data["breakdowns"][task_id]
            label = previous["request"].get("referenceId", "PLAN")
            groups.setdefault(label, []).append(previous["result"]["record"])
        profiles = {label: native.profile(records, args.get("openingEpisodes", 3)) for label, records in groups.items()}
        s.save(out / "profile.json", profiles)
        (out / "profile.md").write_text(native.render_table(profiles), encoding="utf-8")
        result = {"profiles": profiles, "table": native.render_table(profiles),
                  "note": "计划为估算，成片为测量；只对照口径，不自动接受或改节奏档案"}
    elif operation == "plan":
        with s.LOCK:
            for name in ("剧本.md", "分镜.md"):
                project_file(s, root, f"剧集/{s.episode_name(args['episode'])}/{name}")
            record = native.plan_episode(root / "剧集" / s.episode_name(args["episode"]), args.get("speakers", []))
        target = out / (s.episode_name(args["episode"]) + native.MEASURE_SUFFIX)
        s.save(target, record)
        result = {"record": record, "resultPath": target.relative_to(root).as_posix()}
    else:
        media, video = source_for(s, root, data, args)
        if operation == "measure":
            target = native.measure_video(video, out, args.get("sceneThreshold", .28), True)
        elif operation == "audio":
            target = native.measure_audio(video, out, native.DEFAULT_SILENCE_DB, native.DEFAULT_SILENCE_SECONDS)
        elif operation == "subtitle-sheet":
            target = native.subtitle_sheet([video], out)
        elif operation == "subtitles":
            audio = dependency(data, args, "audioTaskId", {"audio"}, media) if args.get("audioTaskId") else None
            audio_dir = project_file(s, root, audio["result"]["resultPath"]).parent if audio else None
            color = native.parse_color(args["color"]) if args.get("color") else None
            target = native.scan_subtitles(video, out, tuple(args["band"]), color=color, audio=audio_dir)
        else:
            measured = dependency(data, args, "measureTaskId", {"measure", "transcript"}, media)
            measure_path = project_file(s, root, measured["result"]["resultPath"])
            if operation == "shots":
                target = native.cut_shots(video, measure_path, out)
            else:
                target = out / measure_path.name
                target.write_bytes(measure_path.read_bytes())
                transcript = out / (s.episode_name(args["episode"]) + "." + args["transcriptFormat"])
                transcript.write_text(args["transcript"], encoding="utf-8")
                native.attach_transcript(target, transcript)
        result = {"record": s.load(target), "resultPath": target.relative_to(root).as_posix()}
    result["files"] = sorted(p.relative_to(root).as_posix() for p in out.rglob("*") if p.is_file())
    return result


def start(s, root, job_id):
    active_id = "breakdown:" + root.name + ":" + job_id
    s.ACTIVE.add(active_id)
    def work():
        try:
            with s.LOCK:
                data = s.state(root)
                job = data["breakdowns"][job_id]
                job["status"] = "running"
                s.persist(root, data)
            result = run_operation(s, root, job)
            with s.LOCK:
                data = s.state(root)
                data["breakdowns"][job_id].update(status="succeeded", result=result)
                s.persist(root, data)
        except Exception as error:
            with s.LOCK:
                data = s.state(root)
                data["breakdowns"][job_id].update(status="failed", error=str(error))
                s.persist(root, data)
        finally:
            s.ACTIVE.discard(active_id)
    threading.Thread(target=work, daemon=True).start()


def get(s, root, job_id):
    data = s.state(root)
    job = data.get("breakdowns", {}).get(job_id)
    if not job:
        raise ValueError("当前成员项目没有此拆解任务")
    if job["status"] in {"pending", "running"} and "breakdown:" + root.name + ":" + job_id not in s.ACTIVE:
        job.update(status="interrupted", error="本地执行已中断；旧输出保留，本编号只读回，不自动重跑")
        s.persist(root, data)
    return job


def dispatch(s, name, args):
    with s.LOCK:
        root = s.project(args["projectId"])
        if name == "drama_skills_register_benchmark":
            return register(s, args)
        if name == "drama_skills_get_breakdown":
            return get(s, root, args["requestId"])
        if name == "drama_skills_set_continuation_route":
            route = args["route"]
            if args.get("confirmed") is not True or route not in {"independent_starts", "relay_external"}:
                raise ValueError("仅在创作者明确确认后保存两种续接选择")
            manifest = s.load(root / "short-drama.json")
            profile = manifest.setdefault("creator_authority", {}).setdefault("production_profile", {})
            choices = profile.setdefault("choices", {})
            if choices.get("continuation_route") != route:
                choices["continuation_route"] = route
                s.save(root / "short-drama.json", manifest)
                data = s.state(root)
                for preview in data["previews"].values():
                    if preview["status"] in {"preview", "confirmed"} and any(j["kind"] == "video" for j in preview["jobs"]):
                        preview["status"] = "inputs_changed"
                        preview.pop("confirmedAt", None)
                s.persist(root, data)
            return {"route": route, "saved": True, "note": "不改变其他 production_profile 状态/选择，也不是媒体生产确认"}
        request_id = identifier(args["requestId"], "请求编号")
        data = s.state(root)
        prior = data.get("breakdowns", {}).get(request_id)
        if prior:
            if prior["request"] != args:
                raise ValueError("requestId 已用于不同请求，不覆盖或重跑")
            return get(s, root, request_id)
        media = validate_request(s, root, data, args)
        directory = (Path("输入/对标") / args["referenceId"] / "measurements" if media else
                     Path("项目开发/对标拆解") / args["operation"]) / request_id
        job = {"requestId": request_id, "request": dict(args), "status": "pending", "createdAt": s.now(),
               "assetId": media["assetId"] if media else None, "outputDirectory": directory.as_posix()}
        data.setdefault("breakdowns", {})[request_id] = job
        s.persist(root, data)
        start(s, root, request_id)
        return job
