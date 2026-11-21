"""Provider scope and model resolution shared by DSH and plugin entry points."""

from app.identity.auth import AuthError

BINDABLE = ('llm', 'image', 'tts')
TEXT_PROTOCOLS = ('openai-completions', 'openai-responses')
IMAGE_QUALITIES = ('low', 'medium', 'high', 'xhigh', 'max', 'auto')
IMAGE_COMPLEXITIES = ('low', 'medium', 'high')
IMAGE_SIZES = ('512x512', '1024x1024', '1536x1024', '1024x1536', '2048x2048')
REASONING_LEVELS = ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
LUNA_PROFILE = {
    'contextWindow': 1050000, 'maxTokens': 128000, 'input': ['text', 'image'],
    'reasoningLevels': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'defaultReasoning': 'none',
}


def provider_allows(provider, plugin_id):
    return provider['isActive'] and (provider['pluginIds'] is None or plugin_id in provider['pluginIds'])


def model_alias(provider, model):
    prefix, model_id = provider['modelPrefix'], model['id']
    if not prefix and model.get('modality', 'llm') in ('llm', 'image'):
        return provider['id'] + '/' + model_id
    return model_id if model_id.startswith(prefix) else prefix + model_id


def provider_models(store, kind, plugin_id=None, *, management=False):
    bound = store.provider_bindings(plugin_id).get(kind)
    for provider in store.list_providers(include_key=False):
        if not provider['isActive'] or (not management and (
                not provider_allows(provider, plugin_id) or (bound and bound != provider['id']))):
            continue
        for model in provider['models']:
            if model.get('modality', 'llm') == kind and (kind != 'image' or model.get('protocol') == 'openai-images'):
                yield provider, model


def resolve_provider(store, kind, requested, plugin_id=None):
    bound = store.provider_bindings(plugin_id).get(kind)
    for provider in store.list_providers(include_key=True):
        for model in provider['models']:
            if model.get('modality', 'llm') != kind or model_alias(provider, model) != requested:
                continue
            if not provider_allows(provider, plugin_id) or (bound and provider['id'] != bound):
                raise AuthError(403, '当前插件无权使用此供应商或模型')
            if kind == 'image' and model.get('protocol') != 'openai-images':
                raise AuthError(422, '此供应商的生图协议未接入')
            prefix = provider['modelPrefix']
            upstream_id = model['id'].removeprefix(prefix) if prefix else model['id']
            return provider, upstream_id, model
    if bound:
        raise AuthError(403, '请从此插件绑定的供应商选择可用模型')
    return None


def validate_model_profile(profile, kind):
    fields = {'size', 'quality', 'complexity'} if kind == 'image' else {
        'contextWindow', 'maxTokens', 'input', 'reasoningLevels', 'reasoningMap', 'defaultReasoning',
    }
    if not isinstance(profile, dict) or set(profile) - fields:
        raise AuthError(422, '模型参数格式无效')
    if kind == 'image':
        options = {'size': IMAGE_SIZES, 'quality': IMAGE_QUALITIES, 'complexity': IMAGE_COMPLEXITIES}
        if any(value not in options[key] for key, value in profile.items()):
            raise AuthError(422, '不支持该生图尺寸、质量或复杂度')
        return profile
    for field in ('contextWindow', 'maxTokens'):
        if field in profile and (type(profile[field]) is not int or not 1 <= profile[field] <= 10_000_000):
            raise AuthError(422, 'Token 限额须为正整数')
    inputs = profile.get('input', ['text'])
    if not isinstance(inputs, list) or 'text' not in inputs or any(item not in ('text', 'image') for item in inputs):
        raise AuthError(422, '输入类型限文本和图片')
    levels = profile.get('reasoningLevels', [])
    if (not isinstance(levels, list) or any(level not in REASONING_LEVELS for level in levels)
            or (levels and all(level == 'none' for level in levels))):
        raise AuthError(422, '请选择有效推理等级')
    mapping = profile.get('reasoningMap', {})
    if (not isinstance(mapping, dict) or any(key not in levels or not isinstance(value, str) or not value.strip()
                                            for key, value in mapping.items())):
        raise AuthError(422, '推理映射须与所选等级对应')
    if 'defaultReasoning' in profile and profile['defaultReasoning'] not in levels:
        raise AuthError(422, '默认推理等级须在所选列表中')
    return profile


