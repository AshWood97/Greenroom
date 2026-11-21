"""ViMax generator contract backed by member-scoped Greenroom tasks."""
import asyncio
import base64
import contextvars
import json
import mimetypes
import os
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlsplit

import aiohttp
import httpx
from PIL import Image
from interfaces import ImageOutput, VideoOutput

current_job = contextvars.ContextVar('greenroom_job')
managed_url = os.environ.get('GREENROOM_MANAGED_URL', 'http://127.0.0.1:18767/managed').rstrip('/')
broker_url = os.environ.get('GREENROOM_BROKER_URL', 'http://127.0.0.1:3081').rstrip('/')


def managed_defaults(kind):
    job = current_job.get(None)
    return job['record'].get('parameters', {}).get(kind, {}) if job else {}


class TextSubmissionUnknown(RuntimeError):
    pass


def text_unknown(record):
    return any(step.get('state') != 'completed' for step in record.get('textRequests', []))


def text_intent(request):
    job = current_job.get()
    if job.get('textBlocked'):
        raise TextSubmissionUnknown('本任务有未知文本请求，禁止自动提交后续文本')
    # Exact request contents, not an invented provider retrieval key. Never store credentials.
    body = json.loads(request.content)
    if body.get('stream'):
        raise RuntimeError('ViMax 托管文本仅支持完整非流式响应')
    identity = {'url': str(request.url), 'body': body}
    steps = job['record'].setdefault('textRequests', [])
    step = next((item for item in steps if item['request'] == identity), None)
    if step is not None:
        if step['state'] != 'completed':
            raise TextSubmissionUnknown('文本请求受理状态未知，保留原任务，禁止自动重发')
        return job, step, httpx.Response(200, headers=step.get('headers', {}),
                                       content=step['response'].encode(), request=request)
    step = {'request': identity, 'state': 'unknown'}
    steps.append(step)
    job['save']()  # Crash from this point onward must never cause another POST.
    return job, step, None


def text_headers(job, step, response):
    step['httpStatus'] = response.status_code
    request_id = response.headers.get('x-request-id')
    if request_id:
        step['requestId'] = request_id
    job['save']()


def text_complete(job, step, response):
    # Only a full JSON success can be replayed. Error/partial bodies are not retry permission.
    if response.is_success:
        value = response.json()
        endpoint = urlsplit(step['request']['url']).path.rstrip('/').rsplit('/', 1)[-1]
        valid = isinstance(value, dict) and isinstance(value.get('choices'), list) and bool(value['choices'])
        if endpoint == 'embeddings':
            rows = value.get('data') if isinstance(value, dict) else None
            valid = isinstance(rows, list) and bool(rows) and all(
                isinstance(row, dict) and isinstance(row.get('embedding'), (list, str)) and row['embedding'] for row in rows)
        elif endpoint == 'rerank':
            rows = value.get('results') if isinstance(value, dict) else None
            count = len(step['request']['body']['documents'])
            valid = isinstance(rows, list) and all(isinstance(row, dict)
                and type(row.get('index')) is int and 0 <= row['index'] < count
                and isinstance(row.get('relevance_score'), (int, float)) for row in rows)
        if valid:
            step.update(state='completed', response=response.text,
                        headers={key: response.headers[key] for key in ('content-type', 'x-request-id')
                                 if key in response.headers})
            job['save']()
    if step['state'] != 'completed':
        raise TextSubmissionUnknown('文本响应未完整确认，保留原任务，禁止自动重发')


class ManagedTextClient(httpx.Client):
    def send(self, request, **kwargs):
        job, step, cached = text_intent(request)
        if cached is not None:
            return cached
        kwargs['stream'] = True
        response = None
        try:
            response = super().send(request, **kwargs)
            text_headers(job, step, response)
            response.read()
            text_complete(job, step, response)
            return response
        except BaseException:
            job['textBlocked'] = True
            raise
        finally:
            if response is not None:
                response.close()


