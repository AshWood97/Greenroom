import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignProposalSchema } from './proposal-schema.mjs';

const integration = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || '.');
const base = '/plugins/openmontage';
mkdirSync(join(root, 'greenroom'), { recursive: true });
for (const file of ['server.py', 'nasa_search.py', 'stock_search.py', 'render_worker.py', 'managed.js', 'tools.json', 'adapter.mjs', 'manifest.json', 'Dockerfile', 'prepare.mjs', 'proposal-schema.mjs']) {
  cpSync(join(integration, file), join(root, 'greenroom', file));
}
cpSync(join(integration, 'renderer'), join(root, 'greenroom/renderer'), { recursive: true });
cpSync(join(integration, 'managed-skills'), join(root, 'managed-skills'), { recursive: true });
// A member media file must not turn probing into playlist/network execution.
const probePath = join(root, 'tools/analysis/audio_probe.py');
const probe = readFileSync(probePath, 'utf8');
const probeInput = '                    "-show_streams",\n                    str(input_path),';
if (!probe.includes(probeInput)) throw new Error('固定 AudioProbe 入口已改变');
writeFileSync(probePath, probe.replace(probeInput, '                    "-show_streams",\n'
  + '                    "-protocol_whitelist", "file,pipe",\n'
  + '                    "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,avi,aiff,aac",\n'
  + '                    str(input_path),'));
