import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.creative.creative import CreativeService
from app.governance.provider_routing import resolve_provider
from app.identity.auth import AuthError, MemberSession
from app.main import create_app
from app.core.config import load_settings
from app.identity.standalone import STANDALONE_MEMBER_ID

TOKEN = 'standalone-fixture-token'
MEMBER = STANDALONE_MEMBER_ID


def _settings(tmp_path):
    from unittest.mock import patch
    with patch.dict('os.environ', {
        'APP_ENV': 'development',
        'GREENROOM_LOCAL_BOOTSTRAP_TOKEN': TOKEN,
        'DATA_DIR': str(tmp_path),
        'PUBLIC_BASE_URL': 'https://greenroom.localhost:19443',
    }, clear=True):
        return load_settings()


def _login(client):
    assert client.post('/api/auth/refresh', headers={
        'Origin': str(client.base_url).rstrip('/'),
        'X-Greenroom-Local-Bootstrap': TOKEN,
    }).status_code == 200


class CanvasGateway:
    def handler(self, request):
        return httpx.Response(200, json={'data': []})


def add_provider(store, host, scope):
    return store.create_provider(name=host, base_url=f'https://{host}.test/v1',
        api_key=f'secret-only-{host}', model_prefix='', plugin_ids=scope, models=[
            {'id': 'same-text-id', 'modality': 'llm', 'protocol': 'openai-responses',
             'profile': {'reasoningLevels': ['low', 'high'], 'defaultReasoning': 'high'}},
            {'id': 'same-image-id', 'modality': 'image', 'protocol': 'openai-images'},
            {'id': 'same-voice-id', 'modality': 'tts', 'protocol': 'openai-speech'},
        ])


def test_provider_scopes_and_independent_plugin_bindings(tmp_path):
    fake = CanvasGateway()
    settings = replace(_settings(tmp_path), gateway_api_key='test-only')
    app = create_app(settings, transport=httpx.MockTransport(fake.handler))
    with TestClient(app, base_url=settings.origin) as client:
        _login(client)
        origin = {'Origin': settings.origin}
        store = app.state.canvas.governance
        shared = add_provider(store, 'shared', None)
        restricted = add_provider(store, 'studio', ['take-one'])
        chosen = {'llm': shared['id'], 'image': restricted['id'], 'tts': restricted['id']}
        url = '/api/admin/creative-plugins/take-one/providers'
        assert client.put(url, headers=origin, json=chosen).status_code == 200
        catalog = client.get('/api/admin/creative-plugins').json()['data']
        assert next(item['bindings'] for item in catalog['plugins'] if item['id'] == 'take-one') == chosen
        assert not any('secret-only-' in item['apiKey'] for item in catalog['providers'])
        shared_alias = shared['modelPrefix'] + 'same-text-id'
        image_alias = restricted['modelPrefix'] + 'same-image-id'
        assert resolve_provider(store, 'llm', shared_alias, 'take-one')[1] == 'same-text-id'
        assert resolve_provider(store, 'image', image_alias, 'take-one')[0]['id'] == restricted['id']
        with pytest.raises(AuthError, match='无权'):
            resolve_provider(store, 'image', image_alias)
        with pytest.raises(AuthError, match='无权'):
            resolve_provider(store, 'image', image_alias, 'hypit')
        assert client.put('/api/admin/creative-plugins/manjuforge/providers',
                          headers=origin, json={'image': restricted['id']}).status_code == 422
        assert client.put(url, headers=origin, json={}).status_code == 200
        assert resolve_provider(store, 'image', 'fixture-image', 'take-one') is None