class ManagedAsyncTextClient(httpx.AsyncClient):
    async def send(self, request, **kwargs):
        job, step, cached = text_intent(request)
        if cached is not None:
            return cached
        kwargs['stream'] = True
        response = None
        try:
            response = await super().send(request, **kwargs)
            text_headers(job, step, response)
            await response.aread()
            text_complete(job, step, response)
            return response
        except BaseException:
            job['textBlocked'] = True
            raise
        finally:
            if response is not None:
                await response.aclose()


def managed_chat_model(**kwargs):
    from langchain.chat_models import init_chat_model
    defaults = managed_defaults('llm')
    if 'max_tokens' in defaults:
        kwargs.pop('max_completion_tokens', None)
    kwargs.update(defaults)
    kwargs.update(model=os.environ['VIMAX_LLM_MODEL'], model_provider='openai',
                  api_key='greenroom-managed', base_url=broker_url + '/v1', max_retries=0,
                  http_client=ManagedTextClient(), http_async_client=ManagedAsyncTextClient())
    return init_chat_model(**kwargs)


def managed_embeddings(**kwargs):
    from langchain_openai import OpenAIEmbeddings
    return OpenAIEmbeddings(**{**managed_defaults('embedding'), **kwargs,
        'model': os.environ['VIMAX_EMBEDDING_MODEL'], 'api_key': 'greenroom-managed',
        'base_url': managed_url, 'max_retries': 0,
        'http_client': ManagedTextClient(), 'http_async_client': ManagedAsyncTextClient()})


async def request(path, body=None, headers=None):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300)) as client:
        async with client.request('POST' if body is not None else 'GET', managed_url + path,
                                  json=body, headers=headers) as response:
            value = await response.json(content_type=None)
            if response.status >= 400 or value.get('success') is False:
                error = value.get('error') or value.get('message') or f'HTTP {response.status}'
                raise RuntimeError(error.get('message', str(error)) if isinstance(error, dict) else str(error))
            return value.get('data', value)


async def select_model(kind):
    job = current_job.get(None)
    if job and job['record'].get('models', {}).get(kind):
        return job['record']['models'][kind]
    settings = await request('/plugins/vimax/settings')
    catalog = await request('/models')
    models = catalog.get(kind, [])
    if settings.get('configured'):
        permitted = settings.get('models', {}).get(kind, [])
        models = [model for chosen in permitted for model in models if (model.get('id') if isinstance(model, dict) else model) == chosen]
    if not models:
        raise RuntimeError(f'管理员尚未启用 {kind} 模型')
    chosen = models[0]['id'] if isinstance(models[0], dict) else models[0]
    if job:
        job['record'].setdefault('models', {})[kind] = chosen
        job['record'].setdefault('parameters', {})[kind] = settings.get('parameters', {}).get(kind, {})
        job['save']()
    return chosen


