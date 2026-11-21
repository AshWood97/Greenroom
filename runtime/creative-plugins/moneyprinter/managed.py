"""Managed model/material adapter for the pinned MoneyPrinter pipeline."""
import json
import logging
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from greenroom_state import ROOT, SqliteState, connect
from greenroom_bridge import bridge_error_message, pick_task_output

MANAGED = os.environ.get('GREENROOM_MANAGED_URL', 'http://127.0.0.1:18767/managed').rstrip('/')
CATALOG = json.loads(os.environ.get('GREENROOM_MODELS', '{}'))
SETTINGS = json.loads(os.environ.get('GREENROOM_SETTINGS', '{}'))
STATE = SqliteState()
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='moneyprinter')
_running = set()
_raw_restoring = False
_lock = threading.Lock()

class QueryPending(RuntimeError):
    pass

def call(route, payload=None, submission=None):
    headers = {'Content-Type': 'application/json'}
    if submission:
        headers['X-T8-Provider-Submission'] = submission
    response = requests.request('GET' if payload is None else 'POST', MANAGED + route,
                                json=payload, headers=headers, timeout=120)
    result = response.json()
    if not response.ok or result.get('success') is False:
        raise RuntimeError(bridge_error_message(result, response.status_code))
    return result.get('data', result)

def refresh():
    global CATALOG, SETTINGS
    CATALOG = call('/models')
    SETTINGS = call('/plugins/moneyprinter/settings')

def available(kind):
    return SETTINGS.get('models', {}).get(kind, CATALOG.get(kind) or [])

def model(kind):
    items = available(kind)
    if not items:
        raise RuntimeError('管理员尚未启用' + {'llm': '文本', 'image': '图片', 'video': '视频', 'tts': '语音'}[kind] + '模型')
    return items[0] if isinstance(items[0], str) else items[0].get('id') or items[0].get('model')

def text(prompt, app_config=None, request_timeout=None, max_retries=None):
    refresh()
    result = call('/chat/completions', {**SETTINGS.get('parameters', {}).get('llm', {}), 'model': model('llm'), 'messages': [{'role': 'user', 'content': prompt}], 'stream': False})
    return result['choices'][0]['message'].get('content') or ''

