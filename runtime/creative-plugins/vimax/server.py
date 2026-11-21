"""Member-local ViMax business host. It invokes pipeline functions, never an agent loop."""
import asyncio
from datetime import datetime, timezone
import json
import mimetypes
import os
from pathlib import Path
import shutil
import sys
from urllib.parse import quote
from uuid import uuid4

from aiohttp import web, ClientSession

source = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(source))
root = Path(os.environ['GREENROOM_PLUGIN_ROOT']).resolve()
root.mkdir(parents=True, exist_ok=True)
os.chdir(root)
base = os.environ.get('GREENROOM_BASE_PATH', '/plugins/vimax/').rstrip('/')
broker = os.environ.get('GREENROOM_BROKER_URL', 'http://127.0.0.1:3081').rstrip('/')
os.environ.update(VIMAX_LLM_API_KEY='greenroom-managed', VIMAX_LLM_MODEL_PROVIDER='openai',
                  VIMAX_LLM_BASE_URL=broker + '/v1', VIMAX_ENABLE_RUN_SHELL='0')

from agent_runtime.session_index import SessionIndex
from agent_runtime.vimax_adapters import build_vimax_adapter_specs
from agent_runtime.tools import ToolRuntimeContext
import agent_runtime.vimax_adapters as original
from greenroom.final_media import FinalMedia, guard_write
from greenroom.derived_media import DerivedMedia, archive_unknown
from greenroom.managed_generators import ManagedImageGenerator, ManagedVideoGenerator, current_job, request, select_model, managed_url, text_unknown

original._build_image_generator = ManagedImageGenerator
original._build_video_generator = ManagedVideoGenerator
index = SessionIndex(root)
specs = {spec.name: spec for spec in build_vimax_adapter_specs(root, index)}
task_dir = root / 'tasks'
task_dir.mkdir(exist_ok=True)
final_media = FinalMedia(root, task_dir)
derived_media = DerivedMedia(root, task_dir)
subscribers = set()
running = {}
execution_lock = asyncio.Lock()


def now():
    return datetime.now(timezone.utc).isoformat()


def persist(record):
    path = task_dir / (record['taskId'] + '.json')
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


def load_task(task_id):
    if not task_id or Path(task_id).name != task_id:
        raise web.HTTPNotFound()
    try:
        return json.loads((task_dir / (task_id + '.json')).read_text())
    except FileNotFoundError:
        raise web.HTTPNotFound()


def publish(event):
    for queue in tuple(subscribers):
        queue.put_nowait(event)


def sessions():
    data = index.load()
    records = list(data.get('sessions', {}).values())
    mapping = {'session_id': 'sessionId', 'project_name': 'projectName', 'working_dir': 'workingDir',
               'updated_at': 'updatedAt', 'created_at': 'createdAt', 'compacted_turns': 'compactionTurns'}
    records.sort(key=lambda v: v.get('updated_at', ''), reverse=True)
    return {'activeSessionId': data.get('active_session_id', ''),
            'sessions': [{mapping.get(k, k): v for k, v in record.items()} for record in records]}


def tools():
    types = {str: 'string', bool: 'boolean', int: 'integer', float: 'number', list: 'array', dict: 'object'}
    return [{'name': spec.name, 'description': spec.description,
             'inputSchema': {'type': 'object', 'properties': {key: {'type': types.get(value.type, 'string')}
                              for key, value in (spec.schema or {}).items()},
                             'required': [key for key, value in (spec.schema or {}).items() if value.required]}}
            for spec in specs.values()]


def session_path(session_id, relative=''):
    if not index.get(session_id):
        raise web.HTTPNotFound(text='工程不存在')
    directory = index.working_dir(session_id)
    path = (directory / relative).resolve()
    if path != directory and directory not in path.parents:
        raise web.HTTPForbidden()
    return path