def available_models(store, kind, defaults, plugin_id=None, *, management=False):
    binding = store.provider_bindings(plugin_id).get(kind)
    extra = [{
        'id': model_alias(provider, model),
        'label': model.get('name') or model['id'],
        'providerId': provider['id'], 'provider_label': provider['name'],
        'api': model.get('protocol', 'openai-completions'),
        'profile': model.get('profile', {}),
        'capabilities': {'protocol': model.get('protocol')},
    } for provider, model in provider_models(store, kind, plugin_id, management=management)]
    return ([] if binding else defaults) + extra


def normalize_official_openai_chat(payload):
    # OpenAI does not accept the DeepSeek and Qwen thinking flags injected by some plugins.
    payload.pop('thinking', None)
    payload.pop('enable_thinking', None)
    if payload.get('model') == 'gpt-6-luna' and 'max_tokens' in payload:
        legacy_limit = payload.pop('max_tokens')
        if legacy_limit is not None:
            payload.setdefault('max_completion_tokens', legacy_limit)


def text_reasoning(payload, profile, responses):
    if responses:
        reasoning = dict(payload.get('reasoning') or {})
        effort = reasoning.get('effort', profile.get('defaultReasoning'))
        if effort:
            reasoning['effort'] = profile.get('reasoningMap', {}).get(effort, effort)
            payload['reasoning'] = reasoning
    elif 'reasoning_effort' not in payload and profile.get('defaultReasoning'):
        effort = profile['defaultReasoning']
        payload['reasoning_effort'] = profile.get('reasoningMap', {}).get(effort, effort)
    if 'maxTokens' in profile:
        ceiling = profile['maxTokens']
        key = 'max_output_tokens' if responses else 'max_completion_tokens'
        actual = payload.get(key, payload.get('max_tokens', ceiling))
        if type(actual) is int and actual > ceiling:
            payload.pop('max_tokens', None)
            payload[key] = ceiling


def chat_to_responses(payload):
    if payload.get('tools') or payload.get('functions') or payload.get('n', 1) != 1:
        raise AuthError(422, '此插件兼容入口只转接单路文字对话')
    items = []
    for message in payload['messages']:
        if not isinstance(message, dict) or message.get('role') not in ('system', 'developer', 'user', 'assistant'):
            raise AuthError(422, '此插件兼容入口不支持该消息类型')
        role, content = message['role'], message.get('content')
        if isinstance(content, list):
            parts = []
            for part in content:
                if not isinstance(part, dict):
                    raise AuthError(422, '对话输入格式无效')
                if part.get('type') == 'text':
                    parts.append({'type': 'output_text' if role == 'assistant' else 'input_text', 'text': part['text']})
                elif part.get('type') == 'image_url' and role == 'user':
                    image = part['image_url']
                    parts.append({'type': 'input_image', 'image_url': image['url'], 'detail': image.get('detail', 'auto')})
                else:
                    raise AuthError(422, '此供应商不支持该消息部件')
            content = parts
        items.append({'role': role, 'content': content})
    request = {'model': payload['model'], 'input': items, 'store': False, 'stream': bool(payload.get('stream'))}
    max_tokens = payload.get('max_completion_tokens') or payload.get('max_tokens')
    if max_tokens:
        request['max_output_tokens'] = max_tokens
    if payload.get('reasoning_effort'):
        request['reasoning'] = {'effort': payload['reasoning_effort']}
    return request


def response_as_chat(data):
    text = ''.join(part.get('text', '') for item in data.get('output', []) for part in item.get('content', [])
                   if part.get('type') == 'output_text')
    usage = data.get('usage') or {}
    return {'id': data.get('id'), 'model': data.get('model'), 'object': 'chat.completion',
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text},
                         'finish_reason': 'length' if data.get('status') == 'incomplete' else 'stop'}],
            'usage': {'prompt_tokens': usage.get('input_tokens'), 'completion_tokens': usage.get('output_tokens'),
                      'total_tokens': usage.get('total_tokens')}}


def response_event_as_chat(event, model):
    if event.get('type') == 'response.output_text.delta':
        choice = {'index': 0, 'delta': {'content': event.get('delta', '')}, 'finish_reason': None}
    elif event.get('type') in ('response.completed', 'response.incomplete'):
        choice = {'index': 0, 'delta': {},
                  'finish_reason': 'stop' if event['type'] == 'response.completed' else 'length'}
    elif event.get('type') in ('error', 'response.failed'):
        return {'error': {'message': '供应商未能完成文字输出'}}
    else:
        return None
    return {'object': 'chat.completion.chunk', 'model': model, 'choices': [choice]}