def image_data(value):
    if isinstance(value, Image.Image):
        from io import BytesIO
        buffer = BytesIO()
        value.save(buffer, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()
    path = Path(value)
    return 'data:' + (mimetypes.guess_type(str(path))[0] or 'image/png') + ';base64,' + base64.b64encode(path.read_bytes()).decode()


async def generate(kind, prompt, references, aspect_ratio, kwargs):
    from greenroom.final_media import guard_write
    guard_write()
    job = current_job.get()
    # Original artifact keys and reference paths identify the same operation
    # across native retry loops and process restarts.
    steps = job['record'].setdefault('generations', [])
    reference_paths = [str(value) for value in references]
    identity = (kind, prompt, aspect_ratio, str(kwargs.get('greenroom_key') or ''), reference_paths)
    step = next((value for value in steps if (value['kind'], value['prompt'], value['aspectRatio'], value.get('key', ''), value.get('references', [])) == identity), None)
    if step is None:
        step = {'kind': kind, 'prompt': prompt, 'aspectRatio': aspect_ratio, 'key': identity[3], 'references': reference_paths, 'submissionId': 'vimax:' + str(uuid4())}
        steps.append(step)
        job['save']()
    if step.get('output'):
        return await read_generated_asset(kind, step['output'])
    if not step.get('taskId'):
        chosen = await select_model(kind)
        body = {**job['record'].get('parameters', {}).get(kind, {}), 'model': chosen, 'prompt': prompt, 'aspect_ratio': aspect_ratio}
        if kind == 'image' and 'quality' in body:
            body['providerParams'] = {'quality': body.pop('quality')}
        if kwargs.get('size'):
            body['size'] = kwargs['size']
        if references:
            body['reference_images' if kind == 'image' else 'reference_image_urls'] = [image_data(v) for v in references]
        if kind == 'video':
            for field in ('duration', 'resolution', 'seed', 'generate_audio'):
                if kwargs.get(field) is not None:
                    body[field] = kwargs[field]
        result = await request('/' + kind + '/submit', body, {'X-T8-Provider-Submission': step['submissionId']})
        step['taskId'] = result['taskId']
        job['save']()
    last_error = None
    for _ in range(720):
        try:
            result = await request('/tasks/' + step['taskId'])
            if result['status'] in ('failed', 'cancelled'):
                error = result.get('error') or '服务商未返回具体失败原因'
                raise GenerationFailed(error.get('message', str(error)) if isinstance(error, dict) else str(error))
            if result['status'] == 'succeeded':
                output = next((v for v in result.get('outputs', []) if v.get('mimeType', '').startswith(kind + '/')), None)
                if not output:
                    raise GenerationFailed('平台未返回生成产物')
                step['output'] = output
                job['save']()
                return await read_generated_asset(kind, output)
            last_error = None
        except GenerationFailed:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError) as error:
            if step.get('output'):
                raise  # Archived intermediate is authoritative; never re-query/re-submit it.
            last_error = str(error)
            step['queryError'] = last_error
            job['save']()
        await asyncio.sleep(5)
    raise RuntimeError('任务查询达到上限，保留原任务编号 ' + step['taskId'] + '：' + (last_error or '生成仍在进行'))


async def read_generated_asset(kind, output):
    # The original managed generation already archived this intermediate. Recovery
    # reads its member Asset directly, never a provider URL or a new generation.
    from greenroom.final_media import asset_url, guard_write, MEDIA_MAX_BYTES
    url = asset_url(output.get('assetId'))
    if output.get('url') != url or not output.get('mimeType', '').startswith(kind + '/'):
        raise GenerationFailed('原生成产物缺少成员 Asset 绑定，保留原任务，不重新生成')
    async with aiohttp.ClientSession() as client:
        async with client.get(broker_url + url, allow_redirects=False) as response:
            response.raise_for_status()
            if response.status != 200 or not response.headers.get('Content-Type', '').startswith(kind + '/'):
                raise GenerationFailed('原成员 Asset 返回类型无效，保留原任务')
            guard_write(response.content_length or 0)
            content = bytearray()
            async for chunk in response.content.iter_chunked(1024 * 1024):
                if len(content) + len(chunk) > MEDIA_MAX_BYTES:
                    raise GenerationFailed('原成员 Asset 超出已有媒体大小限制')
                content.extend(chunk)
            if not content:
                raise GenerationFailed('原成员 Asset 为空，保留原任务')
            return bytes(content)


class GenerationFailed(RuntimeError):
    pass


class ManagedImageGenerator:
    async def generate_single_image(self, prompt, reference_image_paths=None, aspect_ratio='16:9', **kwargs):
        data = await generate('image', prompt, reference_image_paths or [], aspect_ratio, kwargs)
        from io import BytesIO
        return ImageOutput(fmt='pil', ext='png', data=Image.open(BytesIO(data)).copy())


class ManagedVideoGenerator:
    async def generate_single_video(self, prompt='', reference_image_paths=None, aspect_ratio='16:9', **kwargs):
        data = await generate('video', prompt, reference_image_paths or [], aspect_ratio, kwargs)
        return VideoOutput(fmt='bytes', ext='mp4', data=data)