@pytest.mark.asyncio
async def test_image_and_speech_continue_on_original_provider(tmp_path):
    fake = CanvasGateway()
    changed = asyncio.Event()
    requests = []

    async def upstream(request):
        if request.url.host in {'first.test', 'second.test'}:
            payload = json.loads(request.content)
            requests.append((request.url.host, request.url.path, request.headers['Authorization'], payload))
            await changed.wait()
            if request.url.path.endswith('/audio/speech'):
                return httpx.Response(200, content=b'test speech fixture', headers={'Content-Type': 'audio/mpeg'})
            return httpx.Response(200, json={'data': [{'b64_json': 'aW1hZ2UgZml4dHVyZQ=='}]})
        return fake.handler(request)

    settings = replace(_settings(tmp_path), gateway_api_key='test-only')
    app = create_app(settings, transport=httpx.MockTransport(upstream))
    canvas = app.state.canvas
    store = canvas.governance
    creative = CreativeService(canvas)
    member = MemberSession(MEMBER, MEMBER, '', MEMBER, 'member-token', 'session')
    first = add_provider(store, 'first', ['take-one'])
    second = add_provider(store, 'second', None)
    store.save_provider_bindings('take-one', {'image': first['id'], 'tts': first['id']})
    body = {'model': first['modelPrefix'] + 'same-image-id', 'prompt': 'fixture',
            'size': '1024x1024', 'quality': 'medium', 'complexity': 'high'}
    image = await canvas.submit(member, 'image', body, 'one-image', plugin_id='take-one')
    voice = await creative.submit_tts(member, {'model': first['modelPrefix'] + 'same-voice-id',
                                               'text': 'fixture'}, 'one-voice', 'take-one')
    image_worker, = canvas._openai_image_jobs
    audio_worker = creative.workers[voice['taskId']]
    store.save_provider_bindings('take-one', {'image': second['id'], 'tts': second['id']})
    store.delete_provider(first['id'])
    assert await canvas.submit(member, 'image', body, 'one-image', plugin_id='take-one') == image
    changed.set()
    await asyncio.gather(image_worker, audio_worker)
    assert {(host, path, key) for host, path, key, _ in requests} == {
        ('first.test', '/v1/images/generations', 'Bearer secret-only-first'),
        ('first.test', '/v1/audio/speech', 'Bearer secret-only-first'),
    }
    assert len(requests) == 2
    image_payload = next(payload for _, path, _, payload in requests if 'images' in path)
    assert image_payload['model'] == 'same-image-id'
    assert (image_payload['size'], image_payload['quality'], image_payload['complexity']) == ('1024x1024', 'medium', 'high')
    assert canvas.db.execute('SELECT state FROM local_openai_images WHERE task_id=?', (image,)).fetchone()['state'] == 'received'
    assert creative.audio_task(member, voice['taskId'])[1]['status'] == 'generated'


@pytest.mark.asyncio
async def test_responses_provider_uses_selected_reasoning_and_plugin_scope(tmp_path, monkeypatch):
    import aiohttp
    from aiohttp import web
    from aiohttp.test_utils import TestServer
    from app.governance.governance_store import GovernanceStore
    from app.integrations import model_relay

    member = MemberSession(MEMBER, MEMBER, '', MEMBER, 'member-token', 'session')
    monkeypatch.setattr(model_relay, 'peer_member', lambda request: member.member_id)

    class Session:
        def resolve(self, grant, **kwargs):
            return member.access_token, member.member_id

    class Auth:
        async def verify(self, token):
            return member

    responses = []
    async def fixture(request):
        responses.append((request.headers['Authorization'], await request.json()))
        return web.json_response({'id': 'local-fixture', 'status': 'completed',
            'output': [{'content': [{'type': 'output_text', 'text': 'fixture reply'}]}]})

    upstream = web.Application()
    upstream.router.add_post('/v1/responses', fixture)
    store = GovernanceStore(tmp_path / 'provider-governance.sqlite3')
    async with TestServer(upstream) as server:
        saved = store.create_provider(name='local fixture', base_url=str(server.make_url('/v1')),
            api_key='private-test-text', model_prefix='', plugin_ids=['take-one'], models=[
                {'id': 'one-text-id', 'protocol': 'openai-responses',
                 'profile': {'reasoningLevels': ['low', 'high'], 'reasoningMap': {'high': 'provider-high'}}},
            ])
        alias = saved['modelPrefix'] + 'one-text-id'
        store.save_provider_bindings('take-one', {'llm': saved['id']})
        settings = replace(_settings(tmp_path), member_sleep_enabled=False)
        app = model_relay.create_relay(settings, auth=Auth(), sessions=Session(), governance=store)
        async with TestServer(app) as broker, aiohttp.ClientSession() as client:
            body = {'model': alias, 'messages': [{'role': 'user', 'content': 'fixture'}], 'reasoning_effort': 'high'}
            for headers in ({}, {'X-Greenroom-Plugin': 'manjuforge'}):
                async with client.post(broker.make_url('/v1/chat/completions'), json=body, headers=headers) as denied:
                    assert denied.status == 403
            async with client.post(broker.make_url('/v1/chat/completions'), json=body,
                                   headers={'X-Greenroom-Plugin': 'take-one'}) as allowed:
                assert allowed.status == 200
                assert (await allowed.json())['choices'][0]['message']['content'] == 'fixture reply'
        assert len(responses) == 1
        key, payload = responses[0]
        assert key == 'Bearer private-test-text'
        assert payload['model'] == 'one-text-id'
        assert payload['reasoning'] == {'effort': 'provider-high'}


