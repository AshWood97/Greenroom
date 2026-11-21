"""Managed creative capabilities. Provider credentials never enter member runtimes."""
import asyncio
import json
import time
import uuid
from pathlib import Path

import httpx

from app.identity.auth import AuthError
from app.workspace.canvas import SubmissionRejected, generation_error_text
from app.creative.creative_catalog import creative_catalog
from app.governance.provider_routing import available_models, model_alias, provider_allows, resolve_provider
from app.workspace.canvas import OPENAI_ORIGIN

OPENAI_SPEECH_MODELS = {'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'}


CREATIVE_KINDS = ('llm', 'image', 'video', 'tts', 'music', 'embedding', 'rerank')
EXTERNAL_PROTOCOLS = {
    'tts': ('openai-speech', '/audio/speech'),
    'embedding': ('openai-embeddings', '/embeddings'),
    'rerank': ('cohere-rerank', '/rerank'),
}
PARAMETER_FIELDS = {
    'llm': {'temperature', 'max_tokens', 'top_p', 'reasoning_effort'},
    'image': {'size', 'aspect_ratio', 'n', 'seed', 'quality', 'complexity'},
    'video': {'duration', 'resolution', 'aspect_ratio', 'seed', 'generate_audio'},
    'tts': {'voice', 'speed', 'response_format'},
    'music': {'duration', 'instrumental'},
    'embedding': {'dimensions', 'encoding_format'},
    'rerank': {'top_n', 'max_tokens_per_doc'},
}


def creative_plugin(plugin_id):
    plugin = next((row for row in creative_catalog()['plugins'] if row['id'] == plugin_id), None)
    if plugin is None or plugin.get('builtin') or plugin.get('kind') == 'website' or plugin.get('status') == 'awaiting-authorization':
        raise AuthError(404, '创作插件不存在')
    return plugin


def validate_parameters(value):
    if not isinstance(value, dict) or set(value) - set(CREATIVE_KINDS):
        raise AuthError(422, '默认参数分类无效')
    for kind, parameters in value.items():
        if (not isinstance(parameters, dict) or set(parameters) - PARAMETER_FIELDS[kind]
                or any(not isinstance(item, (str, int, float, bool)) for item in parameters.values())):
            raise AuthError(422, f'{kind} 默认参数无效；仅支持该能力的业务参数')
    return value


