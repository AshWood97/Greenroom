import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const patch = (file, before, after) => {
  const filename = join(root, file);
  const source = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
  if (!source.includes(before)) throw new Error(`MoneyPrinterTurbo 适配位置已变化：${file}`);
  writeFileSync(filename, source.replace(before, after));
};
for (const [source, target] of [['raw_materials.py', 'greenroom_raw_materials.py'], ['final_cache.py', 'greenroom_final_cache.py'], ['delivery.py', 'greenroom_delivery.py'], ['state.py', 'greenroom_state.py'], ['managed.py', 'greenroom_managed.py'], ['start.py', 'greenroom.py'], ['api.py', 'greenroom_api.py']])
  copyFileSync(new URL(source, import.meta.url), join(root, target));
copyFileSync(new URL('../managed-bridge.py', import.meta.url), join(root, 'greenroom_bridge.py'));
patch('app/config/config.py', 'hostname = socket.gethostname()', 'from greenroom_managed import configure as _configure_greenroom\n_configure_greenroom(__import__(__name__, fromlist=["app"]))\n\nhostname = socket.gethostname()');
patch('app/services/state.py', '# Global state', '# Global state');
const stateFile = join(root, 'app/services/state.py');
writeFileSync(stateFile, readFileSync(stateFile, 'utf8') + '\nfrom greenroom_state import SqliteState\nstate = SqliteState()\n');
patch('app/services/llm.py', 'def _generate_response(\n', 'def _unmanaged_generate_response(\n');
const llmFile = join(root, 'app/services/llm.py');
writeFileSync(llmFile, readFileSync(llmFile, 'utf8') + '\nfrom greenroom_managed import text as _generate_response\n');
// Managed speech supplies only a whole-utterance duration, not sentence/word boundaries.
patch('app/services/voice.py', '    text = _format_text(text)\n    try:\n        if word_level:', `    text = _format_text(text)
    try:
        if getattr(sub_maker, "greenroom_timing_granularity", None) == "utterance":
            logger.info("托管语音字幕使用整段实际时长，不提供逐句或逐词对齐")
            _write_subtitle_items(_build_subtitle_items_from_edge_cues_words(sub_maker), subtitle_file)
            return
        if word_level:`);
const voiceFile = join(root, 'app/services/voice.py');
writeFileSync(voiceFile, readFileSync(voiceFile, 'utf8') + '\nfrom greenroom_managed import speech as tts\n');
patch('app/controllers/v1/video.py', '            task_manager.add_task(\n                tm.start, task_id=task_id, params=body, stop_at=stop_at\n            )', '            from greenroom_managed import enqueue\n            enqueue(task_id, body, stop_at=stop_at)');
patch('app/services/webui_task.py', 'def submit_generation(\n', 'def _unmanaged_submit_generation(\n');
const uiTask = join(root, 'app/services/webui_task.py');
writeFileSync(uiTask, readFileSync(uiTask, 'utf8') + '\nfrom greenroom_managed import submit_from_ui as submit_generation, is_generation_active\n');
patch('app/services/task.py', '    return video_script\n\n\ndef generate_terms', '    from greenroom_managed import checkpoint\n    checkpoint(task_id, video_script=video_script)\n    return video_script\n\n\ndef generate_terms');
patch('app/services/task.py', '    return video_terms\n\n\ndef save_script_data', '    from greenroom_managed import checkpoint\n    checkpoint(task_id, video_terms=video_terms)\n    return video_terms\n\n\ndef save_script_data');
patch('app/services/task.py', 'from app.config import config', 'from app.config import config\nfrom greenroom_managed import QueryPending');
patch('app/services/task.py', '        except Exception as exc:\n            logger.exception(\n                f"unexpected task pipeline failure', '        except QueryPending as exc:\n            sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=40, error=str(exc), failed_stage="query")\n            return None\n        except Exception as exc:\n            logger.exception(\n                f"unexpected task pipeline failure');
patch('app/services/material.py', '    provider = "pexels"\n    remote_search_videos = search_videos_pexels', `    if source in ("openai_image", "wavespeed"):
        from greenroom_managed import generate_materials
        return generate_materials(task_id=task_id, search_terms=search_terms, source=source, video_aspect=video_aspect,
                                  audio_duration=audio_duration, max_clip_duration=max_clip_duration, image_motion=image_motion)
    provider = "pexels"
    remote_search_videos = search_videos_pexels`);
