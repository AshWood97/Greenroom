"""ArcReel business backends; credentials and paid jobs belong to Greenroom."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import fcntl
import ipaddress
import json
import logging
import mimetypes
import os
import re
import sqlite3
import stat
import subprocess
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import Request

ROOT = Path(os.environ['GREENROOM_PLUGIN_ROOT']).resolve()
MANAGED = os.environ.get('GREENROOM_MANAGED_URL', 'http://127.0.0.1:18767/managed').rstrip('/')
CATALOG = json.loads(os.environ.get('GREENROOM_MODELS', '{}'))
SETTINGS = json.loads(os.environ.get('GREENROOM_SETTINGS', '{}'))
CATALOG_READY = os.environ.get('GREENROOM_ARCREEL_CATALOG_READY') == '1'
REFRESH_LOCK = asyncio.Lock()

from greenroom_bridge import bridge_error_message, pick_task_output

class ManagedQueryPending(RuntimeError):
    pass

class ManagedSubmissionRejected(RuntimeError):
    pass

class ArchiveSourceChanged(RuntimeError):
    pass

def _db():
    db = sqlite3.connect(ROOT / 'greenroom-jobs.sqlite3', timeout=30)
    db.row_factory = sqlite3.Row
    with db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS jobs (owner TEXT PRIMARY KEY, business_id TEXT, kind TEXT, payload TEXT, task_id TEXT, error TEXT)')
        if 'submission_state' not in {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}:
            # Legacy rows without an ID may already have reached the provider.
            db.execute("ALTER TABLE jobs ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'unknown'")
    return db

def _archive_db():
    db = _db()
    db.execute('''CREATE TABLE IF NOT EXISTS final_cut_archives (
        owner TEXT PRIMARY KEY, project TEXT NOT NULL, business_id TEXT NOT NULL,
        payload TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, asset_id TEXT, file_url TEXT, file_size INTEGER,
        file_version TEXT, error TEXT, UNIQUE(project, business_id))''')
    return db

@asynccontextmanager
async def _archive_lock():
    fd = os.open(ROOT / 'arcreel-delivery.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    locked = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except BlockingIOError:
                await asyncio.sleep(0.05)
        yield
    finally:
        if locked:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

def broker_url():
    configured = os.environ.get('GREENROOM_BROKER_URL', 'http://127.0.0.1:3081').strip().rstrip('/')
    if not re.fullmatch(r'http://[A-Za-z0-9._-]+(?::\d{1,5})?', configured):
        raise ValueError('托管代理地址无效')
    host = configured.removeprefix('http://').split(':', 1)[0]
    if host != 'localhost' and not ipaddress.ip_address(host).is_loopback:
        raise ValueError('托管代理地址必须指向本机')
    return configured

def file_version(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]

def open_final_cut(project_dir, artifact_path):
    project_dir = Path(project_dir)
    relative = Path(artifact_path)
    if (project_dir.parent.resolve() != (ROOT / 'projects').resolve()
            or relative.is_absolute() or not relative.parts or '..' in relative.parts):
        raise ValueError('产物不属于原项目目录')
    directory = os.open(project_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in relative.parts[:-1]:
            next_dir = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_dir
        handle = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    info = os.fstat(handle)
    if not stat.S_ISREG(info.st_mode):
        os.close(handle)
        raise ValueError('产物不是普通文件')
    return os.fdopen(handle, 'rb')

async def get_archive_operation(client, operation_id):
    response = await client.get(broker_url() + '/api/media/upload-operations/' + quote(operation_id, safe=''))
    if response.status_code == 404:
        return None
    if response.is_error:
        raise RuntimeError(f'归档状态查询失败（HTTP {response.status_code}），保留原任务和文件')
    result = response.json()
    if not isinstance(result, dict) or result.get('state') not in ('init_unknown', 'initialized', 'put_unknown', 'put_complete', 'ready'):
        raise RuntimeError('归档操作状态无效，保留原任务和文件')
    return result

async def upload_final_cut_asset(client, project_dir, payload, version, operation_id):
    with open_final_cut(project_dir, payload['artifact_path']) as source:
        if file_version(os.fstat(source.fileno())) != version:
            raise ArchiveSourceChanged('原成片已变化，保留原归档操作')

        async def content():
            while chunk := source.read(256 * 1024):
                yield chunk

        try:
            response = await client.post(broker_url() + '/api/media/stable-uploads', content=content(), headers={
                'Content-Length': str(version[2]), 'Content-Type': 'video/mp4',
                'X-File-Name': quote(Path(payload['artifact_path']).name, safe=''),
                'X-Asset-Type': 'video', 'X-Greenroom-Archive-Operation': operation_id,
                'X-Greenroom-Archive-Target': operation_id,
            }, timeout=600)
        finally:
            if file_version(os.fstat(source.fileno())) != version:
                raise ArchiveSourceChanged('上传期间原成片已变化，保留原归档操作')
        if response.is_error:
            raise RuntimeError(f'成片归档未完成（HTTP {response.status_code}），保留原任务和文件')
        result = response.json()
        return result

async def read_final_cut_asset(client, asset, payload, size):
    asset_id = asset.get('assetId') if isinstance(asset, dict) else None
    if not isinstance(asset_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,199}', asset_id):
        raise ValueError('资产服务未返回有效的归档标识')
    url = '/api/media/' + quote(asset_id, safe='')
    if asset.get('fileUrl') != url:
        raise ValueError('资产服务返回的成员归档地址不一致')
    expected = {'fileName': Path(payload['artifact_path']).name, 'fileSize': size,
                'assetType': 'video', 'mimeType': 'video/mp4'}
    if any(asset.get(key) != value for key, value in expected.items()):
        raise ValueError('资产服务返回的成片信息不一致')
    count = 0
    async with client.stream('GET', broker_url() + url, headers={'Accept-Encoding': 'identity'}, timeout=120) as response:
        if response.status_code != 200:
            raise RuntimeError('最终产物暂不可读取')
        async for chunk in response.aiter_bytes(256 * 1024):
            count += len(chunk)
            if count > size:
                raise RuntimeError('最终产物远端大小不一致')
    if count != size:
        raise RuntimeError('最终产物尚未完整读取')
    return {'assetId': asset_id, 'fileUrl': url, 'fileName': Path(payload['artifact_path']).name,
            'fileSize': size, 'assetType': 'video', 'mimeType': 'video/mp4'}

def archive_projection(row):
    result = {'status': row['status'], 'operationId': row['operation_id']}
    if row['status'] == 'ready':
        result['asset'] = {'assetId': row['asset_id'], 'fileUrl': row['file_url'],
                           'fileSize': row['file_size'], 'assetType': 'video', 'mimeType': 'video/mp4'}
    elif row['error']:
        result['error'] = row['error']
    return result

async def archive_final_cut(project_name, timeline_id, artifact_path, *, business_id,
                            version=1, narration='', subtitles='', project_dir=None, client=None):
    if not project_name or not timeline_id or not artifact_path or not business_id:
        raise ValueError('成片归档缺少原项目或任务编号')
    payload = {'project': project_name, 'timeline_id': timeline_id, 'artifact_path': artifact_path,
               'version': version, 'narration': narration, 'subtitles': subtitles}
    owner = json.dumps([project_name, business_id], ensure_ascii=False, separators=(',', ':'))
    project_path = Path(project_dir) if project_dir else ROOT / 'projects' / project_name
    async with _archive_lock():
        with _archive_db() as db:
            row = db.execute('SELECT * FROM final_cut_archives WHERE owner=?', (owner,)).fetchone()
            if row is None:
                db.execute('''INSERT INTO final_cut_archives
                    (owner, project, business_id, payload, operation_id, status)
                    VALUES (?, ?, ?, ?, ?, 'archive_pending')''',
                    (owner, project_name, business_id, json.dumps(payload, ensure_ascii=False), 'arcreel-' + uuid4().hex))
                row = db.execute('SELECT * FROM final_cut_archives WHERE owner=?', (owner,)).fetchone()
            elif json.loads(row['payload']) != payload:
                raise ValueError('原成片任务身份与归档记录不一致')
            if row['status'] == 'ready':
                return dict(row)
            if row['status'] == 'archive_conflict':
                raise ArchiveSourceChanged(row['error'])

        async def deliver(c):
            if row['file_version']:
                version_info = json.loads(row['file_version'])
            else:
                with open_final_cut(project_path, artifact_path) as source:
                    info = os.fstat(source.fileno())
                    if not 0 < info.st_size <= 512 * 1024 * 1024:
                        raise ValueError('最终产物大小无效或超出上传限制')
                    version_info = file_version(info)
                with _archive_db() as db:
                    db.execute('UPDATE final_cut_archives SET file_size=?, file_version=? WHERE owner=?',
                               (version_info[2], json.dumps(version_info), owner))

            operation_id = row['operation_id']
            operation = await get_archive_operation(c, operation_id)
            if operation is not None:
                expected = {'target': operation_id, 'fileName': Path(artifact_path).name,
                            'fileSize': version_info[2], 'mimeType': 'video/mp4', 'assetType': 'video'}
                if any(operation.get(key) != value for key, value in expected.items()):
                    raise ValueError('原归档操作与当前成片不一致')
                state = operation['state']
            else:
                state = None
            if state == 'ready':
                asset = operation.get('result')
            elif state in (None, 'initialized'):
                asset = await upload_final_cut_asset(c, project_path, payload, version_info, operation_id)
            else:
                raise RuntimeError('成片归档受理状态尚未确认，请核对原归档操作')
            asset_info = await read_final_cut_asset(c, asset, payload, version_info[2])
            with _archive_db() as db:
                db.execute('''UPDATE final_cut_archives SET status='ready', asset_id=?, file_url=?, error=NULL
                    WHERE owner=?''', (asset_info['assetId'], asset_info['fileUrl'], owner))
                return dict(db.execute('SELECT * FROM final_cut_archives WHERE owner=?', (owner,)).fetchone())

        try:
            if client is not None:
                return await deliver(client)
            async with httpx.AsyncClient(timeout=120, follow_redirects=False) as default_client:
                return await deliver(default_client)
        except Exception as exc:
            with _archive_db() as db:
                status = 'archive_conflict' if isinstance(exc, ArchiveSourceChanged) else 'archive_failed'
                db.execute('UPDATE final_cut_archives SET status=?, error=? WHERE owner=?',
                           (status, '原生成片已完成，资产归档待恢复：' + str(exc), owner))
            raise

async def archive_final_cut_task(task, result, projects):
    payload = task.get('payload') or {}
    try:
        project_name = str(task.get('project_name') or '')
        row = await archive_final_cut(project_name, str(payload.get('timeline_id') or result.timeline_id),
            result.artifact_path, business_id=str(task.get('task_id') or ''), version=result.version,
            narration=str(payload.get('narration') or result.narration),
            subtitles=str(payload.get('subtitles') or result.subtitles),
            project_dir=projects.get_project_path(project_name))
        return archive_projection(row)
    except Exception as exc:
        logging.getLogger(__name__).warning('ArcReel 成片归档未完成：%s', exc)
        return {'status': 'archive_failed', 'error': '原生成片已完成，资产归档待恢复：' + str(exc)}

async def restore_final_cut_archives():
    with _archive_db() as db:
        rows = [dict(row) for row in db.execute(
            "SELECT payload, business_id FROM final_cut_archives WHERE status IN ('archive_pending', 'archive_failed')")]
    restored = 0
    for row in rows:
        payload = json.loads(row['payload'])
        try:
            result = await archive_final_cut(payload['project'], payload['timeline_id'], payload['artifact_path'],
                business_id=row['business_id'], version=payload['version'], narration=payload['narration'],
                subtitles=payload['subtitles'])
            restored += result['status'] == 'ready'
        except Exception as exc:
            logging.getLogger(__name__).warning('ArcReel 原成片归档恢复未完成：%s', exc)
    return restored

def project_batch_archives(project, result):
    content = result.get('structuredContent') or {}
    batch = content.get('generation_batch') or {}
    generation = batch.get('generation_result') or {}
    if not project or not isinstance(generation, dict):
        return result
    archives = []
    with _archive_db() as db:
        for item in generation.get('items') or []:
            if not isinstance(item, dict) or not item.get('task_id'):
                continue
            row = db.execute('SELECT * FROM final_cut_archives WHERE project=? AND business_id=?',
                             (project, item['task_id'])).fetchone()
            if row:
                item['archive'] = archive_projection(row)
                archives.append({'taskId': item['task_id'], **item['archive']})
    if archives:
        result.setdefault('content', []).append({'type': 'text',
            'text': '成片归档：' + json.dumps(archives, ensure_ascii=False)})
    return result

def _id(item):
    return item if isinstance(item, str) else item.get('id') or item.get('model')

def model_ids(kind):
    return SETTINGS.get('models', {}).get(kind, [_id(item) for item in CATALOG.get(kind, [])])

def storyboard_can_plan_without_video():
    return CATALOG_READY and not model_ids('video')


def managed_bare_provider_model(provider, media_type):
    if provider != 'openai':
        return None
    if not CATALOG_READY:
        raise RuntimeError('平台模型目录暂不可用，旧项目迁移已延后')
    kind = {'text': 'llm', 'audio': 'tts'}.get(media_type, media_type)
    choices = model_ids(kind)
    if not choices:
        raise ValueError(f'{media_type} 类型模型未开放，旧项目迁移等待管理员配置')
    return choices[0]

def managed_image_quality_options(model):
    if model not in model_ids('image'):
        return ()
    caps = _facts(model, 'image').get('capabilities') or {}
    qualities = caps.get('qualities')
    if caps.get('verification_status') != 'verified' or not isinstance(qualities, list):
        return ()
    return tuple(value for value in qualities if isinstance(value, str) and value)

def accepted_model(kind, model=None):
    with _db() as db:
        if model is None:
            return db.execute("SELECT 1 FROM jobs WHERE kind=? AND task_id IS NOT NULL LIMIT 1", (kind,)).fetchone() is not None
        return db.execute("SELECT 1 FROM jobs WHERE kind=? AND task_id IS NOT NULL AND json_extract(payload,'$.model')=? LIMIT 1", (kind, model)).fetchone() is not None

def accepted_audio_model(model=None):
    return accepted_model('tts', model)

def accepted_audio_catalog(model, model_type):
    return model_type(display_name=model, media_type='audio', capabilities=['text_to_speech'], api_model_name=model) if accepted_audio_model(model) else None

def _facts(model, kind):
    return next((item for item in CATALOG.get(kind, []) if isinstance(item, dict) and _id(item) == model), {})

def catalog_models(model_type):
    result = {}
    for kind, media_type, capabilities in [('llm', 'text', ['text_generation', 'structured_output']), ('image', 'image', ['text_to_image', 'image_to_image']), ('video', 'video', []), ('tts', 'audio', ['text_to_speech'])]:
        for index, model in enumerate(model_ids(kind)):
            facts = _facts(model, kind)
            caps = facts.get('capabilities') or {}
            declared = list(capabilities)
            modalities = caps.get('input_modalities')
            if kind == 'llm' and caps.get('verification_status') == 'verified' and isinstance(modalities, list) and 'image' in modalities:
                declared.append('vision')
            reference_limit = ManagedImage(model).max_reference_images if kind == 'image' else None
            if kind == 'image' and reference_limit == 0:
                declared.remove('image_to_image')
            result[model] = model_type(display_name=facts.get('label') or facts.get('name') or model, media_type=media_type, capabilities=declared,
              default=index == 0, api_model_name=model,
              supported_durations=caps.get('durations') or caps.get('durationOptions') or ([SETTINGS.get('parameters', {}).get('video', {}).get('duration', 5)] if kind == 'video' else []),
              resolutions=caps.get('resolutions') or [], max_output_tokens=caps.get('maxTokens'),
              **({'max_reference_images': reference_limit} if kind == 'image' else {}))
    return result

def video_capabilities(model):
    from arcreel_market_core.video_backend_contract import VideoCapabilities, ReferenceAudioMode
    caps = _facts(model, 'video').get('capabilities') or {}
    audio_count = caps.get('maxReferenceAudio')
    audio_count = int(audio_count) if audio_count is not None else None
    reference_audio = bool(caps.get('referenceAudio')) and audio_count != 0
    reference_images = caps.get('maxReferenceImages')
    return VideoCapabilities(text_to_video=True, first_frame=True, last_frame=bool(caps.get('lastFrame') or caps.get('supportsLastFrame')),
        max_reference_images=int(reference_images) if reference_images is not None else 1,
        reference_audio_mode=ReferenceAudioMode.DIRECT if reference_audio else ReferenceAudioMode.NONE,
        max_reference_audio_count=audio_count if reference_audio else 0)

async def call(route, body=None, submission=None):
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.request('GET' if body is None else 'POST', MANAGED + route, json=body,
            headers={'X-T8-Provider-Submission': submission} if submission else {})
        result = response.json()
        if response.is_error or result.get('success') is False:
            if (submission and result.get('submitted') is False
                    and result.get('code') in ('greenroom.submission_not_sent', 'greenroom.managed_route_not_found')):
                raise ManagedSubmissionRejected(bridge_error_message(result, response.status_code))
            raise RuntimeError(bridge_error_message(result, response.status_code))
        return result.get('data', result)

def retry_deferred_migrations():
    from lib.infra.data_root_layout import list_project_dirs
    from lib.project.project_manager import get_project_manager
    from lib.project.project_migration_failure import clear_migration_failure, load_migration_failure, record_migration_failure
    from lib.project.project_migration_report import complete_migration_report
    from lib.project.project_migrations.v19_to_v20_bare_provider_models import migrate_v19_to_v20
    from lib.project.project_schema import parse_project_schema_version
    projects_dir = get_project_manager().projects_dir
    if not projects_dir.exists():
        return
    for project in list_project_dirs(projects_dir):
        failure = load_migration_failure(project)
        if not failure or failure.schema_version != 19:
            continue
        retry = failure.reason == '平台模型目录暂不可用，旧项目迁移已延后'
        for media_type in ('text', 'image', 'video', 'audio'):
            if failure.reason == f'{media_type} 类型模型未开放，旧项目迁移等待管理员配置':
                kind = {'text': 'llm', 'audio': 'tts'}.get(media_type, media_type)
                retry = bool(model_ids(kind))
                break
        if not retry:
            continue
        try:
            migrate_v19_to_v20(project, bare_provider_models=managed_bare_provider_model)
            project_file = project / 'project.json'
            if not project_file.is_file() or parse_project_schema_version(json.loads(project_file.read_text())) != 20:
                continue
            complete_migration_report(project, to_schema_version=20)
            clear_migration_failure(project)
        except ValueError as error:
            if str(error) not in {f'{kind} 类型模型未开放，旧项目迁移等待管理员配置' for kind in ('text', 'image', 'video', 'audio')}:
                raise
            record_migration_failure(project, error, schema_version=19)

async def refresh():
    global CATALOG, SETTINGS, CATALOG_READY
    try:
        settings = await call('/plugins/arcreel/settings')
        catalog = settings['catalog']
        if not isinstance(catalog, dict) or not isinstance(settings['models'], dict):
            raise ValueError('ArcReel 模型目录未就绪')
    except (Exception, asyncio.CancelledError):
        async with REFRESH_LOCK:
            CATALOG_READY = False
        raise
    async with REFRESH_LOCK:
        retry_migrations = not CATALOG_READY or SETTINGS.get('models') != settings['models']
        CATALOG, SETTINGS, CATALOG_READY = catalog, settings, True
        if retry_migrations:
            retry = asyncio.create_task(asyncio.to_thread(retry_deferred_migrations))
            try:
                await asyncio.shield(retry)
            except asyncio.CancelledError:
                await retry
                raise

def text_parameters():
    return SETTINGS.get('parameters', {}).get('llm', {})

async def upload(filename):
    filename = Path(filename).resolve()
    if not filename.is_relative_to(ROOT):
        raise ValueError('参考素材必须来自成员私有目录')
    mime = mimetypes.guess_type(filename.name)[0] or 'application/octet-stream'
    async with httpx.AsyncClient(timeout=120) as client:
        with filename.open('rb') as source:
            response = await client.post(MANAGED + '/media/uploads', content=source.read(), headers={
                'Content-Type': mime, 'X-File-Name': quote(filename.name), 'X-Asset-Type': mime.split('/')[0]})
        result = response.json()
        if response.is_error or result.get('success') is False:
            raise RuntimeError(bridge_error_message(result, response.status_code))
        return result.get('data', result)['fileUrl']

async def validate_prepared_image(row, owner, kind):
    if kind == 'image' and not row['task_id'] and row['submission_state'] == 'prepared':
        # A prepared payload has not been sent. Validate its original model
        # and actual references, not today's reconstructed request, at first send.
        await refresh()
        with _db() as db:
            row = db.execute('SELECT * FROM jobs WHERE owner=?', (owner,)).fetchone()
        # Another caller may have accepted this exact owner during refresh.
        # Its original ID is authoritative; do not apply new-request gates to it.
        if not row['task_id'] and row['submission_state'] == 'prepared':
            payload = json.loads(row['payload'])
            references = payload.get('reference_images')
            if references is None:
                references = []
            if not isinstance(references, list):
                raise ValueError('图片参考素材记录格式无效')
            if payload.get('model') not in model_ids('image'):
                raise ValueError('该生成模型未获得管理员授权')
            from lib.backends.image_capabilities import gate_image_request
            await gate_image_request(ManagedImage(payload['model']), provider_id='openai',
                                     reference_count=len(references))
    return row

async def submit(request, kind, model):
    output = Path(request.output_path).resolve()
    if not output.is_relative_to(ROOT):
        raise ValueError('产物必须写入成员私有目录')
    business_id = getattr(request, 'task_id', None)
    owner = f'{kind}:{business_id or output.relative_to(ROOT).as_posix()}'
    with _db() as db:
        row = db.execute('SELECT * FROM jobs WHERE owner=?', (owner,)).fetchone()
    if not row:
        await refresh()
        if model not in model_ids(kind):
            raise ValueError('该生成模型未获得管理员授权')
        if kind == 'image' and request.reference_images:
            # Native planning checked the old catalog. Recheck actual references
            # after this refresh, before uploads, a durable claim or creation.
            # Accepted IDs keep their original recovery path.
            from lib.backends.image_capabilities import gate_image_request
            await gate_image_request(ManagedImage(model), provider_id='openai',
                                     reference_count=len(request.reference_images))
        defaults = SETTINGS.get('parameters', {}).get(kind, {})
        if kind == 'tts':
            payload = {**defaults, 'model': model, 'text': request.text, 'voice': request.voice or defaults.get('voice', 'alloy')}
            if request.speed is not None:
                payload['speed'] = request.speed
            payload.setdefault('response_format', 'wav')
        else:
            payload = {**defaults, 'model': model, 'prompt': request.prompt, 'aspect_ratio': request.aspect_ratio}
            if kind == 'image':
                payload['n'] = 1
                if request.image_size:
                    payload['size'] = request.image_size
                if request.quality:
                    payload['quality'] = request.quality
                if request.reference_images:
                    payload['reference_images'] = [await upload(ref.path) for ref in request.reference_images]
            else:
                payload['duration'] = request.duration_seconds
                payload['generate_audio'] = request.generate_audio
                for field, remote in [('start_image', 'first_frame_url'), ('end_image', 'last_frame_url')]:
                    if getattr(request, field):
                        payload[remote] = await upload(getattr(request, field))
                for field, remote in [('reference_images', 'reference_image_urls'), ('reference_audio_files', 'reference_audio_urls')]:
                    if getattr(request, field):
                        payload[remote] = [await upload(item) for item in getattr(request, field)]
                if request.resolution:
                    payload['resolution'] = request.resolution
            if request.seed is not None:
                payload['seed'] = request.seed
            provider_params = {key: payload.pop(key) for key in ('quality', 'negative_prompt') if key in payload}
            if provider_params:
                payload['providerParams'] = provider_params
        with _db() as db:
            db.execute("INSERT OR IGNORE INTO jobs(owner,business_id,kind,payload,submission_state) VALUES(?,?,?,?,'prepared')", (owner, business_id, kind, json.dumps(payload, ensure_ascii=False)))
            row = db.execute('SELECT * FROM jobs WHERE owner=?', (owner,)).fetchone()
    row = await validate_prepared_image(row, owner, kind)
    task_id = row['task_id']
    if not task_id and row['submission_state'] == 'rejected':
        raise ManagedSubmissionRejected(row['error'] or '平台明确未受理该请求')
    if kind == 'video' and request.on_provider_resubmit_unsafe:
        request.on_provider_resubmit_unsafe()
    if not task_id:
        # Commit the claim before network I/O. A lost response or process exit
        # must not turn an attempted submission back into a fresh POST.
        with _db() as db:
            claimed = db.execute("UPDATE jobs SET submission_state='submitting' WHERE owner=? AND task_id IS NULL AND submission_state='prepared'", (owner,)).rowcount
            row = db.execute('SELECT * FROM jobs WHERE owner=?', (owner,)).fetchone()
        task_id = row['task_id']
        if not task_id:
            if not claimed:
                raise submission_pending(row)
            try:
                task = await call('/' + kind + '/submit', json.loads(row['payload']), 'arcreel:' + quote(owner, safe=''))
                task_id = task.get('taskId')
                if not isinstance(task_id, str) or not task_id.strip():
                    raise RuntimeError('平台未返回生成任务编号')
                with _db() as db:
                    db.execute("UPDATE jobs SET task_id=?,submission_state='accepted',error=NULL WHERE owner=?", (task_id, owner))
            except ManagedSubmissionRejected as error:
                with _db() as db:
                    db.execute("UPDATE jobs SET submission_state='rejected',error=? WHERE owner=?", (str(error), owner))
                raise
            except (Exception, asyncio.CancelledError) as error:
                raise submission_pending(row) from error
    if business_id:
        from lib.backends.backend_runtime import persist_provider_job_id
        try:
            await persist_provider_job_id(business_id, task_id, provider='openai', endpoint=None, base_url=MANAGED)
        except (Exception, asyncio.CancelledError) as error:
            raise ManagedQueryPending('平台已受理，业务编号回写待恢复；不要重新提交。原平台任务编号：' + task_id) from error
    return task_id

def submission_pending(row):
    error = ('生成请求受理状态未知，可能已计费；请核对原任务，不要重新提交。原业务编号：'
             + str(row['business_id'] or row['owner']))
    with _db() as db:
        db.execute('UPDATE jobs SET error=? WHERE owner=?', (error, row['owner']))
    return ManagedQueryPending(error)

async def download(task_id, request, kind):
    try:
        last_error = ''
        timeout = getattr(request, 'poll_timeout_seconds', 3600)
        for attempt in range(max(1, int(timeout / 10))):
            try:
                task = await call('/tasks/' + quote(task_id, safe=''))
            except Exception as error:
                last_error = str(error)
                with _db() as db:
                    db.execute('UPDATE jobs SET error=? WHERE task_id=?', (last_error, task_id))
                await asyncio.sleep(10)
                continue
            if task.get('status') in ('failed', 'cancelled'):
                raise RuntimeError(bridge_error_message(task))
            if task.get('status') == 'succeeded':
                picked = pick_task_output(task, kind)
                if not picked:
                    raise ManagedQueryPending('平台尚未返回可读取的产物；原任务编号：' + task_id)
                asset_id, output_url = picked
                try:
                    destination = Path(request.output_path)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    downloaded = destination.with_name(destination.name + '.managed-source') if kind == 'audio' else destination
                    async with httpx.AsyncClient(timeout=120) as client:
                        async with client.stream('GET', MANAGED + '/media/' + quote(asset_id, safe='')) as response:
                            response.raise_for_status()
                            with downloaded.open('wb') as target:
                                async for chunk in response.aiter_bytes():
                                    target.write(chunk)
                    if kind == 'audio':
                        try:
                            child = await asyncio.create_subprocess_exec('ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(downloaded), '-vn', '-c:a', 'pcm_s16le', str(destination), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
                            _, reason = await child.communicate()
                            if child.returncode:
                                raise RuntimeError('成员旁白音频转换未完成：' + reason.decode('utf8', errors='replace')[:500])
                        finally:
                            downloaded.unlink(missing_ok=True)
                    return output_url
                except Exception as error:
                    raise ManagedQueryPending('生成已完成，成员产物读取尚未完成：' + str(error) + '；原任务编号：' + task_id) from error
            await asyncio.sleep(10)
        raise ManagedQueryPending((last_error or '查询达到上限，生成结果尚未确认') + '；原任务编号：' + task_id)
    except asyncio.CancelledError as error:
        # Active worker cancellation is a process interruption, not a user
        # cancellation (native user cancellation only accepts queued tasks).
        # The pending handlers update only running rows, preserving terminal
        # states and deleted-project handling while retaining the original ID.
        raise ManagedQueryPending('原任务查询或产物读取被中断，将沿原编号恢复；原任务编号：' + task_id) from error

class ManagedImage:
    name = 'openai'
    def __init__(self, model):
        self.model = model
    @property
    def capabilities(self):
        from lib.backends.image_backends.base import ImageCapability
        capabilities = {ImageCapability.TEXT_TO_IMAGE}
        if self.max_reference_images != 0:
            capabilities.add(ImageCapability.IMAGE_TO_IMAGE)
        return capabilities
    @property
    def max_reference_images(self):
        caps = _facts(self.model, 'image').get('capabilities') or {}
        if caps.get('verification_status') != 'verified':
            return 0
        limit = caps.get('maxReferenceImages')
        if type(limit) is int and limit >= 0:
            return limit
        # A verified image input may omit its limit. Do not invent a four-image cap.
        modalities = caps.get('input_modalities')
        if limit is None and isinstance(modalities, list) and 'image' in modalities:
            return None
        return 0
    async def reference_image_limit(self):
        return self.max_reference_images
    @staticmethod
    def accepted_request_backend(task_id, output_path):
        output = Path(output_path).resolve()
        if not output.is_relative_to(ROOT):
            return None
        owner = f'image:{task_id or output.relative_to(ROOT).as_posix()}'
        with _db() as db:
            row = db.execute("SELECT task_id,json_extract(payload,'$.model') AS model FROM jobs WHERE owner=? AND kind='image'",
                             (owner,)).fetchone()
        if (row and isinstance(row['task_id'], str) and row['task_id'].strip()
                and isinstance(row['model'], str) and row['model'].strip()):
            # Recovery belongs to the durable request, not today's default model.
            # Keep this backend request-local so other calls retain their choice.
            return ManagedImage(row['model'])
        return None
    @staticmethod
    def prepared_request_backend(task_id, output_path):
        output = Path(output_path).resolve()
        if not output.is_relative_to(ROOT):
            return None
        owner = f'image:{task_id or output.relative_to(ROOT).as_posix()}'
        with _db() as db:
            row = db.execute("SELECT payload FROM jobs WHERE owner=? AND kind='image' AND task_id IS NULL AND submission_state='prepared'",
                             (owner,)).fetchone()
        if row:
            payload = json.loads(row['payload'])
            model = payload.get('model')
            references = payload.get('reference_images')
            if references is None:
                references = []
            if not isinstance(references, list):
                raise ValueError('图片参考素材记录格式无效')
            if isinstance(model, str) and model.strip():
                # The durable payload, not reconstructed native inputs, owns the
                # first send's model and count. Fresh catalog/CAS checks still run.
                backend = ManagedImage(model)
                backend.prepared_reference_count = len(references)
                return backend
        return None
    async def generate(self, request):
        from lib.backends.image_backends.base import ImageGenerationResult
        backend = (self.accepted_request_backend(getattr(request, 'task_id', None), request.output_path)
                   or self.prepared_request_backend(getattr(request, 'task_id', None), request.output_path) or self)
        task_id = await submit(request, 'image', backend.model)
        uri = await download(task_id, request, 'image')
        return ImageGenerationResult(image_path=request.output_path, provider='openai', model=backend.model, image_uri=uri)

def accepted_image_context(task_id, project_name, user_id):
    # Only task-aware native image entries can recover without a current model.
    # Never choose an arbitrary historical model for an unscoped new request.
    if not isinstance(task_id, str) or not task_id.strip():
        return None
    backend = ManagedImage.accepted_request_backend(task_id, ROOT)
    if backend is None:
        return None
    from lib.config.resolver import ProviderModel
    from lib.generation.media_generator import MediaGenerator
    from lib.project.project_manager import get_project_manager
    from server.services.tasks.generation_context import GenerationContext, ImageLaneResult
    project_path = get_project_manager().get_project_path(project_name).resolve()
    if not project_path.is_relative_to(ROOT):
        raise ValueError('恢复工程必须来自成员私有目录')
    return GenerationContext(
        generator=MediaGenerator(project_path, image_backend=backend,
                                 image_provider_id='openai', user_id=user_id),
        image_lane=ImageLaneResult(provider_model=ProviderModel('openai', backend.model),
            backend_name=backend.name, backend_model=backend.model,
            resolution=None, max_reference_images=None))


class ManagedVideo:
    name = 'openai'
    def __init__(self, model):
        self.model = model
    @property
    def capabilities(self):
        return video_capabilities(self.model)
    @property
    def video_capabilities(self):
        return self.capabilities
    async def generate(self, request):
        task_id = await submit(request, 'video', self.model)
        return await self.resume_video(task_id, request)
    async def resume_video(self, job_id, request):
        from arcreel_market_core.video_backend_contract import VideoGenerationResult
        uri = await download(job_id, request, 'video')
        return VideoGenerationResult(video_path=request.output_path, provider='openai', model=self.model,
            duration_seconds=request.duration_seconds, video_uri=uri, task_id=job_id, generate_audio=request.generate_audio)

class ManagedAudio:
    name = 'openai'
    def __init__(self, model):
        self.model = model
    @property
    def capabilities(self):
        from lib.backends.audio_backends.base import AudioCapability
        return {AudioCapability.TEXT_TO_SPEECH, AudioCapability.SPEECH_SPEED}
    def list_voices(self):
        from lib.backends.audio_backends.base import VoiceOption
        from lib.backends.audio_backends.openai import _VOICE_CATALOG
        configured = SETTINGS.get('parameters', {}).get('tts', {}).get('voice', 'alloy')
        with _db() as db:
            previous = [json.loads(row['payload']).get('voice') for row in db.execute("SELECT payload FROM jobs WHERE kind='tts' AND task_id IS NOT NULL AND json_extract(payload,'$.model')=?", (self.model,))]
        voices = list(dict.fromkeys([configured, *previous, *(item.id for item in _VOICE_CATALOG)]))
        return [VoiceOption(id=voice, label=voice) for voice in voices if voice]
    async def synthesize(self, request):
        from lib.backends.audio_backends.base import AudioSynthesisResult
        task_id = await submit(request, 'tts', self.model)
        await download(task_id, request, 'audio')
        with _db() as db:
            row = db.execute("SELECT payload FROM jobs WHERE task_id=? AND kind='tts'", (task_id,)).fetchone()
        payload = json.loads(row['payload'])
        return AudioSynthesisResult(provider='openai', model=payload['model'], text=payload['text'], output_path=request.output_path)

async def seed():
    if not CATALOG_READY:
        return
    from lib.db import async_session_factory
    from lib.config.repository import SystemSettingRepository
    from lib.db.repositories.credential_repository import CredentialRepository
    async with async_session_factory() as session:
        credentials = CredentialRepository(session)
        current = await credentials.get_active('openai')
        broker = os.environ.get('GREENROOM_BROKER_URL', 'http://127.0.0.1:3081') + '/v1'
        if current is None:
            await credentials.create('openai', 'Greenroom 托管', api_key='greenroom-managed', base_url=broker)
        else:
            await credentials.update(current.id, api_key='greenroom-managed', base_url=broker)
        settings = SystemSettingRepository(session)
        for kind, key in [('llm', 'default_text_backend'), ('image', 'default_image_backend'), ('video', 'default_video_backend'), ('tts', 'default_audio_backend')]:
            choices = model_ids(kind)
            await settings.set(key, f'openai/{choices[0]}' if choices else '')
        speech = SETTINGS.get('parameters', {}).get('tts', {})
        await settings.set('narration_voice', speech.get('voice', 'alloy'))
        await settings.set('narration_speed', str(speech['speed']) if speech.get('speed') is not None else '')
        await settings.set('onboarding_seen', 'true')
        await session.commit()

async def waiting(task, error):
    from sqlalchemy import update
    from lib.db import async_session_factory
    from lib.db.models.task import Task
    async with async_session_factory() as session:
        await session.execute(update(Task).where(Task.task_id == task['task_id'], Task.status == 'running').values(error_message=str(error)))
        await session.commit()

async def recover_managed_submission(task):
    with _db() as db:
        known = db.execute('SELECT * FROM jobs WHERE business_id=?', (task['task_id'],)).fetchone()
    if known and not known['task_id'] and known['submission_state'] not in ('prepared', 'rejected'):
        await waiting(task, submission_pending(known))
        return True
    if known and known['task_id'] and known['kind'] == 'video' and not task.get('provider_job_id'):
        # The member-local receipt may be committed before ArcReel's task row.
        # Restore only the original ID, never rebuild the immutable checkpoint.
        from sqlalchemy import update
        from lib.db import async_session_factory
        from lib.db.models.task import Task
        try:
            async with async_session_factory() as session:
                await session.execute(update(Task).where(
                    Task.task_id == task['task_id'], Task.status == 'running',
                    Task.provider_job_id.is_(None)).values(
                        provider_job_id=known['task_id'], submitted_base_url=MANAGED))
                await session.commit()
                original = await session.get(Task, task['task_id'], populate_existing=True)
                if original is None or original.status != 'running':
                    return True
                if original.provider_job_id != known['task_id']:
                    raise RuntimeError('原生任务编号与托管回执不一致')
                task.update(provider_job_id=original.provider_job_id,
                            submitted_base_url=original.submitted_base_url)
        except (Exception, asyncio.CancelledError) as error:
            await waiting(task, ManagedQueryPending('原平台任务编号待回填；不要重新提交：' + known['task_id']))
            return True
    return False

async def requeue_managed(task):
    from sqlalchemy import update
    from lib.db import async_session_factory
    from lib.db.models.task import Task
    with _db() as db:
        known = db.execute('SELECT * FROM jobs WHERE business_id=?', (task['task_id'],)).fetchone()
    if known:
        if not known['task_id'] and known['submission_state'] == 'rejected':
            return False
        if not known['task_id'] and known['submission_state'] != 'prepared':
            await waiting(task, submission_pending(known))
            return True
        if not known['task_id'] and not CATALOG_READY:
            await waiting(task, ManagedQueryPending('模型目录暂不可用，原请求尚未发送'))
            return True
        async with async_session_factory() as session:
            values = {'status': 'queued', 'started_at': None}
            if known['kind'] == 'tts':
                original = await session.get(Task, task['task_id'])
                payload = json.loads(original.payload_json or '{}')
                payload.update(audio_provider='openai', audio_model=json.loads(known['payload'])['model'])
                values['payload_json'] = json.dumps(payload, ensure_ascii=False)
            await session.execute(update(Task).where(Task.task_id == task['task_id'], Task.status == 'running').values(**values))
            await session.commit()
        return True
    return False

async def restore_managed_tasks(queue, worker):
    if not worker or not worker._owns_lease or not worker._orphan_handled_once or worker._stop_event.is_set():
        return 0
    recovery = worker._recovery
    dispatcher = recovery.orphan_dispatcher_task
    videos = []
    restored = 0
    for task in await queue.list_orphan_tasks_on_start():
        task_id = task['task_id']
        if task_id in worker._slots.active_task_ids():
            continue
        if task.get('media_type') in ('image', 'audio') or task.get('task_type') == 'tts':
            if await requeue_managed(task):
                restored += 1
            continue
        if task.get('media_type') != 'video' and task.get('task_type') not in ('video', 'reference_video'):
            continue
        if (dispatcher is not None and not dispatcher.done()) or any(not item.done() for item in recovery._retry_dispatch_tasks):
            continue
        with _db() as db:
            known = db.execute("SELECT task_id FROM jobs WHERE business_id=? AND kind='video'", (task_id,)).fetchone()
        if not known or not known['task_id']:
            continue
        if not task.get('provider_job_id') and await recover_managed_submission(task):
            continue
        if task.get('provider_job_id') != known['task_id']:
            continue
        if task.get('task_type') in ('video', 'reference_video'):
            from lib.script.reference_video.execution_checkpoint import VideoResumeState, classify_video_resume_state
            state, checkpoint = classify_video_resume_state(task)
            if state is not VideoResumeState.READY or checkpoint.provider_id != 'openai':
                continue
            task['provider_id'] = checkpoint.provider_id
        elif task.get('provider_id') != 'openai':
            continue
        videos.append(task)
    if videos and worker._capacity.get('openai', 'video') > 0:
        from lib.config.service import read_video_poll_timeout_seconds
        timeout = await read_video_poll_timeout_seconds()
        dispatcher = recovery.orphan_dispatcher_task
        if (worker._owns_lease and worker._orphan_handled_once and not worker._stop_event.is_set()
                and (dispatcher is None or dispatcher.done())
                and not any(not item.done() for item in recovery._retry_dispatch_tasks)):
            videos = [task for task in videos if task['task_id'] not in worker._slots.active_task_ids()]
            if videos:
                for task in videos:
                    task['video_poll_timeout_seconds'] = timeout
                dispatch = asyncio.create_task(recovery.dispatch_resumable({'openai': videos}), name='greenroom-video-recovery')
                recovery._retry_dispatch_tasks.add(dispatch)
                dispatch.add_done_callback(recovery._retry_dispatch_tasks.discard)
                restored += len(videos)
    return restored

def install(app):
    from fastapi import Request
    from fastapi.responses import JSONResponse, StreamingResponse
    from lib.db.base import DEFAULT_USER_ID
    from lib.project.project_manager import get_project_manager
    from server.agent_toolset.remote import remote_tool, remote_input_schema, remote_description
    from server.agent_toolset.toolset import AGENT_TOOLSET
    from server.tool_runtime import CallerContext, Services
    projects = get_project_manager()
    services = Services.defaults(projects)
    # These upstream tools require separately configured provider accounts;
    # Greenroom assets and credentials are managed by the platform instead.
    disabled_tools = {'get_provider_asset_links', 'list_provider_library_assets', 'release_provider_asset_link',
                      'select_provider_library_asset', 'upload_to_provider_asset_library'}
    available_tools = [item for item in AGENT_TOOLSET if item.name not in disabled_tools]
    tools = {item.name: remote_tool(item, projects=projects, services=services,
      caller=lambda: CallerContext(user_id=DEFAULT_USER_ID, source='mcp')) for item in available_tools}
    active_requests = 0
    restore_lock = asyncio.Lock()

    @app.get('/api/greenroom/lifecycle')
    async def lifecycle_state():
        return {'known': True, 'busy': active_requests > 0}

    @app.middleware('http')
    async def managed_boundary(request: Request, call_next):
        nonlocal active_requests
        if request.url.path == '/api/greenroom/lifecycle':
            return await call_next(request)
        route = request.url.path.removeprefix('/api/v1')
        blocked = ('/assistant', '/agent', '/agent-memory', '/api-keys', '/custom-providers', '/custom-endpoints', '/providers', '/market', '/official-service', '/object-storage', '/asset-library')
        if route.startswith(blocked) or 'provider-asset-links' in route.split('/') or (route == '/system/config' and request.method != 'GET'):
            return JSONResponse({'detail': '服务配置由 Greenroom 管理员统一维护，创作调度请使用 DSH'}, status_code=403)
        if request.method in ('POST', 'PUT', 'PATCH') and route.startswith('/projects'):
            await refresh()
            await seed()
        active_requests += 1
        try:
            return await call_next(request)
        finally:
            active_requests -= 1
    @app.get('/api/greenroom/tools')
    async def list_tools():
        return {'tools': [{'name': item.name, 'description': remote_description(item), 'inputSchema': remote_input_schema(item)} for item in available_tools]}
    @app.post('/api/greenroom/call')
    async def invoke(request: Request):
        body = await request.json()
        tool = tools.get(body['name'])
        if not tool:
            return JSONResponse({'error': '未知业务工具'}, status_code=404)
        if body['name'] not in ('get_generation_batch', 'cancel_generation_batch'):
            await refresh()
            await seed()
        result = (await tool.invoke(body.get('arguments', {}))).model_dump(mode='json', exclude_none=True)
        if body.get('name') == 'get_generation_batch':
            project_batch_archives(body.get('arguments', {}).get('project'), result)
        return result
    @app.post('/api/greenroom/restore')
    async def restore():
        from lib.generation.generation_queue import get_generation_queue
        queue = get_generation_queue()
        async with restore_lock:
            restored = await restore_managed_tasks(queue, getattr(app.state, 'generation_worker', None))
        archived_restored = await restore_final_cut_archives()
        return {'restoring': restored, 'archived_restored': archived_restored,
                'video': '沿原平台任务编号继续查询'}
    @app.get('/greenroom/source')
    async def source():
        def stream():
            process = subprocess.Popen(['tar', '-cz', '--exclude=.git', '--exclude=.venv', '--exclude=node_modules', '--exclude=dist', '--exclude=__pycache__', '--exclude=.env', '-C', '/opt', 'arcreel'], stdout=subprocess.PIPE)
            try:
                while chunk := process.stdout.read(65536):
                    yield chunk
            finally:
                process.stdout.close()
                process.wait()
        return StreamingResponse(stream(), media_type='application/gzip', headers={'Content-Disposition': 'attachment; filename="arcreel-greenroom-source.tar.gz"'})
    # Static SPA fallback is last; insert the managed business and source routes before it.
    app.router.routes.sort(key=lambda route: 0 if getattr(route, 'path', '').startswith(('/api/greenroom/', '/greenroom/')) else 1)