def read_planning_artifact(session_id, artifact, shot_index=None, event_index=None, scene_index=None):
    # Fixed native artifacts only; paths are never supplied by the caller.
    entries = {
        'characters': ('script2video/characters.json', ()),
        'storyboard': ('script2video/storyboard.json', ()),
        'shot_description': ('script2video/shots/{shot_index}/shot_description.json', ('shot_index',)),
        'camera_tree': ('script2video/camera_tree.json', ()),
        'novel_compressed': ('novel2video/novel/novel_compressed.txt', ()),
        'novel_event': ('novel2video/events/event_{event_index}.json', ('event_index',)),
        'novel_relevant_chunks': ('novel2video/relevant_chunks/event_{event_index}', ('event_index',)),
        'novel_scene': ('novel2video/scenes/event_{event_index}/scene_{scene_index}.json', ('event_index', 'scene_index')),
        'novel_event_characters': ('novel2video/global_information/characters/event_level/event_{event_index}_characters.json', ('event_index',)),
        'novel_characters': ('novel2video/global_information/characters/novel_level/novel_characters_after_event_{event_index}.json', ('event_index',)),
        'novel_storyboard': ('novel2video/videos/event_{event_index}/scene_{scene_index}/storyboard.json', ('event_index', 'scene_index')),
        'novel_shot_description': ('novel2video/videos/event_{event_index}/scene_{scene_index}/shots/{shot_index}/shot_description.json', ('event_index', 'scene_index', 'shot_index')),
        'novel_camera_tree': ('novel2video/videos/event_{event_index}/scene_{scene_index}/camera_tree.json', ('event_index', 'scene_index')),
    }
    if artifact not in entries:
        raise web.HTTPBadRequest(text='仅允许已登记的原生规划产物')
    template, required = entries[artifact]
    indices = {'shot_index': shot_index, 'event_index': event_index, 'scene_index': scene_index}
    for key, value in indices.items():
        if key in required:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise web.HTTPBadRequest(text=key + ' 必须是非负整数')
        elif value is not None:
            raise web.HTTPBadRequest(text='此产物不接受 ' + key)
    relative = template.format(**indices)
    path = session_path(session_id, relative)
    if artifact == 'novel_relevant_chunks':
        if not path.is_dir():
            raise web.HTTPNotFound(text='相关片段尚不存在')
        content = []
        for item in sorted(path.glob('chunk_*-score_*.txt')):
            item_relative = relative + '/' + item.name
            scoped = session_path(session_id, item_relative)
            if scoped.is_file():
                content.append({'relativePath': item_relative, 'content': scoped.read_text(encoding='utf-8')})
        if not content:
            raise web.HTTPNotFound(text='相关片段尚不存在')
    else:
        if not path.is_file():
            raise web.HTTPNotFound(text='规划产物尚不存在')
        text = path.read_text(encoding='utf-8')
        content = json.loads(text) if path.suffix == '.json' else text
    return {'session_id': session_id, 'artifact': artifact, 'relativePath': relative, 'content': content}


def artifacts(session_id):
    directory = session_path(session_id)
    result = []
    for path in directory.rglob('*'):
        if not path.is_file() or path.is_symlink():
            continue
        mime = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        kind = 'image' if mime.startswith('image/') else 'video' if mime.startswith('video/') else 'document'
        relative = str(path.relative_to(directory))
        result.append({'name': path.name, 'path': relative, 'kind': kind, 'size': path.stat().st_size,
                       'updatedAt': datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
                       'url': base + '/api/artifact?session=' + quote(session_id) + '&path=' + quote(relative)})
    for record, item in final_media.entries(session_id).values():
        relative = str(final_media.path(record, item['path']).relative_to(directory))
        asset = final_media.reference(session_id, relative)
        if asset:
            result = [entry for entry in result if entry['path'] != relative]
            result.append({'name': Path(relative).name, 'path': relative, 'kind': 'video', 'size': item['size'],
                           'updatedAt': record['updatedAt'], 'url': asset['fileUrl'], 'assetId': asset['assetId']})
    for record, item in derived_media.entries(session_id).values():
        relative = str(derived_media.path(record, item['path']).relative_to(directory))
        asset = derived_media.reference(session_id, relative)
        if asset:
            result.append({'name': Path(relative).name, 'path': relative, 'kind': item['kind'], 'size': item['size'],
                           'updatedAt': record['updatedAt'], 'url': asset['fileUrl'], 'assetId': asset['assetId']})
    return result


async def archive(path):
    mime = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
    kind = mime.split('/')[0] if mime.split('/')[0] in ('image', 'audio', 'video') else 'document'
    async with ClientSession() as client:
        with path.open('rb') as content:
            async with client.post(managed_url + '/media/uploads', data=content, headers={
                'X-File-Name': quote(path.name), 'X-Asset-Type': kind,
                'Content-Type': mime, 'Content-Length': str(path.stat().st_size),
            }) as response:
                value = await response.json(content_type=None)
                if response.status >= 400 or not value.get('assetId'):
                    raise RuntimeError(str(value.get('error') or value.get('message') or f'归档失败 HTTP {response.status}'))
                return value