class CreativeService:
    def __init__(self, canvas):
        self.canvas = canvas
        self.governance = canvas.governance
        self.workers = {}
        self.submission_lock = asyncio.Lock()
        self.archive_lock = asyncio.Lock()
        self.audio_root = Path(canvas.settings.data_dir) / 'creative-audio'
        self.audio_root.mkdir(parents=True, exist_ok=True)
        with canvas.lock:
            canvas.db.execute('''CREATE TABLE IF NOT EXISTS creative_tasks (
                task_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, payload TEXT NOT NULL,
                status TEXT NOT NULL, error TEXT, error_status INTEGER, format TEXT NOT NULL)''')
            canvas.db.execute('BEGIN IMMEDIATE')
            columns = {row['name'] for row in canvas.db.execute('PRAGMA table_info(creative_tasks)')}
            if 'provider_origin' not in columns:
                canvas.db.execute('ALTER TABLE creative_tasks ADD COLUMN provider_origin TEXT')
            canvas.db.commit()

    def external_models(self, plugin_id=None, *, management=False):
        grouped = {kind: [] for kind in CREATIVE_KINDS}
        for kind in ('llm', 'image', 'tts'):
            grouped[kind] = available_models(self.governance, kind, [], plugin_id, management=management)
        for provider in self.governance.list_providers():
            if not (provider['isActive'] if management else provider_allows(provider, plugin_id)):
                continue
            for model in provider['models']:
                kind = model.get('modality')
                if kind in ('embedding', 'rerank') and model.get('protocol') == EXTERNAL_PROTOCOLS[kind][0]:
                    grouped[kind].append({'id': model_alias(provider, model), 'providerId': provider['id'],
                                         'label': model.get('name') or model['id'], 'capabilities': {}})
        return grouped

    async def models(self, member, *, require_fresh=False, plugin_id=None, management=False):
        result = self.external_models(plugin_id, management=management)
        # Audio generation includes speech and effects; only explicitly verified
        # text-to-music entries are eligible for music production.
        try:
            catalog = await self.canvas.catalog(member, require_fresh=True) if require_fresh else await self.canvas.catalog(member)
        except AuthError:
            if require_fresh or not any(result.values()):
                raise
            return result
        bindings = self.governance.provider_bindings(plugin_id)
        for kind, models in self.canvas.grouped_models(catalog).items():
            if kind not in bindings:
                result[kind] = models + [row for row in result[kind] if not any(model['id'] == row['id'] for model in models)]
        if catalog.get('greenroom_local_openai') and 'tts' not in bindings:
            result['tts'] = [{'id': row['id'], 'label': row['id'], 'capabilities': {'protocol': 'openai-speech'}}
                             for row in catalog.get('data', []) if row.get('id') in OPENAI_SPEECH_MODELS] + result['tts']
        for model in catalog.get('models', []):
            capabilities = model.get('capabilities') or {}
            if (model.get('kind') == 'audio.generation' and model.get('status', 'active') == 'active'
                    and capabilities.get('verification_status') == 'verified'
                    and 'music' in capabilities.get('output_modalities', [])
                    and 'text' in capabilities.get('input_modalities', [])):
                model_id = model.get('slug') or model.get('id')
                result['music'].append({'id': model_id, 'label': model.get('display_name') or model_id,
                                        'capabilities': capabilities})
        return result

    async def plugin_settings(self, member, plugin_id):
        if plugin_id not in ('t8', 'huobao'):
            creative_plugin(plugin_id)
        catalog = await self.models(member, require_fresh=plugin_id == 'arcreel', plugin_id=plugin_id)
        bindings = self.governance.provider_bindings(plugin_id)
        saved = self.governance.get_creative_settings(plugin_id)
        result = {'configured': saved is not None,
                'models': {kind: [row['id'] for row in catalog[kind]] if saved is None else
                           [value for value in saved['models'][kind]
                            if any(row['id'] == value for row in catalog[kind])]
                           for kind in CREATIVE_KINDS},
                'parameters': saved['parameters'] if saved else {}}
        result.update(catalog=catalog, bindings=bindings)
        return result

    def provider(self, kind, model_id, plugin_id=None):
        route = resolve_provider(self.governance, kind, model_id, plugin_id)
        if route and route[2].get('protocol') == EXTERNAL_PROTOCOLS[kind][0]:
            return route[0], route[1]
        if not route and kind == 'tts' and model_id in OPENAI_SPEECH_MODELS:
            gateway = self.governance.gateway_settings(self.canvas.settings, bind=True)
            if self.canvas.local_openai(gateway) and gateway.gateway_api_key:
                return {'id': 'default-openai', 'baseUrl': OPENAI_ORIGIN + '/v1', 'apiKey': gateway.gateway_api_key}, model_id
        raise AuthError(503, f'{kind} 模型未配置或已停用，请联系管理员')

    async def external_request(self, provider, kind, payload):
        try:
            async with self.canvas.client('creative') as client:
                response = await client.post(provider['baseUrl'].rstrip('/') + EXTERNAL_PROTOCOLS[kind][1],
                    headers={'Authorization': 'Bearer ' + provider['apiKey'], 'Accept-Encoding': 'identity'},
                    json=payload)
        except httpx.TimeoutException as exc:
            raise AuthError(504, '服务商请求超时，未自动重新提交') from exc
        except httpx.HTTPError as exc:
            raise AuthError(502, '无法连接服务商，未自动重新提交') from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise AuthError(response.status_code if not response.is_success else 502,
                            f'服务商返回非 JSON 响应 (HTTP {response.status_code})') from exc
        if not response.is_success:
            raise AuthError(response.status_code, generation_error_text(data, status=response.status_code,
                                                                       secrets=(provider['apiKey'],)))
        if not isinstance(data, dict):
            raise AuthError(502, '服务商返回格式异常')
        return data

    async def embeddings(self, member, body, plugin_id=None):
        if not isinstance(body, dict) or set(body) - {'model', 'input', 'dimensions', 'encoding_format'}:
            raise AuthError(422, '向量请求参数无效')
        if not isinstance(body.get('input'), (str, list)) or not body['input']:
            raise AuthError(422, '请提供需要向量化的文本或 token 数组')
        if body.get('encoding_format', 'float') not in {'float', 'base64'}:
            raise AuthError(422, '向量编码格式无效')
        if 'dimensions' in body and (type(body['dimensions']) is not int or body['dimensions'] < 1):
            raise AuthError(422, '向量维度必须为正整数')
        provider, model = self.provider('embedding', body.get('model'), plugin_id)
        started = time.time()
        data = await self.external_request(provider, 'embedding', {**body, 'model': model})
        rows = data.get('data')
        if not isinstance(rows, list) or not rows or any(
                not isinstance(row, dict) or not isinstance(row.get('embedding'), (list, str))
                or type(row.get('index')) is not int for row in rows):
            raise AuthError(502, '服务商未返回有效向量结果')
        raw_usage = data.get('usage') if isinstance(data.get('usage'), dict) else {}
        usage = {key: value for key, value in raw_usage.items()
                 if key in {'prompt_tokens', 'total_tokens'} and type(value) is int}
        self.governance.record_usage(member_id=member.member_id, modality='embedding', model=body['model'],
            provider_type='external_provider', provider_id=provider['id'], source='creative',
            prompt_tokens=usage.get('prompt_tokens', 0), total_tokens=usage.get('total_tokens', 0),
            duration_ms=int((time.time() - started) * 1000))
        return {'object': 'list', 'model': body['model'], 'usage': usage,
                'data': [{'object': 'embedding', 'index': row['index'], 'embedding': row['embedding']} for row in rows]}

    async def rerank(self, member, body, plugin_id=None):
        if (not isinstance(body, dict) or set(body) - {'model', 'query', 'documents', 'top_n', 'max_tokens_per_doc'}
                or not isinstance(body.get('query'), str) or not body['query'].strip()
                or not isinstance(body.get('documents'), list) or not body['documents']
                or any(not isinstance(document, str) for document in body['documents'])):
            raise AuthError(422, '重排需要查询文本和文本数组')
        for field in ('top_n', 'max_tokens_per_doc'):
            if field in body and (type(body[field]) is not int or body[field] < 1):
                raise AuthError(422, f'{field} 必须为正整数')
        provider, model = self.provider('rerank', body.get('model'), plugin_id)
        started = time.time()
        data = await self.external_request(provider, 'rerank', {**body, 'model': model})
        rows = data.get('results')
        if not isinstance(rows, list) or any(not isinstance(row, dict)
                or type(row.get('index')) is not int or not 0 <= row['index'] < len(body['documents'])
                or not isinstance(row.get('relevance_score'), (int, float)) for row in rows):
            raise AuthError(502, '服务商未返回有效重排结果')
        self.governance.record_usage(member_id=member.member_id, modality='rerank', model=body['model'],
            provider_type='external_provider', provider_id=provider['id'], source='creative',
            duration_ms=int((time.time() - started) * 1000))
        return {'results': [{'index': row['index'], 'relevance_score': row['relevance_score']} for row in rows]}

    def audio_task(self, member, task_id):
        task = self.canvas.task(member, task_id)
        with self.canvas.lock:
            row = self.canvas.db.execute('SELECT * FROM creative_tasks WHERE task_id=?', (task_id,)).fetchone()
        if row is None:
            raise AuthError(404, '音频任务不存在')
        return task, dict(row)

    def set_audio_state(self, task_id, status, error=None, error_status=None):
        with self.canvas.lock:
            self.canvas.db.execute('UPDATE creative_tasks SET status=?,error=?,error_status=? WHERE task_id=?',
                                   (status, error, error_status, task_id))
            self.canvas.db.commit()

    async def submit_tts(self, member, body, submission, plugin_id=None):
        if not isinstance(body, dict) or set(body) - {'model', 'text', 'voice', 'speed', 'response_format'}:
            raise SubmissionRejected(422, '语音请求参数无效')
        if not isinstance(body.get('text'), str) or not 1 <= len(body['text'].strip()) <= 4096:
            raise SubmissionRejected(422, '语音文本长度须为 1–4096 字符')
        if not isinstance(body.get('voice', 'alloy'), str) or not body.get('voice', 'alloy').strip():
            raise SubmissionRejected(422, '语音音色无效')
        if (type(body.get('speed', 1)) not in {int, float} or not 0.25 <= body.get('speed', 1) <= 4):
            raise SubmissionRejected(422, '语速须在 0.25–4 之间')
        audio_format = body.get('response_format', 'mp3')
        if audio_format not in {'mp3', 'wav', 'flac', 'opus'}:
            raise SubmissionRejected(422, '托管语音支持 mp3、wav、flac、opus 格式')
        submission = 'tts:' + (submission or str(uuid.uuid4()))
        async with self.submission_lock:
            with self.canvas.lock:
                existing = self.canvas.db.execute(
                    'SELECT id FROM tasks WHERE member=? AND tenant=? AND actor=? AND submission=?',
                    (member.member_id, member.tenant_id, member.user_id, submission)).fetchone()
            if existing:
                return await self.poll_audio(member, existing['id'])
            try:
                provider, model = self.provider('tts', body.get('model'), plugin_id)
            except AuthError as error:
                raise SubmissionRejected(error.status, error.message) from error
            task_id = 'creative_' + uuid.uuid4().hex
            payload = {'model': model, 'input': body['text'], 'voice': body.get('voice', 'alloy'),
                       'speed': body.get('speed', 1), 'response_format': audio_format, 'stream_format': 'audio'}
            with self.canvas.lock:
                self.canvas.db.execute('INSERT INTO tasks (id,member,tenant,actor,kind,submission) VALUES (?,?,?,?,?,?)',
                    (task_id, member.member_id, member.tenant_id, member.user_id, 'tts', submission))
                self.canvas.db.execute('INSERT INTO task_usage (task_id,model,parameters,started,source) VALUES (?,?,?,?,?)',
                    (task_id, body['model'], json.dumps({key: payload[key] for key in ('voice', 'speed', 'response_format')}),
                     time.time(), 'creative'))
                self.canvas.db.execute('INSERT INTO creative_tasks (task_id,provider_id,payload,status,format,provider_origin) VALUES (?,?,?,?,?,?)',
                    (task_id, provider['id'], json.dumps(payload), 'pending', audio_format, provider['baseUrl']))
                self.canvas.db.commit()
            self.start_speech(member, task_id, provider)
        return {'taskId': task_id, 'kind': 'tts', 'status': 'pending', 'outputs': []}

    def start_speech(self, member, task_id, provider):
        if task_id not in self.workers:
            worker = asyncio.create_task(self.generate_speech(member, task_id, provider))
            self.workers[task_id] = worker
            worker.add_done_callback(lambda done: self.workers.pop(task_id, None))

    async def generate_speech(self, member, task_id, provider):
        _, row = self.audio_task(member, task_id)
        output = self.audio_root / (task_id + '.' + row['format'])
        partial = output.with_suffix(output.suffix + '.part')
        with self.canvas.lock, self.canvas.db:
            claimed = self.canvas.db.execute("UPDATE creative_tasks SET status='running' WHERE task_id=? AND status='pending'",
                                             (task_id,)).rowcount
        if not claimed:
            return
        try:
            async with self.canvas.client('creative') as client:
                async with client.stream('POST', provider['baseUrl'].rstrip('/') + '/audio/speech',
                        headers={'Authorization': 'Bearer ' + provider['apiKey'], 'Accept-Encoding': 'identity'},
                        json=json.loads(row['payload'])) as response:
                    if not response.is_success:
                        raw = await response.aread()
                        raise AuthError(response.status_code, generation_error_text(raw.decode('utf-8', errors='replace'),
                            status=response.status_code, secrets=(provider['apiKey'],)))
                    if 'json' in response.headers.get('content-type', ''):
                        raw = await response.aread()
                        raise AuthError(502, generation_error_text(raw.decode('utf-8', errors='replace'),
                            status=response.status_code, secrets=(provider['apiKey'],)))
                    size = 0
                    with partial.open('wb') as target:
                        async for chunk in response.aiter_bytes(65536):
                            size += len(chunk)
                            if size > 512 * 1024 * 1024:
                                raise AuthError(413, '语音产物超出 512 MiB 上传限制')
                            target.write(chunk)
                    if not size:
                        raise AuthError(502, '服务商未返回语音文件')
                    partial.replace(output)
            self.set_audio_state(task_id, 'generated')
        except asyncio.CancelledError:
            # Never replay a synchronous provider request after an uncertain response.
            self.set_audio_state(task_id, 'interrupted', '语音请求已发出但结果未完整接收，未自动重新提交')
            raise
        except (AuthError, httpx.HTTPError, OSError) as exc:
            message = exc.message if isinstance(exc, AuthError) else '语音服务请求超时，未自动重新提交' if isinstance(exc, httpx.TimeoutException) else '语音文件接收未完成，未自动重新提交'
            self.set_audio_state(task_id, 'failed', message, exc.status if isinstance(exc, AuthError) else 504 if isinstance(exc, httpx.TimeoutException) else 502)
        finally:
            partial.unlink(missing_ok=True)

    async def poll_audio(self, member, task_id):
        task, row = self.audio_task(member, task_id)
        output = self.audio_root / (task_id + '.' + row['format'])
        if row['status'] == 'pending':
            if row['provider_id'] == 'default-openai':
                provider, _ = self.provider('tts', json.loads(row['payload'])['model'])
            else:
                provider = self.governance.get_provider(row['provider_id'], include_key=True, include_retired=True)
                if provider is None:
                    raise AuthError(503, '语音任务的原供应商资料不可用')
            if row['provider_origin'] and row['provider_origin'] != provider['baseUrl']:
                raise AuthError(503, '语音任务原供应商的连接地址已变更')
            self.start_speech(member, task_id, provider)
        elif row['status'] == 'running' and task_id not in self.workers:
            if output.is_file():
                self.set_audio_state(task_id, 'generated')
            else:
                self.set_audio_state(task_id, 'interrupted', '语音请求已发出但结果未完整接收，未自动重新提交')
                output.with_suffix(output.suffix + '.part').unlink(missing_ok=True)
        task, row = self.audio_task(member, task_id)
        if row['status'] == 'generated':
            async with self.archive_lock:
                task, row = self.audio_task(member, task_id)
                if row['status'] == 'generated':
                    async def chunks():
                        with output.open('rb') as source:
                            while chunk := source.read(256 * 1024):
                                yield chunk
                    mime = {'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'flac': 'audio/flac', 'opus': 'audio/ogg'}[row['format']]
                    metadata = await self.canvas.media.upload_runtime(member, chunks(), filename=output.name,
                        size=output.stat().st_size, asset_type='audio', mime=mime)
                    with self.canvas.lock:
                        self.canvas.db.execute('UPDATE tasks SET outputs=? WHERE id=?', (json.dumps([metadata['fileUrl']]), task_id))
                        self.canvas.db.execute("UPDATE creative_tasks SET status='succeeded' WHERE task_id=?", (task_id,))
                        self.canvas.db.commit()
                    output.unlink(missing_ok=True)
            task, row = self.audio_task(member, task_id)
        outputs = []
        for url in json.loads(task['outputs']):
            asset_id = url.removeprefix('/api/media/')
            metadata = self.canvas.media.store.get(asset_id)
            if metadata['owner_id'] != member.member_id:
                raise AuthError(403, '语音产物不属于当前成员')
            outputs.append({'assetId': asset_id, 'url': url, 'mimeType': metadata['mime']})
        if row['status'] in {'succeeded', 'failed', 'interrupted'}:
            with self.canvas.lock:
                usage = self.canvas.db.execute('SELECT * FROM task_usage WHERE task_id=?', (task_id,)).fetchone()
            self.governance.record_usage(log_id='creative_' + task_id, member_id=member.member_id, modality='tts',
                model=usage['model'], provider_type='external_provider', provider_id=row['provider_id'], source='creative',
                parameters=json.loads(usage['parameters']), duration_ms=int((time.time() - usage['started']) * 1000),
                status='success' if row['status'] == 'succeeded' else row['status'])
        return {'taskId': task_id, 'kind': 'tts', 'status': 'failed' if row['status'] == 'interrupted' else
                'running' if row['status'] == 'generated' else row['status'],
                'progress': 100 if row['status'] == 'succeeded' else 0, 'outputs': outputs,
                'error': row['error'], 'httpStatus': row['error_status']}

    async def submit_music(self, member, body, submission):
        if (not isinstance(body, dict) or set(body) - {'model', 'prompt', 'duration', 'instrumental'}
                or not isinstance(body.get('prompt'), str) or not body['prompt'].strip()):
            raise SubmissionRejected(422, '音乐生成请求参数无效')
        async with self.submission_lock:
            submission = 'music:' + (submission or str(uuid.uuid4()))
            with self.canvas.lock:
                existing = self.canvas.db.execute('SELECT id FROM tasks WHERE member=? AND tenant=? AND actor=? AND submission=?',
                    (member.member_id, member.tenant_id, member.user_id, submission)).fetchone()
            if existing:
                return {'taskId': existing['id'], 'kind': 'music', 'status': 'pending'}
            try:
                options = (await self.models(member))['music']
                if not any(row['id'] == body.get('model') for row in options):
                    raise AuthError(503, '平台尚未配置已核实支持文本生成音乐的模型，请联系管理员')
            except AuthError as error:
                raise SubmissionRejected(error.status, error.message) from error
            payload = {'model': body['model'], 'text_prompt': body['prompt']}
            payload.update({key: body[key] for key in ('duration', 'instrumental') if key in body})
            data = await self.canvas.call(member, 'POST', '/v1/audio/generate', payload=payload, submission=submission)
            task_id = data.get('task_id')
            if not isinstance(task_id, str) or not task_id:
                raise AuthError(502, '平台未返回音乐生成任务编号')
            with self.canvas.lock:
                self.canvas.db.execute('INSERT OR IGNORE INTO tasks (id,member,tenant,actor,kind,submission) VALUES (?,?,?,?,?,?)',
                    (task_id, member.member_id, member.tenant_id, member.user_id, 'music', submission))
                self.canvas.db.execute('INSERT OR IGNORE INTO task_usage (task_id,model,parameters,started,source) VALUES (?,?,?,?,?)',
                    (task_id, body['model'], json.dumps({key: body[key] for key in ('duration', 'instrumental') if key in body}), time.time(), 'creative'))
                self.canvas.db.commit()
            return {'taskId': task_id, 'kind': 'music', 'status': 'pending'}

    async def close(self):
        workers = list(self.workers.values())
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
