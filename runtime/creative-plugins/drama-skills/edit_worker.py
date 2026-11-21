"""Keep the upstream cut, audio and camera implementation; render overlays with FFmpeg."""
from __future__ import annotations

import importlib.util
import math
import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


def render_episode(source: Path, project: Path, episode: int, burn: bool, job_id: str) -> Path:
    if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise ValueError("渲染任务编号无效")
    path = source / "skills/short-drama-edit/scripts/edit_tool.py"
    spec = importlib.util.spec_from_file_location("managed_drama_edit", path)
    tool = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = tool
    spec.loader.exec_module(tool)
    tool.OUTPUT_DIRECTORY = tool.OUTPUT_DIRECTORY / job_id
    tool._render_remotion_overlay = render_overlay
    folder = project / "剧集" / f"EP{episode:03d}"
    delivery, cuts, _ = tool.parse_cut_list(folder / "剪辑单.md")
    if not cuts:
        raise ValueError("剪辑单没有 CUT 条目")
    # Call the production renderer directly. Upstream check/verify/export flows
    # are independent commands and are not part of this managed execution.
    result = tool.render(folder, project, cuts, delivery, burn_subtitles=burn, renderer="ffmpeg")
    return Path(result["成片"])


def font(size: float, mono=False):
    candidates = (
        ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"] if mono else []
    ) + [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, max(1, round(size)))
    return ImageFont.load_default()


def lines(text, face, width):
    current = ""
    result = []
    for char in str(text):
        if char == "\n" or (current and face.getlength(current + char) > width):
            result.append(current)
            current = "" if char == "\n" else char
        else:
            current += char
    if current:
        result.append(current)
    return result


def text(draw, position, value, face, colour, *, stroke=0, anchor=None):
    draw.text(position, str(value), font=face, fill=colour, stroke_width=round(stroke),
              stroke_fill="#0B0D12", anchor=anchor)


def countdown(seconds):
    seconds = max(0, math.ceil(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def panel(image, item, seconds, width, height):
    u = height / 100
    elapsed = seconds - item["start"]
    length = item["end"] - item["start"]
    # Entry pop, staggered rows, exit lift and two-frame glitch match the
    # original four screen-text behaviours without a licensed renderer.
    spring = 1 - math.exp(-elapsed * 15) * math.cos(elapsed * 23)
    entry = max(0, min(1.08, spring))
    alpha = min(1, elapsed / 0.07, max(0, (length - elapsed) / 0.18))
    style = item["style"]
    glow = Image.new("RGBA", image.size)
    layer = Image.new("RGBA", image.size)
    draw = ImageDraw.Draw(layer)
    rows = item.get("items", [])
    colour = "#FF8A5B" if style in {"task", "corner"} else "#3FE0FF"
    top = {"card": 16, "system": 10, "task": 9, "corner": 5.5}[style] * u
    top += (1 - entry) * 4 * u
    if style == "corner":
        right, left = width - 4 * u, width * 0.46
        box = (left, top, right, top + 7.5 * u)
    else:
        left, right = width * 0.1, width * 0.9
        box = (left, top, right, top + (len(rows) * 5.8 + (6 if style in {"system", "task"} else 2)) * u)
    if style == "card":
        draw.rounded_rectangle(box, radius=u * 1.6, fill=(255, 255, 255, 247))
        colours = ["#FF4D4F", "#1FA2FF", "#111111", "#2BB673"]
        for index, row in enumerate(rows):
            row_alpha = min(1, max(0, (elapsed - 0.08 - index * 0.07) * 14))
            if row_alpha <= 0:
                continue
            y = top + (index * 5.8 + 1.3) * u
            parts = row["text"].split()
            name = parts[0] if parts else ""
            value = parts[-1] if len(parts) > 1 else ""
            unit = " ".join(parts[1:-1])
            draw.ellipse((left + 2.2 * u, y, left + 5.2 * u, y + 3 * u), fill=colours[index % 4])
            text(draw, (left + 6.4 * u, y), name, font(2.5 * u), "#1C2230")
            text(draw, (right - 2.2 * u, y - 0.6 * u), value, font(3.6 * u, True), "#E5322D", anchor="rt")
            if unit:
                text(draw, (right - 11 * u, y + 0.7 * u), unit, font(1.7 * u), "#9AA3B2", anchor="rt")
            if index:
                draw.line((left + 2 * u, y - u, right - 2 * u, y - u), fill="#EEF0F4", width=1)
    else:
        draw.rounded_rectangle(box, radius=u, fill=(5, 16, 30, 230), outline=colour, width=max(1, round(u * 0.13)))
        glow_draw = ImageDraw.Draw(glow)
        glow_draw.rounded_rectangle(box, radius=u, outline=colour, width=max(1, round(u * 0.3)))
        image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(u * 0.7)))
        if style == "corner":
            label = rows[0]["text"] if rows else ""
            text(draw, (left + u, top + 0.6 * u), label, font(1.6 * u), "#FFB39E")
            if item.get("countdown") is not None:
                text(draw, (right - u, top + 2.7 * u), countdown(item["countdown"] - elapsed),
                     font(3.2 * u, True), "#FFE3D6", anchor="rt")
        else:
            text(draw, (left + 2 * u, top + u), "系统提示" if style == "system" else "任务", font(2 * u), colour)
            for index, row in enumerate(rows):
                if elapsed < index * 0.07:
                    continue
                y = top + (index * 5.8 + 4.4) * u
                rarity = row.get("rarity")
                ink = {"传说": "#FFC940", "史诗": "#B26BFF", "稀有": "#3FA9FF"}.get(rarity, "#EAF7FF")
                for offset, line in enumerate(lines(row["text"], font(2.4 * u), right - left - 4 * u)):
                    text(draw, (left + 2 * u, y + offset * 2.8 * u), line, font(2.4 * u), ink)
            if item.get("countdown") is not None:
                text(draw, (right - 2 * u, top + u), countdown(item["countdown"] - elapsed),
                     font(2.5 * u, True), "#FFE3D6", anchor="rt")
    if style in {"system", "task"} and elapsed < 0.1:
        frame = round(elapsed * 30)
        if frame % 2:
            alpha *= 0.35
            layer = Image.frombytes("RGBA", layer.size, layer.tobytes())
            shifted = Image.new("RGBA", image.size)
            shifted.alpha_composite(layer, (6, 0))
            layer = shifted
    layer.putalpha(layer.getchannel("A").point(lambda value: round(value * max(0, min(1, alpha)))))
    image.alpha_composite(layer)


