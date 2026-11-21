"""Standalone plugin launch arguments and DSH gateway defaults."""

from app.creative.creative_catalog import runtime_manifests


def creative_plugins():
    return runtime_manifests()


def creative_container(manifest, image, member):
    identifier = manifest['id']
    root = '/var/lib/dsh/creative-plugins/' + identifier
    substitutions = {'ROOT': root, 'BROKER_URL': 'http://127.0.0.1:3081',
                     'BRIDGE_URL': 'http://127.0.0.1:18767/managed',
                     'BASE_PATH': '/plugins/' + identifier + '/'}
    env = dict(manifest['runtime'].get('env', {}))
    for key, value in env.items():
        for field, replacement in substitutions.items():
            value = value.replace('${' + field + '}', replacement)
        env[key] = value
    env.update(MEMBER_ID=member['id'], GREENROOM_PLUGIN_ROOT=root,
               GREENROOM_BROKER_URL=substitutions['BROKER_URL'],
               GREENROOM_MANAGED_URL=substitutions['BRIDGE_URL'],
               GREENROOM_BASE_PATH=substitutions['BASE_PATH'])
    lifecycle = manifest['runtime'].get('lifecycle')
    command = [manifest['runtime']['command']]
    arguments = manifest['runtime']['args']
    if lifecycle:
        launcher = lifecycle['launcher']
        script = '/opt/greenroom/plugin-launcher.' + ('py' if launcher == 'python' else 'mjs')
        command = [manifest['runtime']['command'] if launcher == 'python' else launcher, script]
        arguments = ['--port', str(manifest['runtime']['port'] + 1000), '--ready-url',
                     'http://127.0.0.1:' + str(manifest['runtime']['port']) + lifecycle['readyPath'],
                     '--', manifest['runtime']['command'], *manifest['runtime']['args']]
    return {
        'name': identifier, 'image': image,
        'command': command, 'args': arguments,
        'workingDir': manifest['runtime']['cwd'],
        'env': [{'name': key, 'value': str(value)} for key, value in env.items()] +
               [{'name': 'GREENROOM_PLUGIN_ID', 'value': identifier}],
    }


def gateway_model_patch(catalog, display_name='GREENROOM'):
    # Bootstrap/default metadata; greenroom-managed refreshes live LLM membership.
    provider = {'displayName': display_name, 'apiKeyEnv': 'GREENROOM_PROVIDER_KEY', 'api': 'openai-completions',
                'baseURL': 'http://127.0.0.1:3081/v1', 'models': catalog}
    return [{'id': 'llm-pi-ai', 'config': {'providers': {'greenroom-gateway': provider}}},
            {'id': 'agent-default-model', 'config': {'provider': 'greenroom-gateway', 'model': catalog[0]['id']}}]