// Keep the original creative controls and task browser. Credentials and service addresses are administrator-only.
patch('webui/Main.py', 'def _render_settings_dialog():\n', 'def _render_settings_dialog():\n    st.info("模型与服务配置由 Greenroom 管理员统一维护")\n    return\n\ndef _unmanaged_render_settings_dialog():\n');
patch('webui/Main.py', `            st.button(
                tr("Settings"),
                key="open_settings_dialog_button",
                type="secondary",
                icon=":material/settings:",
                width="content",
                on_click=_open_settings_dialog,
            )`, '');
patch('webui/Main.py', `        Tour.bind(
            "open_settings_dialog_button",
            title=tr("Onboarding Model Settings Title"),
            desc=tr("Onboarding Model Settings Description"),
            side="bottom",
            align="end",
        ),`, '');
patch('webui/Main.py', `                    st.button(
                        tr("Configure LLM"),
                        key="open_llm_settings_from_subject",
                        type="tertiary",
                        on_click=_open_settings_dialog,
                        args=("llm",),
                    )`, '');
patch('webui/Main.py', `                settings_label=tr("Configure Material Sources"),
                on_settings=_open_material_settings_dialog,
`, '');
patch('webui/Main.py', 'VIDEO_SOURCE_GROUPS = {', 'UNMANAGED_VIDEO_SOURCE_GROUPS = {');
patch('webui/Main.py', '# Upload-Post 的 API Key', `VIDEO_SOURCE_GROUPS = {"stock_video": (), "ai_video": ("wavespeed",), "ai_image": ("openai_image",), "local": ("local",)}
# Upload-Post 的 API Key`);
patch('webui/Main.py', '"wavespeed": tr("WaveSpeed AI Video"),', '"wavespeed": "Greenroom 托管生视频",');
patch('webui/Main.py', '"openai_image": tr("OpenAI Compatible Text-to-Image"),', '"openai_image": "Greenroom 托管生图",');
patch('webui/Main.py', '            tts_server_values = [server_value for server_value, _ in tts_servers]', '            tts_servers = [("azure-tts-v1", "平台托管语音（使用管理员模型与音色）")]\n            tts_server_values = [server_value for server_value, _ in tts_servers]');
patch('webui/Main.py', '    selected_bgm_type = stable_selectbox(', '    bgm_options = [(label, value) for label, value in bgm_options if value not in ("sonilo", "elevenlabs")]\n    selected_bgm_type = stable_selectbox(');
// Preserve native filesystem inputs, but API output URLs resolve to stable member Assets.
patch('app/controllers/v1/video.py', '    if file.startswith(("http://", "https://")):', '    from greenroom_delivery import ready_url\n    asset_url = ready_url(file)\n    if asset_url:\n        return asset_url\n\n    if file.startswith(("http://", "https://")):');
patch('webui/Main.py', '    state = _normalize_task_state(task.get("state"))\n    progress =', '    if task.get("delivery_status") in ("archive_pending", "archive_failed"):\n        st.warning(task.get("delivery_error") or "原生生成已完成，正在归档到成员资产库")\n        return\n\n    state = _normalize_task_state(task.get("state"))\n    progress =');
// st.video treats /api/media as a server filename. st.html is non-iframed:
// the browser resolves this escaped stable URL on the actual authenticated host.
patch('webui/Main.py', '    available_videos = [\n', '    from greenroom_delivery import ready_url\n    from html import escape as escape_html\n    asset_urls = {url: ready_url(url) for url in video_files}\n    available_videos = [\n');
patch('webui/Main.py', '        if os.path.isfile(url)\n    ]\n    for index, url in enumerate(video_files):\n        if os.path.isfile(url):', '        if asset_urls[url] or os.path.isfile(url)\n    ]\n    for index, url in enumerate(video_files):\n        if asset_urls[url] or os.path.isfile(url):');
patch('webui/Main.py', '                    st.video(url)\n', `                    asset_url = asset_urls[url]
                    if asset_url:
                        st.html('<video controls preload="metadata" style="width:100%" src="' + escape_html(asset_url, quote=True) + '"></video>')
                    else:
                        st.video(url)
`);
patch('webui/Main.py', '                    with open(url, "rb") as video_file:\n', `                    if asset_url and not os.path.isfile(url):
                        st.html('<a href="' + escape_html(asset_url, quote=True) + '" download="' + escape_html(download_name, quote=True) + '">' + escape_html(download_label) + '</a>')
                        continue
                    with open(url, "rb") as video_file:
`);
// Ready task-manager previews use the same member Asset as completion snapshots.
patch('webui/Main.py', '            has_video = bool(task["video_file"] and os.path.isfile(task["video_file"]))', '            from greenroom_delivery import ready_url\n            has_video = bool(task["video_file"] and (ready_url(task["video_file"]) or os.path.isfile(task["video_file"])))');
patch('webui/Main.py', '    if not os.path.isfile(normalized_file):\n        logger.warning(f"task video does not exist: {normalized_file}")', '    from greenroom_delivery import ready_url\n    if ready_url(normalized_file):\n        st.session_state["task_preview_video_file"] = normalized_file\n        return\n    if not os.path.isfile(normalized_file):\n        logger.warning(f"task video does not exist: {normalized_file}")');
patch('webui/Main.py', '    tasks_root = os.path.abspath(utils.task_dir())\n    if not (\n        preview_file.startswith(tasks_root + os.sep) and os.path.isfile(preview_file)\n    ):', '    from greenroom_delivery import ready_url\n    from html import escape as escape_html\n    preview_file = os.path.abspath(preview_file)\n    asset_url = ready_url(preview_file)\n    tasks_root = os.path.abspath(utils.task_dir())\n    if not (\n        preview_file.startswith(tasks_root + os.sep) and (asset_url or os.path.isfile(preview_file))\n    ):');
patch('webui/Main.py', '    st.video(preview_file)\n', `    if asset_url:
        st.html('<video controls preload="metadata" style="width:100%" src="' + escape_html(asset_url, quote=True) + '"></video>')
        st.html('<a href="' + escape_html(asset_url, quote=True) + '" download="' + escape_html(os.path.basename(preview_file), quote=True) + '">' + escape_html(tr("Download Video")) + '</a>')
    else:
        st.video(preview_file)
`);