def speech(text, voice_name, voice_rate, voice_file, voice_volume=1.0,
           voxcpm_reference_audio=None, voxcpm_prompt_audio=None, voxcpm_prompt_text=''):
    """Keep the original audio/subtitle pipeline on the managed speech provider."""
    from app.services.voice import get_audio_duration, is_no_voice, _single_tts
    from app.utils import utils
    from edge_tts import SubMaker
    if voxcpm_reference_audio is not None or voxcpm_prompt_audio is not None:
        raise ValueError('当前托管语音仅支持文本，不支持个人语音模型或声音克隆')
    narration = utils.remove_emoji(text)
    if is_no_voice(voice_name):
        if narration != text and not narration.strip():
            logging.getLogger(__name__).warning('去除表情后没有可朗读的文本')
            return None
        return _single_tts(narration, voice_name, voice_rate, voice_file, voice_volume)
    owner = Path(voice_file).parent.name + ':tts'
    with connect() as db:
        row = db.execute('SELECT * FROM materials WHERE id=?', (owner,)).fetchone()
    if row:
        # A resumed task must retain the text of its original submitted speech.
        text = json.loads(row['payload']).get('text', text)
    elif narration != text and not narration.strip():
        logging.getLogger(__name__).warning('去除表情后没有可朗读的文本')
        return None
    else:
        text = narration
    refresh()
    with connect() as db:
        row = db.execute('SELECT * FROM materials WHERE id=?', (owner,)).fetchone()
        if not row:
            parameters = SETTINGS.get('parameters', {}).get('tts', {})
            payload = {**parameters, 'model': model('tts'), 'text': text,
                       'voice': parameters.get('voice', 'alloy'), 'speed': voice_rate,
                       'response_format': 'mp3'}
            db.execute('INSERT INTO materials(id,payload) VALUES(?,?)', (owner, json.dumps(payload, ensure_ascii=False)))
            row = db.execute('SELECT * FROM materials WHERE id=?', (owner,)).fetchone()
    target = Path(voice_file)
    if not row['local_file'] or not target.is_file():
        task_id = row['task_id']
        if not task_id:
            task_id = call('/tts/submit', json.loads(row['payload']), 'moneyprinter:' + owner)['taskId']
            with connect() as db:
                db.execute('UPDATE materials SET task_id=? WHERE id=?', (task_id, owner))
        completed = None
        for _ in range(180):
            try:
                task = call('/tasks/' + task_id)
            except Exception as error:
                with connect() as db:
                    db.execute('UPDATE materials SET error=? WHERE id=?', (str(error), owner))
                time.sleep(10)
                continue
            if task.get('status') in ('failed', 'cancelled'):
                raise RuntimeError(bridge_error_message(task))
            if task.get('status') == 'succeeded':
                completed = task
                break
            time.sleep(1)
        picked = pick_task_output(completed or {}, 'audio')
        if not picked:
            raise QueryPending('语音产物尚未确认，保留原任务编号：' + task_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        with requests.get(MANAGED + '/media/' + picked[0], stream=True, timeout=120) as response:
            response.raise_for_status()
            with target.open('wb') as destination:
                for chunk in response.iter_content(1024 * 1024):
                    destination.write(chunk)
        with connect() as db:
            db.execute('UPDATE materials SET local_file=?,error=NULL WHERE id=?', (str(target), owner))
    duration = get_audio_duration(str(target))
    if duration <= 0:
        raise RuntimeError('托管语音没有可读取的实际时长')
    # One caption spans the exact whole utterance. The speech API supplies no
    # word alignment, so this does not invent word-level provider timestamps.
    captions = SubMaker()
    captions.greenroom_timing_granularity = 'utterance'
    captions.feed({'type': 'SentenceBoundary', 'offset': 0,
                   'duration': round(duration * 10_000_000), 'text': text})
    return captions

def configure(config):
    config.app.update(llm_provider='openai', openai_api_key='greenroom-managed',
                      openai_base_url=MANAGED, openai_model_name=model('llm') if available('llm') else '',
                      openai_image_base_url=MANAGED, openai_image_model=model('image') if available('image') else '',
                      openai_image_api_keys=['greenroom-managed'], wavespeed_api_key='greenroom-managed',
                      video_source='local', endpoint='/plugins/moneyprinter', enable_redis=False,
                      enable_marengo=False, upload_post_api_key='')
    config.ui['tts_server'] = 'azure-tts-v1'

def checkpoint(task_id, **updates):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT params FROM jobs WHERE id=?', (task_id,)).fetchone()
        if row:
            params = json.loads(row['params'])
            params.update(updates)
            db.execute('UPDATE jobs SET params=? WHERE id=?', (json.dumps(params, ensure_ascii=False), task_id))

def _run(task_id):
    from greenroom_final_cache import native_lease
    try:
        with native_lease():
            _run_owned(task_id)
    finally:
        with _lock:
            _running.discard(task_id)

def _run_owned(task_id):
    from app.models.schema import VideoParams
    from app.services import task
    from greenroom_final_cache import StoragePressure
    from greenroom_raw_materials import prepare_inputs, finish_inputs, InputPending
    try:
        from greenroom_delivery import snapshot, archive
        from greenroom_final_cache import admit, evict_final
        delivery = snapshot(task_id)
        if delivery and delivery['status'] != 'generating':
            finish_inputs(task_id)
            archive(task_id)
            evict_final(task_id)
            return
        with connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (task_id,)).fetchone()
            if not row:
                return
            db.execute("UPDATE jobs SET state='running' WHERE id=?", (task_id,))
        admit()
        params = json.loads(row['params'])
        params.setdefault('video_subject', params.get('video_script', ''))
        prepare_inputs(task_id, params)
        task.start(task_id, VideoParams.model_validate(params), stop_at=row['stop_at'])
        state = STATE.get_task(task_id) or {}
        delivery = snapshot(task_id)
        if delivery and delivery['status'] != 'generating':
            finish_inputs(task_id)
            archive(task_id)
            evict_final(task_id)
            return
        with connect() as db:
            db.execute('UPDATE jobs SET state=? WHERE id=?', ('waiting' if state.get('state') == 4 else 'done', task_id))
    except (StoragePressure, InputPending) as error:
        STATE.patch_task(task_id, error=str(error))
        with connect() as db:
            db.execute("UPDATE jobs SET state='waiting' WHERE id=?", (task_id,))
    except Exception as error:
        from greenroom_delivery import snapshot
        delivery = snapshot(task_id)
        if delivery and delivery['status'] != 'generating':
            logging.getLogger(__name__).warning('原生任务已完成，交付待恢复：%s', task_id)
            return
        STATE.update_task(task_id, state=-1, failed_stage='pipeline', error=str(error))
        with connect() as db:
            db.execute("UPDATE jobs SET state='done' WHERE id=?", (task_id,))