async def execute(record):
    async with execution_lock:
        try:
            with final_media.locked():
                # Scheduling snapshots are not authority across member processes.
                record = load_task(record['taskId'])
                if record['status'] in ('succeeded', 'unknown'):
                    running.pop(record['taskId'], None)
                    return
                if record.get('nativeStatus') != 'succeeded' and not resume_text_safe(record):
                    running.pop(record['taskId'], None)
                    return
                await execute_locked(record)
        except Exception:
            # Lock refusal or failed persistence must not overwrite another process,
            # nor downgrade an already committed native/result or ready binding.
            publish({'type': 'error', 'turn_id': record['taskId'],
                     'message': '媒体协调或状态保存失败；保留原任务，稍后恢复，不重新提交'})
            running.pop(record['taskId'], None)


async def execute_locked(record):
    record['status'] = 'processing'
    persist(record)
    token = current_job.set({'record': record, 'save': lambda: persist(record)})
    try:
        if record.get('mediaStorageVersion') == 1:
            if record.get('nativeStatus') == 'succeeded':
                if record.get('derivedMediaVersion') == 1:
                    await derived_media.deliver(record, persist)
                await final_media.deliver(record, persist)
                return
            directory = session_path(record['arguments']['session_id'])
            final_media.begin(record, directory)
            persist(record)
            final_media.prune()
            guard_write()
            await final_media.restore(record['arguments']['session_id'])
            await derived_media.restore(record['arguments']['session_id'])
        os.environ['VIMAX_LLM_MODEL'] = await select_model('llm')
        publish({'type': 'turn', 'turn_id': record['taskId']})
        publish({'type': 'tool_start', 'turn_id': record['taskId'], 'tool': {'name': record['tool']}})
        if record['tool'] == 'vimax_novel_planning' or (record['tool'] == 'vimax_render_video' and original._novel_mode_ready(index.artifact_checklist(record['arguments'].get('session_id')))):
            os.environ.update(VIMAX_EMBEDDING_MODEL=await select_model('embedding'),
                VIMAX_RERANKER_MODEL=await select_model('rerank'),
                VIMAX_EMBEDDING_API_KEY='greenroom-managed', VIMAX_RERANKER_API_KEY='greenroom-managed',
                VIMAX_EMBEDDING_BASE_URL=managed_url, VIMAX_RERANKER_BASE_URL=managed_url)
        runtime = ToolRuntimeContext(requested_name=record['tool'], canonical_name=record['tool'],
                                     turn_id=record['taskId'], progress_callback=publish)
        result = await specs[record['tool']].handler(record['arguments'], runtime)
        record['result'] = result.as_dict()
        record['sessionId'] = result.metadata.get('session_id', record['arguments'].get('session_id'))
        if result.ok and record.get('mediaStorageVersion') == 1 and not text_unknown(record):
            record.update(nativeStatus='succeeded', deliveryStatus='archive_pending')
        persist(record)
        if result.ok and record.get('mediaStorageVersion') == 1:
            if text_unknown(record):
                raise RuntimeError('文本请求状态未知，保留原任务，不自动归档或重发')
            if record.get('derivedMediaVersion') == 1:
                await derived_media.deliver(record, persist)
            await final_media.deliver(record, persist)
        elif result.ok:
            record['outputs'] = []
            final_paths = [result.metadata['final_video_path']] if result.metadata.get('final_video_path') else []
            final_paths += [str(Path(directory) / 'final_video.mp4') for directory in result.metadata.get('scene_video_dirs', [])]
            for relative in final_paths:
                path = (root / relative).resolve()
                if root not in path.parents:
                    raise RuntimeError('成片路径超出成员工程')
                record['outputs'].append(await archive(path))
            record['status'] = 'succeeded'
        else:
            record['status'] = 'failed'
            record['error'] = result.content
        publish({'type': 'tool_result', 'turn_id': record['taskId'], 'tool_result': result.as_dict()})
    except asyncio.CancelledError:
        # Persisted processing tasks resume with their accepted provider IDs.
        raise
    except Exception as error:
        record['status'] = 'failed'
        record['error'] = str(error)
        if record.get('nativeStatus') == 'succeeded':
            record['deliveryStatus'] = 'archive_failed'
            record['mediaLease'] = True
            record['error'] = '原生成片已完成，资产归档未完成；恢复原任务只继续归档，不重新生成'
        publish({'type': 'error', 'turn_id': record['taskId'], 'message': str(error)})
    finally:
        if archive_unknown(record):
            record['status'] = 'unknown'
            record['mediaLease'] = True
            record['error'] = '派生媒体上传受理未知，保留原任务、本地文件和已知 Asset；禁止自动重传或重新生成'
        if text_unknown(record):
            record['status'] = 'unknown'
            record['error'] = '文本请求受理或回复未知，保留原任务和请求编号，禁止自动重发'
        if record.get('mediaStorageVersion') == 1 and record.get('nativeStatus') != 'succeeded':
            # Retain crash/unknown and accepted-but-unresolved generation leases.
            unresolved = text_unknown(record) or any(step.get('taskId') and not step.get('output') for step in record.get('generations', []))
            if record['status'] == 'failed' and not unresolved:
                record['mediaLease'] = False
        current_job.reset(token)
        record['updatedAt'] = now()
        persist(record)
        if record.get('mediaStorageVersion') == 1 and record.get('status') == 'succeeded':
            try:
                final_media.prune()
            except Exception:
                # Delivery remains successful; a conservative cache refusal is not native failure.
                record['cacheError'] = '成片已归档；本地缓存暂未回收，原件保留'
                persist(record)
        publish({'type': 'sessions_changed', **sessions()})
        publish({'type': 'done', 'turn_id': record['taskId']})
        running.pop(record['taskId'], None)