@pytest.mark.asyncio
async def test_default_gateway_normalizes_luna_plugin_chat_only_for_official_openai(tmp_path, monkeypatch):
    import aiohttp
    from aiohttp import web
    from aiohttp.test_utils import TestServer
    from app.integrations import model_relay

    member = MemberSession(MEMBER, MEMBER, '', MEMBER, 'member-token', 'session')
    monkeypatch.setattr(model_relay, 'peer_member', lambda request: member.member_id)

    class Session:
        def resolve(self, grant, **kwargs):
            return member.access_token, member.member_id

    class Auth:
        async def verify(self, token):
            return member

    async def resolve_model(canvas, identity, kind, model):
        assert (identity, kind, model) == (member, 'llm', 'gpt-6-luna')
        return model

    monkeypatch.setattr(model_relay.CanvasService, 'resolve_submission_model', resolve_model)
    forwarded = []

    async def fixture(request):
        forwarded.append(await request.json())
        return web.json_response({'choices': [{'message': {'content': 'fixture'}}]})

    upstream = web.Application()
    upstream.router.add_post('/v1/chat/completions', fixture)
    async with TestServer(upstream) as server:
        settings = replace(_settings(tmp_path), gateway_service_url=str(server.make_url('')).rstrip('/'),
                           gateway_api_key='test-only', member_sleep_enabled=False)
        app = model_relay.create_relay(settings, auth=Auth(), sessions=Session())
        async with TestServer(app) as broker, aiohttp.ClientSession() as client:
            body = {'model': 'gpt-6-luna', 'messages': [{'role': 'user', 'content': 'fixture'}],
                    'thinking': {'type': 'disabled'}, 'enable_thinking': False, 'max_tokens': 512}
            for official in (True, False):
                monkeypatch.setattr(model_relay.CanvasService, 'local_openai', lambda canvas, gateway: official)
                async with client.post(broker.make_url('/v1/chat/completions'), json=body,
                                       headers={'X-Greenroom-Plugin': 'huobao'}) as response:
                    assert response.status == 200
                    assert (await response.json())['choices'][0]['message']['content'] == 'fixture'

    official, compatible = forwarded
    assert official == {'model': 'gpt-6-luna', 'messages': body['messages'],
                        'max_completion_tokens': 512, 'reasoning_effort': 'none'}
    assert compatible == {**body, 'reasoning_effort': 'none'}


@pytest.mark.asyncio
async def test_default_image_preset_and_status_survive_restart(tmp_path):
    member = MemberSession(MEMBER, MEMBER, '', MEMBER, 'member-token', 'session')
    settings = replace(_settings(tmp_path), asset_service_url='http://asset:18081',
                       local_asset=True, asset_tenant_id=MEMBER, staging_asset_token='x' * 32,
                       gateway_service_url='https://api.openai.com', gateway_api_key='fixture-key')
    calls = []

    async def upstream(request):
        payload = json.loads(request.content)
        calls.append((request.url.host, request.url.path, payload))
        if payload['prompt'] == 'rejected':
            return httpx.Response(400, json={'error': {'message': 'bad input fixture-key'}})
        return httpx.Response(200, json={'data': [{'b64_json': 'aW1hZ2UgZml4dHVyZQ=='}]})

    app = create_app(settings, transport=httpx.MockTransport(upstream))
    canvas = app.state.canvas
    provider = {'id': None, 'baseUrl': 'https://api.openai.com/v1', 'apiKey': 'fixture-key'}
    model = 'gpt-image-2.6-flare'
    good = canvas.submit_openai_image(member, {'model': model, 'prompt': 'fixture', 'num_images': 1},
                                     'valid-fixture', 't8', provider, profile=None, model_alias=model)
    rejected = canvas.submit_openai_image(member, {'model': model, 'prompt': 'rejected', 'num_images': 1},
                                         'rejected-fixture', 't8', provider, profile=None, model_alias=model)
    await asyncio.gather(*canvas._openai_image_jobs)
    assert len(calls) == 2
    for host, path, payload in calls:
        assert (host, path) == ('api.openai.com', '/v1/images/generations')
        assert (payload['model'], payload['size'], payload['quality']) == (model, '1024x1024', 'low')

    reopened = create_app(settings).state.canvas

    async def fake_archive(identity, data, **kwargs):
        assert identity == member and kwargs['operation_id'] == good
        assert b''.join([chunk async for chunk in data]) == b'image fixture'
        return {'fileUrl': '/api/media/image-fixture'}

    reopened.media.upload_runtime = fake_archive
    assert (await reopened.poll(member, good))['urls'] == ['/api/media/image-fixture']
    failure = await reopened.poll(member, rejected)
    assert failure['status'] == 'failed'
    assert 'fixture-key' not in failure['error']
    assert len(calls) == 2


def test_current_key_catalog_is_grouped_and_masked(tmp_path):
    models = ['gpt-6-luna', 'gpt-image-2.6-flare', 'gpt-4o-mini-tts',
              'text-embedding-3-small', 'omni-moderation-latest']

    def upstream(request):
        assert request.url.host == 'api.openai.com' and request.url.path == '/v1/models'
        return httpx.Response(200, json={'data': [{'id': model} for model in models]})

    settings = replace(_settings(tmp_path), gateway_service_url='https://api.openai.com',
                       gateway_api_key='fixture-key')
    app = create_app(settings, transport=httpx.MockTransport(upstream))
    with TestClient(app, base_url=settings.origin) as client:
        _login(client)
        response = client.get('/api/admin/api-catalog')
        assert response.status_code == 200 and 'fixture-key' not in response.text
        directory = response.json()['data']['directory']
        assert directory is not None
        for model in models:
            assert model in json.dumps(directory)