def enqueue(task_id, params, stop_at='video', **unused):
    from greenroom_final_cache import admit, POLICY
    admit()
    if params.video_source not in ('local', 'openai_image', 'wavespeed'):
        raise ValueError('当前托管素材来源为本地素材、托管图片和托管视频')
    refresh()
    defaults = SETTINGS.get('parameters', {}).get('image' if params.video_source == 'openai_image' else 'video', {})
    payload = params.model_dump(mode='json', exclude_unset=True)
    if 'video_aspect' not in payload and defaults.get('aspect_ratio'):
        payload['video_aspect'] = defaults['aspect_ratio']
    if 'video_clip_duration' not in payload and defaults.get('duration'):
        payload['video_clip_duration'] = defaults['duration']
    payload = type(params).model_validate(payload).model_dump(mode='json')
    with connect() as db:
        inserted = db.execute('INSERT OR IGNORE INTO jobs VALUES(?,?,?,?)', (task_id, json.dumps(payload, ensure_ascii=False), stop_at, 'queued')).rowcount
        if not inserted:
            return
        db.execute('INSERT INTO deliveries VALUES(?,?)', (task_id, json.dumps({'status': 'generating', 'outputs': [], 'cache_policy': POLICY})))
    STATE.update_task(task_id, progress=0, video_subject=payload.get('video_subject') or payload.get('video_script') or task_id)
    _schedule(task_id)

def _schedule(task_id):
    with _lock:
        if task_id in _running:
            return
        _running.add(task_id)
    _executor.submit(_run, task_id)

def _restore_raw_owned():
    global _raw_restoring
    try:
        from greenroom_raw_materials import restore_uploads
        restore_uploads()
    finally:
        with _lock:
            _raw_restoring = False

def _schedule_raw_restore():
    global _raw_restoring
    with _lock:
        if _raw_restoring:
            return
        _raw_restoring = True  # queued and lock-waiting work is busy too
    try:
        _executor.submit(_restore_raw_owned)
    except BaseException:
        with _lock:
            _raw_restoring = False
        raise

def restore():
    _schedule_raw_restore()
    with connect() as db:
        rows = db.execute("SELECT id FROM jobs WHERE state != 'done'").fetchall()
    from greenroom_final_cache import pending_evictions
    ids = set(row['id'] for row in rows) | set(pending_evictions())
    for task_id in ids:
        _schedule(task_id)
    return {'restoring': len(ids)}

def is_generation_active(task_id):
    """Track accepted unfinished work across API/UI processes, not thread liveness."""
    try:
        with connect() as db:
            row = db.execute('SELECT state FROM jobs WHERE id=?', (task_id,)).fetchone()
        return row is not None and row['state'] != 'done'
    except Exception:
        # Unknown is not finished. Keep the original task selected; never submit
        # or resume from a UI status check, including after a worker restart.
        logging.getLogger(__name__).warning('托管任务状态暂不可确认，继续跟踪原任务：%s', task_id)
        return True

def submit_from_ui(task_id, params, **kwargs):
    # The API owns the worker. Closing or reloading Streamlit cannot terminate it.
    response = requests.post('http://127.0.0.1:18902/api/greenroom/jobs',
                             json={'task_id': task_id, 'params': params.model_dump(mode='json')}, timeout=30)
    response.raise_for_status()