def submit(tool, arguments, call_id=None):
    with final_media.locked():
        guard_write()
        return submit_locked(tool, arguments, call_id)


def submit_locked(tool, arguments, call_id=None):
    if tool not in specs:
        raise web.HTTPNotFound(text='未知 ViMax 业务工具')
    if call_id:
        for path in task_dir.glob('*.json'):
            previous = json.loads(path.read_text())
            if previous.get('callId') == call_id:
                return previous
    spec = specs[tool]
    for key, value in (spec.schema or {}).items():
        if value.required and key not in arguments:
            raise web.HTTPBadRequest(text='缺少参数 ' + key)
    arguments = dict(arguments)
    if tool in ('vimax_narrative_planning', 'vimax_novel_planning'):
        session = spec.handler.__self__._resolve_session(str(arguments.get('session_id') or ''),
            idea=str(arguments.get('novel_text') or arguments.get('idea') or ''), script=str(arguments.get('script') or ''),
            user_requirement=str(arguments.get('user_requirement') or ''), style=str(arguments.get('style') or 'Cinematic, coherent, 16:9'))
        arguments['session_id'] = session['session_id']
    elif not arguments.get('session_id') and index.active():
        arguments['session_id'] = index.active()['session_id']
    if arguments.get('session_id') and final_media.unresolved(arguments['session_id'], ''):
        raise web.HTTPConflict(text='本工程已有活动或未知原任务，先查询或恢复原任务')
    record = {'taskId': str(uuid4()), 'tool': tool, 'arguments': arguments, 'callId': call_id,
              'status': 'pending', 'textRecoveryVersion': 1, 'ragRecoveryVersion': 1, 'createdAt': now(), 'updatedAt': now()}
    if tool == 'vimax_render_video':
        record['mediaStorageVersion'] = 1
        record['derivedMediaVersion'] = 1
    persist(record)
    running[record['taskId']] = asyncio.create_task(execute(record))
    return record


def message_arguments(body):
    session_id = body.get('sessionId')
    if not isinstance(session_id, str) or not index.get(session_id):
        raise web.HTTPBadRequest(text='请先选择当前成员已有工程')
    text = str(body.get('text') or '').strip()
    # Also accept a newline after the command, preserving the original prose.
    parts = text.split(None, 1)
    command = parts[0] if parts else ''
    content = parts[1] if len(parts) == 2 else ''
    uploads = body.get('uploads', [])
    if not isinstance(uploads, list) or any(not isinstance(value, str) for value in uploads):
        raise web.HTTPBadRequest(text='上传引用格式无效')
    arguments = {'session_id': session_id}
    if command == '/render':
        if content or uploads:
            raise web.HTTPBadRequest(text='/render 仅消费当前工程已有规划，不接受正文或附件')
        return 'vimax_render_video', arguments
    if command.startswith('/') and command not in ('/script', '/novel'):
        raise web.HTTPBadRequest(text='支持 /novel、/script 和 /render；不会把未知命令当生成请求')
    if uploads:
        if command not in ('/script', '/novel') or len(uploads) != 1:
            raise web.HTTPBadRequest(text='仅 /novel 或 /script 可读取一个已上传的 UTF-8 TXT')
        relative = Path(uploads[0])
        if len(relative.parts) != 2 or relative.parts[0] != 'uploads' or relative.suffix.lower() != '.txt':
            raise web.HTTPBadRequest(text='仅允许当前工程 uploads 下的 TXT')
        path = session_path(session_id, str(relative))
        if not path.is_file() or path.stat().st_size > 50 * 1024 * 1024:
            raise web.HTTPBadRequest(text='正文文件不存在或超出已有文档大小限制')
        try:
            prose = path.read_text(encoding='utf-8-sig')
        except UnicodeError:
            raise web.HTTPBadRequest(text='小说或剧本文件须为 UTF-8 TXT')
        arguments['user_requirement'] = content
    else:
        prose = content if command in ('/script', '/novel') else text
    if not prose.strip():
        raise web.HTTPBadRequest(text='正文不能为空')
    tool = 'vimax_novel_planning' if command == '/novel' else 'vimax_narrative_planning'
    arguments['novel_text' if command == '/novel' else 'script' if command == '/script' else 'idea'] = prose
    return tool, arguments