// Keep AudioEnergy's loudness/selection algorithm; bound its two media inputs
// and fail on subprocess errors instead of accepting partial loudness output.
const energyPath = join(root, 'tools/analysis/audio_energy.py');
let energy = readFileSync(energyPath, 'utf8');
const energyChanges = [
  ['import json\n', 'import json\nimport math\n'],
  ['                    "-show_format", str(input_path),', `                    "-show_format",
                    "-protocol_whitelist", "file", "-format_whitelist", "wav",
                    str(input_path),`],
  ['            probe_data = json.loads(probe_result.stdout)', `            if probe_result.returncode != 0:
                return ToolResult(success=False, error=f"ffprobe failed (exit {probe_result.returncode})")
            probe_data = json.loads(probe_result.stdout)`],
  ['            audio_duration = float(probe_data["format"]["duration"])', `            audio_duration = float(probe_data["format"]["duration"])
            if not math.isfinite(audio_duration) or not 0 < audio_duration <= 600:
                return ToolResult(success=False, error="Audio duration must be finite and within 600 seconds")`],
  ['                    ffmpeg, "-i", str(input_path),', `                    ffmpeg, "-nostdin", "-hide_banner", "-nostats",
                    "-protocol_whitelist", "file", "-format_whitelist", "wav",
                    "-i", str(input_path), "-vn", "-sn", "-dn", "-t", "601",`],
  ['            stderr = result.stderr', `            if result.returncode != 0:
                return ToolResult(success=False, error=f"ffmpeg ebur128 failed (exit {result.returncode})")
            stderr = result.stderr`],
  ['                raw_points.append((t, m_lufs))', `                if t > 600:
                    return ToolResult(success=False, error="Decoded audio exceeds 600 seconds")
                raw_points.append((t, m_lufs))`],
];
for (const [before, after] of energyChanges) {
  if (!energy.includes(before)) throw new Error('固定 AudioEnergy 入口已改变');
  energy = energy.replace(before, after);
}
writeFileSync(energyPath, energy);
// Keep SilenceCutter's detector and complement algorithm, exposing mark only.
// Bound both media readers and reject failures rather than inventing no silence.
const silencePath = join(root, 'tools/video/silence_cutter.py');
let silence = readFileSync(silencePath, 'utf8');
const silenceChanges = [
  [
    "import json\n",
    "import json\nimport math\n"
  ],
  [
    "        mode = inputs.get(\"mode\", \"remove\")",
    "        mode = inputs.get(\"mode\", \"remove\")\n        if mode != \"mark\":\n            return ToolResult(success=False, error=\"Managed silence cutter supports mark only\")"
  ],
  [
    "        try:\n            silences = self._detect_silence(input_path, threshold_db, min_dur)\n        except Exception as exc:\n            return ToolResult(success=False, error=f\"Silence detection failed: {exc}\")",
    "        # Probe rejects invalid declarations before the bounded decode; the actual\n        # decoded timestamp below, not the WAV header, determines result duration.\n        self._get_duration(input_path)\n        silences = self._detect_silence(input_path, threshold_db, min_dur)"
  ],
  [
    "        if not silences:\n",
    "        if not silences and mode != \"mark\":\n"
  ],
  [
    "        total_duration = self._get_duration(input_path)",
    "        total_duration = self._decoded_duration"
  ],
  [
    "            output_json.write_text(json.dumps(result_data, indent=2), encoding=\"utf-8\")",
    "            stream = output_json.open(\"x\", encoding=\"utf-8\")\n            try:\n                with stream:\n                    stream.write(json.dumps(result_data, indent=2))\n            except Exception:\n                output_json.unlink(missing_ok=True)\n                raise"
  ],
  [
    "            \"ffmpeg\",\n            \"-i\", str(input_path),",
    "            \"ffmpeg\", \"-nostdin\", \"-hide_banner\", \"-nostats\", \"-xerror\",\n            \"-protocol_whitelist\", \"file\", \"-format_whitelist\", \"wav\",\n            \"-t\", \"601\", \"-i\", str(input_path),\n            \"-map\", \"0:a:0\", \"-vn\", \"-sn\", \"-dn\", \"-t\", \"601\",\n            \"-progress\", \"pipe:1\","
  ],
  [
    "        result = self.run_command(cmd, timeout=300)\n        output = result.stderr",
    "        result = self.run_command(cmd, timeout=120)\n        if result.returncode != 0:\n            raise ValueError(f\"ffmpeg silencedetect failed (exit {result.returncode})\")\n        output = result.stderr\n        timestamps = re.findall(r\"^out_time_us=(\\d+)$\", result.stdout, re.MULTILINE)\n        if not timestamps or \"progress=end\" not in result.stdout:\n            raise ValueError(\"Missing completed decoded audio duration\")\n        self._decoded_duration = max(int(value) for value in timestamps) / 1000000\n        if not 0 < self._decoded_duration <= 600:\n            raise ValueError(\"Decoded audio must be within 600 seconds\")"
  ],
  [
    "            \"-of\", \"json\", str(input_path),",
    "            \"-of\", \"json\", \"-protocol_whitelist\", \"file\", \"-format_whitelist\", \"wav\",\n            str(input_path),"
  ],
  [
    "        try:\n            result = self.run_command(cmd)\n            data = json.loads(result.stdout)\n            return float(data[\"format\"][\"duration\"])\n        except Exception:\n            return 0.0",
    "        result = self.run_command(cmd, timeout=10)\n        if result.returncode != 0:\n            raise ValueError(f\"ffprobe failed (exit {result.returncode})\")\n        data = json.loads(result.stdout)\n        duration = float(data[\"format\"][\"duration\"])\n        if not math.isfinite(duration) or not 0 < duration <= 600:\n            raise ValueError(\"Audio duration must be finite and within 600 seconds\")\n        return duration"
  ]
];
for (const [before, after] of silenceChanges) {
  if (!silence.includes(before)) throw new Error('固定 SilenceCutter 入口已改变');
  silence = silence.replace(before, after);
}
writeFileSync(silencePath, silence);
// Keep the native NASA search/selection logic, but restrict its metadata reads
// and retain full source evidence instead of the lossy display tags alone.
const nasaPath = join(root, 'tools/video/stock_sources/nasa.py');
let nasa = readFileSync(nasaPath, 'utf8');
const nasaChanges = [
  ['        import requests  # lazy\n\n        kind =', '        from greenroom.nasa_search import nasa_json\n\n        kind ='],
  ['        r = requests.get(_SEARCH_URL, params=params, timeout=30)\n        r.raise_for_status()\n        data = r.json()', '        data = nasa_json(_SEARCH_URL, params=params)'],
  ['        for item in items:\n', '        for item in items[:filters.per_page]:\n'],
  ['        import requests  # lazy\n\n        data_list =', '        from greenroom.nasa_search import nasa_json\n\n        data_list ='],
  ['            r = requests.get(asset_href, timeout=30)\n            r.raise_for_status()\n            file_urls = r.json()\n        except Exception:\n            return None', '            file_urls = nasa_json(asset_href)\n        except Exception as error:\n            raise ValueError(f"NASA 素材清单读取失败：{error}") from None'],
  ['            extra={\n                "center":', '            extra={\n                "nasa_id": nasa_id,\n                "raw_search_item": item,\n                "center":'],
];
for (const [before, after] of nasaChanges) {
  if (!nasa.includes(before)) throw new Error('固定 NASA provider 入口已改变');
  nasa = nasa.replace(before, after);
}
writeFileSync(nasaPath, nasa);
// Preserve the fixed providers' parsing/filtering, but surface transport errors
// immediately and retain the full metadata rather than their short display tags.
const wikimediaPath = join(root, 'tools/video/stock_sources/wikimedia.py');
let wikimedia = readFileSync(wikimediaPath, 'utf8');
const wikimediaChanges = [
  ['        import requests  # lazy\n\n        for _label, search_text', '        from greenroom.stock_search import stock_json\n\n        for _label, search_text'],
  [`            r = requests.get(
                _API_URL,
                params=params,
                headers={"User-Agent": _USER_AGENT},
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()`, '            data = stock_json("wikimedia", _API_URL, params=params)'],
  ['            for page in pages:\n', '            for page in pages[:filters.per_page]:\n'],
  ['                if cand is not None:\n                    out.append(cand)', `                if cand is not None:
                    cand.extra["managed_provenance"] = {
                        "metadataEndpoint": _API_URL, "effectiveQuery": search_text,
                        "rawPageId": page.get("pageid"), "searchItem": page,
                    }
                    out.append(cand)`],
];
for (const [before, after] of wikimediaChanges) {
  if (!wikimedia.includes(before)) throw new Error('固定 Wikimedia provider 入口已改变');
  wikimedia = wikimedia.replace(before, after);
}
writeFileSync(wikimediaPath, wikimedia);
const archivePath = join(root, 'tools/video/stock_sources/archive_org.py');
let archive = readFileSync(archivePath, 'utf8');
const archiveChanges = [
  ['        import requests  # lazy\n\n        for _label, solr_q', '        from greenroom.stock_search import stock_json\n\n        for _label, solr_q'],
  [`            r = requests.get(_SEARCH_URL, params=params, timeout=30)
            r.raise_for_status()
            data = r.json()`, '            data = stock_json("archive_org", _SEARCH_URL, params=params)'],
  ['            for doc in docs:\n', '            for doc in docs[:filters.per_page]:\n'],
  ['                if cand is not None:\n                    out.append(cand)', `                if cand is not None:
                    cand.extra["managed_provenance"]["effectiveQuery"] = solr_q
                    out.append(cand)`],
  ['        import requests  # lazy\n\n        identifier = doc.get("identifier")', '        from greenroom.stock_search import stock_json, archive_metadata_url\n\n        identifier = doc.get("identifier")'],
  [`        try:
            r = requests.get(f"{_METADATA_URL}/{identifier}", timeout=30)
            r.raise_for_status()
            meta = r.json()
        except Exception:
            # Swallow per-item fetch failures — one bad item shouldn't
            # poison the whole search. Search-level failures above still
            # propagate so corpus_builder can report a broken source.
            return None`, `        metadata_endpoint = archive_metadata_url(identifier)
        meta = stock_json("archive_org", metadata_endpoint)`],
  ['            extra={\n                "collection":', `            extra={
                "managed_provenance": {"rawIdentifier": identifier, "searchItem": doc,
                    "metadataEndpoint": metadata_endpoint, "metadata": meta},
                "collection":`],
];
for (const [before, after] of archiveChanges) {
  if (!archive.includes(before)) throw new Error('固定 Archive.org provider 入口已改变');
  archive = archive.replace(before, after);
}
writeFileSync(archivePath, archive);
// Keep upstream alternatives readable, but name the one managed engine honestly.
// The native compiler rejects unsupported selections instead of silently swapping.
for (const name of ['proposal_packet', 'edit_decisions']) {
  const path = join(root, 'schemas/artifacts', `${name}.schema.json`);
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  const runtime = name === 'proposal_packet'
    ? schema.properties.production_plan.properties.render_runtime : schema.properties.render_runtime;
  if (!runtime.enum.includes('revideo')) runtime.enum.push('revideo');
  runtime.description += ' Greenroom managed execution supports only revideo (fixed native scenes plus FFmpeg audio); other selections are rejected, never silently replaced.';
  if (name === 'proposal_packet') alignProposalSchema(schema);
  writeFileSync(path, JSON.stringify(schema, null, 2) + '\n');
}
const ui = join(root, 'backlot/ui');
for (const name of ['board.html', 'index.html']) {
  let html = readFileSync(join(ui, name), 'utf8').replaceAll('="/ui/', `="${base}/ui/`).replaceAll('href="/"', `href="${base}/"`);
  html = html.replace('</body>', `<script type="module" src="${base}/ui/managed.js"></script>\n</body>`);
  writeFileSync(join(ui, name), html);
}
for (const name of ['board.js', 'library.js']) {
  let js = readFileSync(join(ui, name), 'utf8').replaceAll('from "/ui/', `from "${base}/ui/`);
  js = js.replaceAll('href: `/p/', `href: \`${base}/p/`).replaceAll('href: "/"', `href: "${base}/"`)
    .replaceAll('`/?${', `\`${base}/?\${`).replaceAll(': "/"', `: "${base}/"`);
  writeFileSync(join(ui, name), js);
}
let lib = readFileSync(join(ui, 'lib.js'), 'utf8');
lib = lib.replace('fetch(url)', 'fetch("' + base + '" + url)')
  .replace('new EventSource(url)', 'new EventSource("' + base + '" + url)')
  .replace('return `/media/', 'return `' + base + '/media/')
  .replace('return `/thumb/', 'return `' + base + '/thumb/');