def generate_materials(task_id, search_terms, source, video_aspect, audio_duration, max_clip_duration, image_motion, **unused):
    from app.services import material
    from app.utils import utils
    refresh()
    kind = 'image' if source == 'openai_image' else 'video'
    duration = max(1, int(max_clip_duration))
    count = max(1, math.ceil(audio_duration / duration))
    directory = Path(utils.task_dir(task_id)) / 'managed-materials'
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    terms = search_terms or ['']
    for index in range(count):
        owner = f'{task_id}:{kind}:{index}'
        with connect() as db:
            row = db.execute('SELECT * FROM materials WHERE id=?', (owner,)).fetchone()
            if not row:
                payload = {**SETTINGS.get('parameters', {}).get(kind, {}), 'model': model(kind), 'prompt': terms[index % len(terms)], 'aspect_ratio': str(getattr(video_aspect, 'value', video_aspect))}
                payload.update({'n': 1} if kind == 'image' else {'duration': duration})
                provider_params = {key: payload.pop(key) for key in ('quality', 'negative_prompt') if key in payload}
                if provider_params:
                    payload['providerParams'] = provider_params
                db.execute('INSERT INTO materials(id,payload) VALUES(?,?)', (owner, json.dumps(payload, ensure_ascii=False)))
                row = db.execute('SELECT * FROM materials WHERE id=?', (owner,)).fetchone()
        if row['local_file'] and Path(row['local_file']).is_file():
            files.append(row['local_file'])
            continue
        task_ref = row['task_id']
        if not task_ref:
            task_ref = call('/' + kind + '/submit', json.loads(row['payload']), 'moneyprinter:' + owner).get('taskId')
            if not task_ref:
                raise RuntimeError('平台未返回素材生成任务编号')
            with connect() as db:
                db.execute('UPDATE materials SET task_id=? WHERE id=?', (task_ref, owner))
        last_error = ''
        completed = None
        for attempt in range(180):
            try:
                status = call('/tasks/' + task_ref)
            except Exception as error:
                last_error = str(error)
                with connect() as db:
                    db.execute('UPDATE materials SET error=? WHERE id=?', (last_error, owner))
                time.sleep(10)
                continue
            if status.get('status') in ('failed', 'cancelled'):
                raise RuntimeError(bridge_error_message(status))
            if status.get('status') == 'succeeded':
                completed = status
                break
            time.sleep(10)
        if not completed:
            raise QueryPending((last_error or '生成结果尚未确认') + '；原任务编号：' + task_ref)
        picked = pick_task_output(completed, kind)
        if not picked:
            raise QueryPending('平台尚未返回可读取的产物；原任务编号：' + task_ref)
        asset_id = picked[0]
        target = directory / f'{index}.{"png" if kind == "image" else "mp4"}'
        try:
            with requests.get(MANAGED + '/media/' + asset_id, stream=True, timeout=120) as response:
                response.raise_for_status()
                with target.open('wb') as destination:
                    for chunk in response.iter_content(1024*1024):
                        destination.write(chunk)
            local_file = material._render_openai_image_video(str(target), duration, image_motion) if kind == 'image' else str(target)
            if not local_file:
                raise QueryPending('生成素材已保存，图片转视频尚未完成；原任务编号：' + task_ref)
        except Exception as error:
            raise QueryPending('素材下载或归档未完成：' + str(error) + '；原任务编号：' + task_ref) from error
        with connect() as db:
            db.execute('UPDATE materials SET local_file=?, error=NULL WHERE id=?', (local_file, owner))
        files.append(local_file)
    return files

def install(app):
    from fastapi import Request
    active_requests = 0
    @app.middleware('http')
    async def lifecycle_requests(request: Request, call_next):
        nonlocal active_requests
        if request.url.path == '/api/greenroom/lifecycle':
            return await call_next(request)
        prefixes = ('/tasks/', '/api/v1/stream/', '/api/v1/download/')
        prefix = next((value for value in prefixes if request.url.path.startswith(value)), None)
        if request.method in ('GET', 'HEAD') and prefix:
            from greenroom_delivery import ready_url
            from starlette.responses import RedirectResponse
            relative = request.url.path[len(prefix):]
            if '..' not in Path(relative).parts and not Path(relative).is_absolute():
                target = ready_url(str(ROOT / 'storage' / 'tasks' / relative))
                if target:
                    return RedirectResponse(target, status_code=307)
        active_requests += 1
        try:
            return await call_next(request)
        finally:
            active_requests -= 1
    @app.post('/api/greenroom/export/{task_id}')
    def export_task(task_id: str):
        from greenroom_delivery import archive
        delivery = archive(task_id, explicit=True)
        return {'success': True, 'data': {'task_id': task_id, 'delivery_status': delivery['status'],
                'outputs': [item['asset'] for item in delivery['outputs']]}}
    @app.get('/api/greenroom/lifecycle')
    def lifecycle_state():
        with _lock:
            return {'known': True, 'busy': bool(_running or _raw_restoring or active_requests)}
    @app.post('/api/greenroom/jobs')
    async def create_job(request: Request):
        from app.models.schema import VideoParams
        body = await request.json()
        enqueue(body['task_id'], VideoParams.model_validate(body['params']))
        return {'success': True, 'data': {'task_id': body['task_id']}}
    @app.post('/api/greenroom/restore')
    def recover_jobs():
        return {'success': True, 'data': restore()}
    @app.on_event('startup')
    def start_jobs():
        restore()