async def handle(req):
    path = req.path
    if path == '/api/greenroom/lifecycle':
        return web.json_response({'known': True, 'busy': bool(running)})
    if path == '/api/health':
        return web.json_response({'ok': True, 'agentRunning': True, 'activeSessionId': sessions()['activeSessionId']})
    if path == '/api/tools' and req.method == 'GET':
        return web.json_response(tools())
    if path.startswith('/api/tools/') and req.method == 'POST':
        body = await req.json()
        return web.json_response(submit(path.rsplit('/', 1)[1], body.get('arguments', {}), body.get('callId')), status=202)
    if path.startswith('/api/tasks/'):
        record = load_task(path.rsplit('/', 1)[1])
        if req.method == 'POST':
            with final_media.locked():
                record = load_task(path.rsplit('/', 1)[1])
                if record['status'] not in ('succeeded', 'unknown') and record['taskId'] not in running:
                    if record.get('nativeStatus') != 'succeeded' and not resume_text_safe(record):
                        return web.json_response(record)
                    if final_media.unresolved(record['arguments'].get('session_id'), record['taskId']):
                        raise web.HTTPConflict(text='工程仍有其它活动或未知任务')
                    record['status'] = 'pending'
                    persist(record)
                    running[record['taskId']] = asyncio.create_task(execute(record))
        return web.json_response(record)
    if path == '/api/config':
        raise web.HTTPForbidden(text='API 配置由 Greenroom 管理员统一管理')
    if path == '/api/sessions':
        if req.method == 'DELETE':
            session_id = req.query.get('session', '')
            if any(v.get('arguments', {}).get('session_id') == session_id and v['taskId'] in running
                   for v in (json.loads(p.read_text()) for p in task_dir.glob('*.json'))):
                raise web.HTTPConflict(text='工程仍有执行中的任务')
            with final_media.locked():
                if final_media.unresolved(session_id, ''):
                    raise web.HTTPConflict(text='工程仍有活动或未知任务，保留原媒体')
                directory = session_path(session_id)
                data = index.load()
                del data['sessions'][session_id]
                data['active_session_id'] = next(iter(data['sessions']), '')
                index.save(data)
                shutil.rmtree(directory)
        return web.json_response(sessions())
    if path == '/api/planning-artifact':
        if req.method != 'GET':
            raise web.HTTPMethodNotAllowed(req.method, ['GET'])
        if set(req.query) - {'session', 'artifact', 'shot_index', 'event_index', 'scene_index'}:
            raise web.HTTPBadRequest(text='不接受任意路径或附加参数')
        indices = {}
        for key in ('shot_index', 'event_index', 'scene_index'):
            value = req.query.get(key)
            if value is not None:
                if not value.isascii() or not value.isdigit():
                    raise web.HTTPBadRequest(text=key + ' 必须是非负整数')
                indices[key] = int(value)
        return web.json_response(read_planning_artifact(req.query.get('session', ''),
                                 req.query.get('artifact', ''), **indices))
    if path == '/api/artifacts':
        return web.json_response({'artifacts': artifacts(req.query.get('session', ''))})
    if path == '/api/artifact':
        asset = final_media.reference(req.query.get('session', ''), req.query.get('path', ''))
        if not asset:
            asset = derived_media.reference(req.query.get('session', ''), req.query.get('path', ''))
        if asset:
            raise web.HTTPFound(location=asset['fileUrl'])
        return web.FileResponse(session_path(req.query.get('session', ''), req.query.get('path', '')))
    if path == '/api/uploads' and req.method == 'POST':
        name = Path(req.query.get('name', '')).name
        directory = session_path(req.query.get('session', ''), 'uploads')
        directory.mkdir(exist_ok=True)
        destination = directory / (str(uuid4()) + '-' + name)
        with final_media.locked():
            guard_write(req.content_length or 0)
            with destination.open('wb') as output:
                async for chunk in req.content.iter_chunked(65536):
                    guard_write(len(chunk))
                    output.write(chunk)
        return web.json_response({'file': {'name': name, 'path': 'uploads/' + destination.name,
                                          'size': destination.stat().st_size}}, status=201)
    if path == '/api/history':
        session_id = req.query.get('session', '')
        values = []
        for file in task_dir.glob('*.json'):
            record = json.loads(file.read_text())
            if record.get('sessionId') == session_id or record['arguments'].get('session_id') == session_id:
                values.append({'id': record['taskId'], 'role': 'error' if record['status'] == 'failed' else 'activity',
                               'text': record.get('error') or record.get('result', {}).get('content') or record['tool'],
                               'status': 'running' if record['status'] in ('pending', 'processing') else 'done',
                               'createdAt': record['createdAt']})
        return web.json_response({'messages': sorted(values, key=lambda v: v['createdAt'])})
    if path == '/api/agent/start' and req.method == 'POST':
        body = await req.json()
        session_id = body.get('sessionId', '')
        if session_id and index.get(session_id):
            index.set_active(session_id)
        else:
            index.create(project_name=body.get('projectName', ''))
        publish({'type': 'bridge_status', 'status': 'ready'})
        publish({'type': 'sessions_changed', **sessions()})
        return web.json_response({'ok': True, 'sessionId': sessions()['activeSessionId']})
    if path == '/api/messages' and req.method == 'POST':
        body = await req.json()
        tool, arguments = message_arguments(body)
        record = submit(tool, arguments)
        return web.json_response({'ok': True, 'taskId': record['taskId']}, status=202)
    if path == '/api/agent/stop' and req.method == 'POST':
        # UI disconnection does not cancel accepted jobs.
        return web.json_response({'ok': True})
    if path == '/api/events':
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'})
        await response.prepare(req)
        queue = asyncio.Queue()
        subscribers.add(queue)
        queue.put_nowait({'type': 'bridge_status', 'status': 'ready'})
        queue.put_nowait({'type': 'sessions_changed', **sessions()})
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), 20)
                    await response.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode())
                except asyncio.TimeoutError:
                    await response.write(b': keepalive\n\n')
        finally:
            subscribers.discard(queue)
    if path.startswith('/api/'):
        raise web.HTTPNotFound()
    file = (source / 'web' / 'dist' / path.lstrip('/')).resolve()
    static = source / 'web' / 'dist'
    if static not in file.parents or not file.is_file():
        file = static / 'index.html'
    return web.FileResponse(file)