writeFileSync(join(ui, 'lib.js'), lib);
cpSync(join(integration, 'managed.js'), join(ui, 'managed.js'));
// Preserve the existing thumbnail cache using source-relative names and file
// modification time. Its upstream SHA-1 path is not used in this deployment.
const serverPath = join(root, 'backlot/server.py');
let server = readFileSync(serverPath, 'utf8');
const old = `        import hashlib\n        stat = source.stat()\n        key = hashlib.sha1(\n            f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{width}".encode()\n        ).hexdigest()[:20]\n        cached = THUMB_CACHE_DIR / f"{key}.jpg"`;
if (!server.includes(old)) throw new Error('固定 Backlot 缩略图入口已改变');
server = server.replace(old, `        stat = source.stat()\n        key = f"{source.name}.{stat.st_mtime_ns}.{width}"\n        cache_directory = THUMB_CACHE_DIR / source.relative_to(PROJECTS_DIR).parent\n        cached = cache_directory / f"{key}.jpg"`)
  .replace('THUMB_CACHE_DIR.mkdir(parents=True, exist_ok=True)', 'cache_directory.mkdir(parents=True, exist_ok=True)')
  .replace('tmp = THUMB_CACHE_DIR / f"{key}.', 'tmp = cache_directory / f"{key}.');
writeFileSync(serverPath, server);
const statePath = join(root, 'backlot/state.py');
writeFileSync(statePath, readFileSync(statePath, 'utf8').replace('SCAN_EXCLUDE = {', 'SCAN_EXCLUDE = {".greenroom", '));