// Only future validated native image/video uploads enter the raw Asset journal.
patch('app/services/material_upload.py', 'def save_material_upload(filename: str, source: BinaryIO) -> str:', 'def _native_save_material_upload(filename: str, source: BinaryIO) -> str:');
const uploadFile = join(root, 'app/services/material_upload.py');
writeFileSync(uploadFile, readFileSync(uploadFile, 'utf8') + '\nfrom greenroom_raw_materials import save_upload as _greenroom_save_upload, RegistrationError as _RegistrationError\nclass MaterialRegistrationError(MaterialServiceError):\n    pass\ndef save_material_upload(filename: str, source: BinaryIO) -> str:\n    try:\n        return _greenroom_save_upload(_native_save_material_upload, filename, source)\n    except _RegistrationError as error:\n        raise MaterialRegistrationError(str(error)) from error\n');
patch('app/controllers/v1/video.py', '    response = {"files": video_materials_list}', '    from greenroom_raw_materials import list_materials\n    response = {"files": list_materials(video_materials_list)}');
patch('webui/Main.py', '        for file_path in saved_paths:\n            try:\n                os.remove(file_path)', '        for file_path in saved_paths:\n            from greenroom_raw_materials import retain_registered\n            if retain_registered(file_path):\n                continue\n            try:\n                os.remove(file_path)');

patch('app/controllers/v1/video.py', '    except material_upload_service.MaterialServiceError as exc:', '    except material_upload_service.MaterialRegistrationError as exc:\n        raise HttpException(task_id=request_id, status_code=503, message=str(exc))\n    except material_upload_service.MaterialServiceError as exc:');
