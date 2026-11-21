"""Resolve member assets and render fixed native Revideo scenes, then mix with FFmpeg."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote
from PIL import Image

SCENES = {"text_card", "hero_title", "title", "stat_card", "callout", "comparison", "bar_chart", "chart",
          "line_chart", "pie_chart", "kpi_grid", "progress_bar", "progress", "anime_scene", "terminal_scene", "screenshot_scene"}


def number(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise ValueError(f"{label} 必须为不小于 {minimum} 的有限数值")
    return value


def compile_subtitles(spec, local, duration):
    """Compile supplied timings only. Never guess word timings from an SRT cue."""
    if not spec.get("enabled"):
        return None
    if spec.get("caption_props"):
        raise ValueError("托管 Revideo 不支持 Remotion 的 caption_props；请使用受支持的字幕样式字段")
    if not spec.get("source"):
        raise ValueError("启用字幕必须提供当前工程的 subtitles.source；不能虚构语音对齐")
    style = spec.get("style", "sentence")
    if style not in {"sentence", "word-by-word", "karaoke"}:
        raise ValueError("托管字幕仅支持 sentence、word-by-word、karaoke")
    path = local(spec["source"])
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
        entries = data if isinstance(data, list) else data.get("segments" if style == "sentence" else "words", []) if isinstance(data, dict) else []
    elif style == "sentence":
        entries = []
        for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
            lines = block.splitlines()
            if lines and lines[0].strip().isdigit():
                lines.pop(0)
            match = re.fullmatch(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3})", lines[0] if lines else "")
            if not match or len(lines) < 2:
                raise ValueError("字幕必须是带明确起止时间和正文的 SRT 或时间轴 JSON")
            values = list(map(int, match.groups()))
            if any(values[index] >= 60 for index in (1, 2, 5, 6)):
                raise ValueError("SRT 分钟或秒超出范围")
            stamp = lambda offset: values[offset] * 3600 + values[offset + 1] * 60 + values[offset + 2] + values[offset + 3] / 1000
            entries.append({"start": stamp(0), "end": stamp(4), "text": "\n".join(lines[1:])})
    else:
        raise ValueError("逐词字幕必须提供含真实 words 时间轴的 JSON；不能从 SRT 均分词时码")
    if not isinstance(entries, list) or not entries:
        raise ValueError("字幕时间轴不能为空")
    normalized, previous_end = [], 0
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("字幕时间轴条目必须为对象")
        start = number(entry["start"], "字幕起点") if "start" in entry else number(entry.get("startMs"), "字幕起点毫秒") / 1000
        end = number(entry["end"], "字幕终点") if "end" in entry else number(entry.get("endMs"), "字幕终点毫秒") / 1000
        content = entry.get("text", entry.get("word"))
        if not isinstance(content, str) or not content.strip() or start < previous_end or end <= start or end > duration:
            raise ValueError("字幕正文或时间轴无效：不能重叠、倒置或越过成片")
        normalized.append({"start": start, "end": end, "text": content})
        previous_end = end
    size = number(spec.get("font_size", 48), "字幕字号", 1)
    count = spec.get("max_words_per_line", 8)
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise ValueError("字幕每行词数必须为正整数")
    position = spec.get("position", "bottom-center")
    if position not in {"top-center", "center", "bottom-center"}:
        raise ValueError("字幕位置无效")

    def color(value):
        if re.fullmatch(r"#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}", value):
            return value
        match = re.fullmatch(r"&H([0-9a-fA-F]{8}|[0-9a-fA-F]{6})&?", value)
        if match:
            raw = match[1].zfill(8)
            return f"#{raw[6:8]}{raw[4:6]}{raw[2:4]}{255-int(raw[:2], 16):02x}"
        raise ValueError("字幕颜色必须是十六进制 CSS 或 ASS 颜色；不能静默替换")

    return {"mode": style, "segments" if style == "sentence" else "words": normalized,
            "fontSize": size, "font": spec.get("font", "Noto Sans CJK SC"), "wordsPerPage": count,
            "color": color(spec.get("color", "#FFFFFF")), "outlineColor": color(spec.get("outline_color", "#0B0D12")),
            "background": color(spec.get("background", "#00000088")), "position": position}


def compile_edit(root: Path, job: dict):
    """Resolve the native EDL into fixed Revideo and FFmpeg inputs; no browser."""
    root = root.resolve()
    plan = json.loads((root / "artifacts/edit_decisions.json").read_text(encoding="utf-8"))
    if plan.get("render_runtime") != "revideo":
        raise ValueError("托管渲染只支持 render_runtime=revideo；不能静默替代 remotion/hyperframes/ffmpeg")
    proposal_path = root / "artifacts/proposal_packet.json"
    if proposal_path.is_file():
        selected = json.loads(proposal_path.read_text(encoding="utf-8")).get("production_plan", {}).get("render_runtime")
        if selected != "revideo":
            raise ValueError("proposal_packet 与 edit_decisions 的 render_runtime 必须一致为 revideo；请重新展示并批准")
    manifest_path = root / "artifacts/asset_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"assets": []}
    assets = {asset["id"]: asset["path"] for asset in manifest.get("assets", [])}
    media_root = f"http://127.0.0.1:{os.environ.get('PORT', '18811')}/media/{root.name}/"
    sizes = {}

    def local(value):
        value = assets.get(value, value)
        path = (root / value).resolve()
        path.relative_to(root.resolve())
        if not path.is_file():
            raise ValueError(f"工程素材不存在：{value}")
        return path

    def media(value):
        path = local(value)
        url = media_root + quote(path.relative_to(root).as_posix(), safe="/")
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            with Image.open(path) as image:
                sizes[url] = {"width": image.width, "height": image.height}
        else:
            info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height", "-of", "json", str(path)]))
            if info["streams"]:
                sizes[url] = info["streams"][0]
        return url

    if plan.get("composition_mode") == "atelier" or plan.get("renderer_family") == "bespoke":
        raise ValueError("托管版本使用原生 Revideo 场景，不能执行任意 Remotion/HTML 工程代码")
    cuts = plan.get("cuts", [])
    if not cuts and plan.get("scenes"):
        cuts = [{"type": "hero_title" if scene.get("kind") == "title" else None,
                 "source": scene.get("src"), "text": scene.get("text"),
                 "backgroundVideo": scene.get("backgroundSrc"), "source_in_seconds": scene.get("trimBeforeSeconds", 0),
                 "in_seconds": scene["startSeconds"], "out_seconds": scene["startSeconds"] + scene["durationSeconds"],
                 "speed": scene.get("playbackRate", 1)} for scene in plan["scenes"]]
    if not cuts:
        raise ValueError("edit_decisions 中没有可渲染镜头")
    for cut in cuts:
        kind = cut.get("type")
        if kind and kind not in SCENES:
            raise ValueError(f"原生 Revideo 尚未实现此场景：{kind}")
        if float(cut["out_seconds"]) <= float(cut["in_seconds"]):
            raise ValueError("镜头出点必须晚于入点")
        if not kind and cut.get("source"):
            cut["source"] = media(cut["source"])
        for key in ("backgroundImage", "backgroundVideo"):
            if cut.get(key):
                cut[key] = media(cut[key])
        if cut.get("images"):
            cut["images"] = [media(value) for value in cut["images"]]
    target = plan.get("metadata", {}).get("compose_target", {})
    width = int(job.get("width", target.get("width", 1920)))
    height = int(job.get("height", target.get("height", 1080)))
    fps = int(job.get("fps", 30))
    duration = max(float(cut["out_seconds"]) for cut in cuts)
    number(duration, "成片时长", .001)
    subtitles = compile_subtitles(plan.get("subtitles", {}), local, duration)
    request = {**plan, "cuts": cuts, "width": width, "height": height, "fps": fps,
               "duration": duration, "mediaSizes": sizes}
    if subtitles is not None:
        request["captions"] = subtitles
    audio = plan.get("audio", {})
    layers = []

    def layer(value, role, start=0, end=None):
        asset = value.get("asset_id", value.get("src"))
        if not asset:
            raise ValueError(f"{role} 缺少真实 asset_id/src")
        start = number(start, "音轨起点")
        end = number(duration if end is None else end, "音轨终点")
        if end <= start or end > duration:
            raise ValueError("音轨起止时间必须在成片内")
        fade_in = number(value.get("fade_in_seconds", value.get("fadeInSeconds", 0)), "音轨淡入")
        fade_out = number(value.get("fade_out_seconds", value.get("fadeOutSeconds", 0)), "音轨淡出")
        if max(fade_in, fade_out) > end - start:
            raise ValueError("音轨淡入淡出不能超过选定声段")
        layers.append({"src": str(local(asset)), "role": role, "start": start, "end": end,
                       "offset": number(value.get("offsetSeconds", value.get("trimBeforeSeconds", 0)), "音轨裁切"),
                       "volume": number(value.get("volume", 1), "音轨音量"), "loop": value.get("loop", False),
                       "fade_in": fade_in, "fade_out": fade_out})

    narration = audio.get("narration", {})
    if "segments" in narration:
        if narration.get("src") or narration.get("asset_id"):
            raise ValueError("旁白不能同时声明 segments 与整轨 src/asset_id")
        for segment in narration["segments"]:
            layer(segment, "narration", segment["start_seconds"], segment.get("end_seconds"))
    elif narration:
        layer(narration, "narration")
    for music in [audio.get("music"), plan.get("music"), plan.get("soundtrack")]:
        if not music:
            continue
        ducking = music.get("ducking", False)
        layer(music, "music")
        if ducking is True or isinstance(ducking, dict) and ducking.get("enabled", True):
            if not any(item["role"] == "narration" for item in layers):
                raise ValueError("自动 ducking 必须有真实旁白音轨作为侧链")
            settings = ducking if isinstance(ducking, dict) else {}
            threshold = number(settings.get("threshold_db", -30), "ducking 阈值 dBFS", -120)
            reduction = number(settings.get("reduction_db", -12), "ducking 降幅 dB", -120)
            if threshold > 0 or reduction > 0:
                raise ValueError("ducking threshold_db/reduction_db 必须是 -120 到 0 的有限 dB 值")
            layers[-1]["ducking"] = {"threshold": 10 ** (threshold / 20), "gain": 10 ** (reduction / 20),
                                    "attack": number(settings.get("attack_ms", 20), "ducking attack_ms") / 1000,
                                    "release": number(settings.get("release_ms", 250), "ducking release_ms") / 1000}
    for sfx in audio.get("sfx", []):
        layer(sfx, "sfx", sfx["start_seconds"])
    return request, layers


def mix_command(raw: Path, final: Path, request: dict, layers: list):
    """The existing post-Revideo mix route, now preserving segment positions."""
    duration, fps = request["duration"], request["fps"]
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw)]
    if not layers:
        return command + ["-vf", f"fps={fps}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(final)]
    filters, inputs = [], []
    for index, layer in enumerate(layers, 1):
        if layer["loop"]:
            command.extend(["-stream_loop", "-1"])
        command.extend(["-i", layer["src"]])
        length = layer["end"] - layer["start"]
        chain = ["aformat=sample_rates=48000:channel_layouts=stereo", f"atrim=start={layer['offset']}:duration={length}",
                 "asetpts=PTS-STARTPTS", f"volume={layer['volume']}"]
        if layer["fade_in"]:
            chain.append(f"afade=t=in:d={layer['fade_in']}")
        if layer["fade_out"]:
            chain.append(f"afade=t=out:st={length-layer['fade_out']}:d={layer['fade_out']}")
        chain.extend([f"adelay={round(layer['start'] * 48000)}S:all=1", "apad", f"atrim=duration={duration}"])
        filters.append(f"[{index}:a]" + ",".join(chain) + f"[a{index}]")
        inputs.append(f"[a{index}]")
    ducked = [(index, item["ducking"]) for index, item in enumerate(layers, 1) if item.get("ducking")]
    if ducked:
        voices = [index for index, item in enumerate(layers, 1) if item["role"] == "narration"]
        filters.append("".join(f"[a{index}]" for index in voices) + f"amix=inputs={len(voices)}:normalize=0:duration=longest,"
                       f"asplit={len(ducked) + 1}[voice]" + "".join(f"[side{index}]" for index, _ in ducked))
        inputs = [f"[a{index}]" for index in range(1, len(layers) + 1) if index not in voices] + ["[voice]"]
        for index, settings in ducked:
            # A fixed native numeric expression, never member-supplied filter code.
            # Peak envelope releases over 10 ms to avoid carrier zero-crossings.
            # Linear gain ramps reach the requested signed dB reduction/recovery.
            gain = settings["gain"]
            attack_step = (1 - gain) / max(1, settings["attack"] * 48000)
            release_step = (1 - gain) / max(1, settings["release"] * 48000)
            envelope = (f"st(0,max(max(abs(val(0)),abs(val(1))),ld(0)*{math.exp(-1/480)}));"
                        f"st(1,if(gte(ld(0),{settings['threshold']}),{gain},1));"
                        "st(2,if(eq(n,0),1,ld(2)));"
                        f"st(2,if(lt(ld(1),ld(2)),max(ld(1),ld(2)-{attack_step}),min(ld(1),ld(2)+{release_step})))")
            filters.append(f"[side{index}]aeval=exprs='{envelope}':c=mono,pan=stereo|c0=c0|c1=c0[gain{index}]")
            filters.append(f"[a{index}][gain{index}]amultiply[duck{index}]")
            inputs[inputs.index(f"[a{index}]")] = f"[duck{index}]"
    filters.append("".join(inputs) + f"amix=inputs={len(inputs)}:normalize=0:duration=longest[mix]")
    command.extend(["-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[mix]"])
    command.extend(["-c:v", "copy"] if fps == 30 else ["-vf", f"fps={fps}", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
    return command + ["-c:a", "aac", "-b:a", "192k", "-t", str(duration), "-movflags", "+faststart", str(final)]


def render(source: Path, root: Path, job: dict) -> Path:
    request, layers = compile_edit(root, job)
    directory = root / ".greenroom" / "renders" / job["jobId"]
    directory.mkdir(parents=True, exist_ok=True)
    raw = directory / "picture.mp4"
    request["output"] = str(raw)
    request_file = directory / "render.json"
    request_file.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    renderer = source / "greenroom/renderer"
    subprocess.run(["node", "render.mjs", str(request_file)], cwd=renderer, check=True)
    final = root / "renders" / f"{job['jobId']}.mp4"
    final.parent.mkdir(parents=True, exist_ok=True)
    if not layers and request["fps"] == 30:
        shutil.copyfile(raw, final)
        return final
    subprocess.run(mix_command(raw, final, request, layers), check=True)
    return final