def subtitle(image, cue, seconds, width, height):
    u = height / 100
    age = seconds - cue.start
    size = (3.6 if cue.kind == "system" else 3.8) * u
    face = font(size)
    y = height * 0.8
    ink = {"line": "#FFFFFF", "vo": "#9FE8FF", "system": "#3FE0FF"}.get(cue.kind, "#FFFFFF")
    draw = ImageDraw.Draw(image)
    x = (width - face.getlength(cue.text)) / 2
    keys = tuple(cue.keys)
    offset = 0
    while offset < len(cue.text):
        key = next((key for key in keys if cue.text.startswith(key, offset)), None)
        run = key or cue.text[offset]
        selected = font(size * (1.08 + 0.15 * max(0, 1 - age / 0.12))) if key else face
        text(draw, (x, y), run, selected, "#FFD400" if key else ink, stroke=u * 0.42)
        x += face.getlength(run)
        offset += len(run)


def render_overlay(output_root, cues, layers, canvas, duration, *args, **kwargs):
    width, height = int(canvas.get("width") or 1080), int(canvas.get("height") or 1920)
    fps = float(canvas.get("fps") or 30)
    output = output_root / "画面文字.webm"
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
               "-pixel_format", "rgba", "-video_size", f"{width}x{height}", "-framerate", str(fps),
               "-i", "pipe:0", "-an", "-c:v", "libvpx", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
               "-deadline", "good", "-cpu-used", "4", str(output)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame in range(math.ceil(duration * fps)):
            seconds = frame / fps
            image = Image.new("RGBA", (width, height))
            for item in layers:
                if item["start"] <= seconds < item["end"]:
                    panel(image, item, seconds, width, height)
            for cue in cues:
                if cue.start <= seconds < cue.end:
                    subtitle(image, cue, seconds, width, height)
            process.stdin.write(image.tobytes())
        process.stdin.close()
        error = process.stderr.read().decode("utf-8", errors="replace")
        if process.wait() != 0:
            raise RuntimeError("FFmpeg 画面文字渲染失败：" + error[-2000:])
        return output
    finally:
        if process.poll() is None:
            process.kill()
        process.stderr.close()