def resume_text_safe(record):
    # Old novel tasks have no durable embedding/rerank send evidence. Do not
    # silently migrate them or repeat retrieval POSTs after an uncertain crash.
    uses_rag = record.get('tool') == 'vimax_novel_planning' or 'embedding' in record.get('models', {})
    if uses_rag and not record.get('ragRecoveryVersion'):
        record['status'] = 'unknown'
        record['error'] = '旧小说任务缺少检索发送记录，保留原编号；须核对原任务，禁止自动重发'
        persist(record)
        return False
    # Legacy records need verified pre-send evidence before an explicit migration.
    if text_unknown(record) or not record.get('textRecoveryVersion'):
        record['status'] = 'unknown'
        record['error'] = '文本发送记录不完整或受理状态未知，禁止自动重发；需核对原任务'
        persist(record)
        return False
    record['textRecoveryVersion'] = 1
    return True


async def startup(app):
    for file in task_dir.glob('*.json'):
        record = json.loads(file.read_text())
        if record['status'] in ('pending', 'processing'):
            running[record['taskId']] = asyncio.create_task(execute(record))


async def cleanup(app):
    for task in tuple(running.values()):
        task.cancel()
    await asyncio.gather(*tuple(running.values()), return_exceptions=True)


app = web.Application(client_max_size=512 * 1024 * 1024)
app.router.add_route('*', '/{path:.*}', handle)
app.on_startup.append(startup)
app.on_cleanup.append(cleanup)
if __name__ == '__main__':
    web.run_app(app, host='0.0.0.0', port=int(os.environ.get('PORT', '18810')))
