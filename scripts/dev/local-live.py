#!/usr/bin/env python3
"""Persistent single-member development stack; never submits model generations."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('GREENROOM_LOCAL_DATA', Path.home() / '.local/share/greenroom-public')).resolve()
MEMBER = 'user_greenroom_local'
PORT = int(os.environ.get('GREENROOM_LOCAL_PORT', '18443'))
PROJECT = os.environ.get('GREENROOM_COMPOSE_PROJECT', 'greenroom-public')
MAIN = f'https://greenroom.localhost:{PORT}'
RUNTIME = f'https://dsh.greenroom.localhost:{PORT}'
IMAGE_PREFIX = os.environ.get('GREENROOM_IMAGE_PREFIX', 'greenroom-public-')
DSH_VERSION = '0.2.2-rc.5'
DSH_IMAGE = os.environ.get('GREENROOM_DSH_IMAGE', IMAGE_PREFIX + 'dsh:rc5')
DEV_MEM_LIMIT_BYTES = 4 * 1024**3
CANVAS_URL = re.search(r'"(https://codeload.github.com/T8mars/[^\"]+)"',
                      (ROOT / 'runtime/canvas/Dockerfile').read_text()).group(1)
CANVAS_SOURCE = DATA / 'sources' / ('canvas-' + CANVAS_URL.rsplit('/', 1)[-1])
AID_MANIFEST = json.loads((ROOT / 'runtime/creative-plugins/aid-studio/manifest.json').read_text())
AID_URL = (AID_MANIFEST['upstream'].replace('https://github.com/', 'https://codeload.github.com/')
           + '/tar.gz/' + AID_MANIFEST['revision'])
AID_SOURCE = DATA / 'sources' / ('aid-studio-' + AID_MANIFEST['revision'])


def read_env(path):
    result = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def save_env(path, values):
    path.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
    path.chmod(0o600)


def creative_manifests(catalog):
    return [json.loads((ROOT / 'runtime/creative-plugins' / row['id'] / 'manifest.json').read_text())
            for row in catalog['plugins']
            if not row.get('builtin') and row.get('kind') != 'website'
            and row.get('status') != 'awaiting-authorization']


def write_dsh_patch(state, gateway_model_patch):
    import yaml

    target = state / 'patch/greenroom.patch.yml'
    display_name = 'Greenroom'
    if target.exists():
        for row in yaml.safe_load(target.read_text()):
            if row.get('id') == 'llm-pi-ai':
                display_name = row['config']['providers']['greenroom-gateway']['displayName']
                break
    catalog = [{'id': 'greenroom/unconfigured', 'contextWindow': 65536, 'maxTokens': 4096,
                'inputModalities': ['text'], 'input': ['text']}]
    creative = (ROOT / 'runtime/dsh/managed-profile/creative.patch.yml').read_text()
    creative = creative.replace('name: ../', 'name: /opt/dsh/')
    target.parent.mkdir(exist_ok=True)
    target.write_text(yaml.safe_dump(gateway_model_patch(catalog, display_name), sort_keys=False) + creative)


def container_prepare():
    import importlib.util
    import certifi
    from cryptography.fernet import Fernet
    state = Path('/state')
    def module(name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    if not (state / 'tls/edge/ca.crt').exists():
        module('certificates', ROOT / 'scripts/runtime/runtime-certificates.py').generate(
            state / 'tls', [MEMBER], extra_dns=('greenroom.localhost', 'dsh.greenroom.localhost', 'dsh', 'broker'))
    for path in (state / 'tls').rglob('*'):
        os.chown(path, 0, 10000)
        path.chmod(0o750 if path.is_dir() else 0o640)
    (state / 'trust.pem').write_bytes(Path(certifi.where()).read_bytes() + b'\n' + (state / 'tls/edge/ca.crt').read_bytes())
    (state / 'trust.pem').chmod(0o644)
    runtime_env = read_env(state / 'runtime.env')
    runtime_env.setdefault('DSH_SESSION_KEY', Fernet.generate_key().decode())
    save_env(state / 'runtime.env', runtime_env)
    manifests = creative_manifests(json.loads((state / 'catalog.json').read_text()))
    directories = [('member/home', 10001), ('member/workspace', 10001),
                   ('member/launch', 10001), ('member/canvas', 10003),
                   ('member/home/creative-plugins', 10001),
                   *[('member/home/creative-plugins/' + item['id'], 10001) for item in manifests],
                   ('aid/data', 10001), ('aid/mysql', 999), ('aid/redis', 999)]
    for name, uid in directories:
        path = state / name
        path.mkdir(parents=True, exist_ok=True)
        os.chown(path, uid, 10000)
        path.chmod(0o2770)
    # Reuse the production plugin container declarations for the local sidecars.
    sys.path.insert(0, str(ROOT / 'server'))
    runtime = module('runtime', ROOT / 'scripts/runtime/render-runtime.py')
    configuration = json.loads((state / 'compose.json').read_text())
    services = configuration['services']
    images = {name: service['image'] for name, service in services.items()}
    for manifest in runtime.creative_plugins():
        if manifest.get('deployment', {}).get('shared'):
            continue
        production = runtime.creative_container(manifest, images[manifest['id']], {'id': MEMBER})
        services[manifest['id']].update(
            entrypoint=production['command'], command=production['args'],
            working_dir=production['workingDir'],
            environment={row['name']: row['value'] for row in production['env'] if 'value' in row})
    write_dsh_patch(state, runtime.gateway_model_patch)
    (state / 'compose.json').write_text(json.dumps(configuration, ensure_ascii=False, indent=2))
    print('Local sessions, TLS and member directories prepared; no generation requested.')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def docker(*args, **kwargs):
    return run('docker', *args, **kwargs)


def compose(*args):
    docker('compose', '-p', PROJECT, '-f', str(DATA / 'compose.json'), *args)


def image_exists(reference):
    return subprocess.run(['docker', 'image', 'inspect', reference],
                          capture_output=True).returncode == 0


def build_targets(names, services, reuse):
    """Services whose images must be built, one per shared image; `reuse` skips existing images."""
    by_image = {}
    for name, service in services.items():
        if service.get('build'):
            by_image.setdefault(service['image'], name)
    targets = {}
    for name in names:
        builder = name if services[name].get('build') else by_image.get(services[name]['image'])
        if builder:
            targets.setdefault(services[builder]['image'], builder)
    if not reuse:
        return list(targets.values())
    return [name for image, name in targets.items() if not image_exists(image)]


def parse_mem(value):
    match = re.fullmatch(r'([\d.]+)\s*(B|[kKMGT]i?B)', value.strip())
    if not match:
        return 0.0
    number, unit = match.group(1), match.group(2)
    if unit == 'B':
        return float(number)
    exponent = 'KMGT'.index(unit[0].upper()) + 1
    base = 1024 if unit[1:] == 'iB' else 1000
    return float(number) * base**exponent


def check_dev_memory():
    try:
        containers = subprocess.run(['docker', 'compose', '-p', PROJECT,
                                     '-f', str(DATA / 'compose.json'), 'ps', '-q'],
                                    check=True, capture_output=True, text=True).stdout.split()
        if not containers:
            return
        output = subprocess.run(['docker', 'stats', '--no-stream',
                                 '--format', '{{.Name}}\t{{.MemUsage}}', *containers],
                                check=True, capture_output=True, text=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return
    usage = []
    for line in output.splitlines():
        name, _, mem = line.partition('\t')
        text = mem.split('/')[0].strip()
        used = parse_mem(text)
        if used and name:
            usage.append((used, name, text))
    usage.sort(reverse=True)
    total = sum(item[0] for item in usage)
    if not usage:
        return
    for used, name, text in usage:
        if used > DEV_MEM_LIMIT_BYTES:
            print(f'内存提醒：容器 {name} 占用 {text}，超过单人开发参考上限 4GiB；'
                  '本机单人开发理论上限约 4G，超过说明有可优化项。')
    if total > DEV_MEM_LIMIT_BYTES:
        top = '、'.join(f'{name} {text}' for _, name, text in usage[:3])
        print(f'内存提醒：greenroom-local 总占用 {total / 1024**3:.1f}GiB，超过 4GiB 参考上限（前三：{top}）。')


def prepare_environment():
    docker('run', '--rm', '--entrypoint', 'python',
           '-v', str(ROOT) + ':/greenroom:ro', '-v', str(DATA) + ':/state',
           '-v', str(DATA / 'catalog.json') + ':/greenroom/runtime/creative-plugins/catalog.json:ro',
           IMAGE_PREFIX + 'api:local', '/greenroom/scripts/dev/local-live.py', '_prepare')


def prepare_source(source, url, partial):
    source.mkdir(parents=True, exist_ok=True)
    archive = source / 'source.tar.gz'
    if not archive.exists():
        run('curl', '-fL', '--connect-timeout', '20', '--max-time', '1800', url, '-o', str(partial))
        partial.rename(archive)


def prepare_canvas_source():
    prepare_source(CANVAS_SOURCE, CANVAS_URL, (CANVAS_SOURCE / 'source.tar.gz').with_suffix('.part'))


def prepare_aid_source():
    prepare_source(AID_SOURCE, AID_URL, AID_SOURCE.parent / (AID_SOURCE.name + '.part'))


def configure():
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA.chmod(0o700)
    config = DATA / 'development.env'
    values = read_env(config)
    provider_keys = ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GATEWAY_API_KEY', 'GATEWAY_SERVICE_URL', 'GATEWAY_MODELS')
    for key in provider_keys:
        if key in os.environ:
            values[key] = os.environ[key]
    values.setdefault('GREENROOM_LOCAL_BOOTSTRAP_TOKEN', secrets.token_urlsafe(32))
    values.setdefault('LOCAL_ASSET_TOKEN', secrets.token_urlsafe(32))
    if not re.fullmatch(r'[A-Za-z0-9_-]+', values['GREENROOM_LOCAL_BOOTSTRAP_TOKEN']):
        raise SystemExit('GREENROOM_LOCAL_BOOTSTRAP_TOKEN must be a nonempty URL-safe token.')
    for key in ('AID_DB_PASSWORD', 'AID_DB_ROOT_PASSWORD', 'AID_TOKEN_SECRET', 'AID_REDIS_PASSWORD'):
        values.setdefault(key, secrets.token_urlsafe(32))
    save_env(config, values)
    previous_runtime = read_env(DATA / 'runtime.env')
    runtime = {key: values.get(key, '') for key in provider_keys}
    if previous_runtime.get('DSH_SESSION_KEY'):
        runtime['DSH_SESSION_KEY'] = previous_runtime['DSH_SESSION_KEY']
    runtime.update(APP_ENV='development', AUTH_EXTERNAL_ENABLED='false', AUTH_SERVICE_URL='',
        GREENROOM_STANDALONE='true', GREENROOM_LOCAL_BOOTSTRAP_TOKEN=values['GREENROOM_LOCAL_BOOTSTRAP_TOKEN'],
        GREENROOM_LOCAL_ASSET='true', GREENROOM_STAGING_ASSET_TOKEN=values['LOCAL_ASSET_TOKEN'],
        DATA_DIR='/state/app-store', HOST='0.0.0.0', PORT='8788',
        PUBLIC_BASE_URL=MAIN, ASSET_SERVICE_URL='http://asset:18081', CREATIVE_AID_URL='http://aid:18807',
        ASSET_TENANT_ID=MEMBER, ASSET_WORKSPACE_ID='greenroom-local', ASSET_SCOPE_ID='greenroom-local-shared',
        ASSET_OBJECT_HOSTS='asset', DSH_TLS_DIR='/state/tls/edge',
        MEMBER_SLEEP_ENABLED='false', MEMBER_MEMORY_ENABLED='false', MEMBER_WARM_IDLE_LIMIT='0',
        DSH_RUNTIME_SLOTS=json.dumps({MEMBER: {'origin': RUNTIME, 'connector': 'https://dsh:8443'}}, separators=(',', ':')),
        SSL_CERT_FILE='/state/trust.pem', BUILD_SHA='local')
    save_env(DATA / 'runtime.env', runtime)
    save_env(DATA / 'asset.env', {'LOCAL_ASSET_TOKEN': values['LOCAL_ASSET_TOKEN']})
    save_env(DATA / 'aid.env', {
        'PORT': '18807', 'GREENROOM_MANAGED': 'true', 'GREENROOM_PLUGIN_ROOT': '/data/aid',
        'GREENROOM_BASE_PATH': '/plugins/aid-studio/', 'DB_HOST': 'aid-mysql', 'DB_PORT': '3306',
        'DB_NAME': 'aid', 'DB_USERNAME': 'aid', 'DB_PASSWORD': values['AID_DB_PASSWORD'],
        'TOKEN_SECRET': values['AID_TOKEN_SECRET'], 'REDIS_HOST': 'aid-redis', 'REDIS_PORT': '6379',
        'REDIS_DATABASE': '0', 'REDIS_PASSWORD': values['AID_REDIS_PASSWORD']})
    save_env(DATA / 'aid-mysql.env', {
        'MYSQL_DATABASE': 'aid', 'MYSQL_USER': 'aid', 'MYSQL_PASSWORD': values['AID_DB_PASSWORD'],
        'MYSQL_ROOT_PASSWORD': values['AID_DB_ROOT_PASSWORD']})
    save_env(DATA / 'aid-redis.env', {'REDIS_PASSWORD': values['AID_REDIS_PASSWORD']})
    catalog = json.loads((ROOT / 'runtime/creative-plugins/catalog.json').read_text())
    catalog.update(releaseReady=True, aigcSkillsReady=True)
    manifests = creative_manifests(catalog)
    (DATA / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False))
    for name in ['app-store', 'member', 'asset-store', 'aid']:
        (DATA / name).mkdir(exist_ok=True)
    (DATA / 'nginx.conf').write_text('''events {}
http {
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  map $request_method $local_bootstrap { default ''; POST '__LOCAL_BOOTSTRAP_TOKEN__'; }
  access_log off;
  client_max_body_size 512m;
  proxy_read_timeout 600s;
  proxy_send_timeout 600s;
  proxy_buffering off;
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_set_header X-Greenroom-Local-Bootstrap "";
  resolver 127.0.0.11 valid=2s ipv6=off;
  ssl_certificate /state/tls/edge/broker.crt;
  ssl_certificate_key /state/tls/edge/broker.key;
  server {
    listen 443 ssl;
    server_name greenroom.localhost;
    set $api_upstream api:8788;
    set $web_upstream web:3000;
    location = /api/auth/refresh {
      proxy_set_header Host $http_host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header X-Greenroom-Local-Bootstrap $local_bootstrap;
      proxy_pass http://$api_upstream;
    }
    location /api/ { proxy_pass http://$api_upstream; }
    location /local-models/ { proxy_pass http://$api_upstream; }
    location = /healthz { proxy_pass http://$api_upstream; }
    location / { proxy_pass http://$web_upstream; }
  }
  server {
    listen 443 ssl;
    server_name dsh.greenroom.localhost;
    set $api_upstream api:8788;
    location / { proxy_pass http://$api_upstream; }
  }
}
'''.replace('__LOCAL_BOOTSTRAP_TOKEN__', values['GREENROOM_LOCAL_BOOTSTRAP_TOKEN']))
    (DATA / 'nginx.conf').chmod(0o600)
    def bind(source, target, readonly=True):
        return {'type': 'bind', 'source': str(source), 'target': target, 'read_only': readonly,
                'bind': {'create_host_path': False}}
    def health(cmd, start=15):
        return {'test': ['CMD', *cmd], 'interval': '5s', 'timeout': '5s', 'retries': 36, 'start_period': f'{start}s'}
    # Keep the canvas source cached when its image needs rebuilding.
    recipe = (ROOT / 'runtime/canvas/Dockerfile').read_text()
    start, end = recipe.index('RUN (curl'), recipe.index('RUN npm ci')
    recipe = recipe[:start] + ('COPY --from=canvas_source source.tar.gz /tmp/canvas.tar.gz\n'
        'RUN tar -xzf /tmp/canvas.tar.gz --strip-components=1 && rm /tmp/canvas.tar.gz\n') + recipe[end:]
    canvas_recipe = recipe.replace('RUN apt-get update',
        "COPY --from=docker.io/library/python:3.12.13-slim /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt\n"
        "RUN sed -i 's@http://deb.debian.org/debian@https://mirrors.tuna.tsinghua.edu.cn/debian@g' /etc/apt/sources.list.d/debian.sources && apt-get update")
    def build(dockerfile, target=None, context=ROOT):
        result = {'context': str(context), 'dockerfile': dockerfile, 'provenance': False}
        if dockerfile == 'runtime/canvas/Dockerfile':
            result.pop('dockerfile')
            result['dockerfile_inline'] = canvas_recipe.replace('$', '$$')
            result['additional_contexts'] = {'canvas_source': str(CANVAS_SOURCE)}
        if dockerfile in ('runtime/creative-plugins/aid-studio/Dockerfile',
                          'runtime/creative-plugins/aid-studio/database.Dockerfile'):
            recipe = (ROOT / dockerfile).read_text().replace(
                'RUN curl -fsSL --max-time 240 ' + AID_URL + ' | tar -xz --strip-components=1',
                'COPY --from=aid_source source.tar.gz /tmp/aid-source.tar.gz\n'
                'RUN tar -xzf /tmp/aid-source.tar.gz --strip-components=1 && rm /tmp/aid-source.tar.gz')
            result.pop('dockerfile')
            result['dockerfile_inline'] = recipe.replace('$', '$$')
            result['additional_contexts'] = {'aid_source': str(AID_SOURCE)}
        if dockerfile.startswith('runtime/creative-plugins/'):
            recipe = result.get('dockerfile_inline', (ROOT / dockerfile).read_text())
            if 'RUN apt-get update' in recipe:
                recipe = recipe.replace('RUN apt-get update',
                    'COPY --from=docker.io/library/python:3.12.13-slim /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt\n'
                    "RUN sed -i 's@http://deb.debian.org/debian@https://mirrors.tuna.tsinghua.edu.cn/debian@g' /etc/apt/sources.list.d/debian.sources && apt-get update")
                if dockerfile == 'runtime/creative-plugins/toonflow/Dockerfile':
                    recipe = recipe.replace('apt-get ',
                        'apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt ')
                result.pop('dockerfile', None)
                result['dockerfile_inline'] = recipe.replace('$', '$$') if 'dockerfile_inline' not in result else recipe
        if target: result['target'] = target
        return result
    source = [bind(ROOT / item, '/greenroom/' + item) for item in ['server', 'scripts', 'runtime', 'package.json']]
    mounts = [*source, bind(DATA / 'catalog.json', '/greenroom/runtime/creative-plugins/catalog.json'),
              bind(DATA / 'trust.pem', '/usr/local/lib/python3.12/site-packages/certifi/cacert.pem'),
              bind(DATA, '/state', False)]
    api = {'image': IMAGE_PREFIX + 'api:local', 'build': build('scripts/dev/Dockerfile'),
           'working_dir': '/greenroom/server', 'env_file': [str(DATA / 'runtime.env')], 'volumes': mounts,
           'environment': {'GREENROOM_DSH_VERSION': DSH_VERSION},
           'networks': ['default', 'assets'],
           'stop_grace_period': '60s'}
    services = {
        'api': {**api, 'command': ['python', '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8788'],
                'depends_on': {'asset': {'condition': 'service_healthy'}},
                'healthcheck': health(['python', '-c', "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8788/healthz')"])},
        'broker': {**api, 'command': ['python', '/greenroom/scripts/dev/local-broker.py'],
                'environment': {**api['environment'], 'GREENROOM_LOCAL_RENDER_DATA': str(DATA / 'member'),
                                'AIGC_RENDER_IMAGE': IMAGE_PREFIX + 'aigc-render:local'},
                'volumes': [*mounts, bind('/var/run/docker.sock', '/var/run/docker.sock', False)]},
        'web': {'image': IMAGE_PREFIX + 'web:local', 'build': build('Dockerfile', 'frontend-deps'),
                'working_dir': '/app', 'command': ['pnpm', 'dev', '--host', '0.0.0.0', '--strictPort'],
                'volumes': [bind(ROOT / item, '/app/' + item) for item in ['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json']]},
        'proxy': {'image': IMAGE_PREFIX + 'api:local', 'command': ['nginx', '-c', '/state/nginx.conf', '-g', 'daemon off;'],
                  'ports': [f'127.0.0.1:{PORT}:443'], 'volumes': [bind(DATA, '/state')],
                  'depends_on': ['api', 'web']},
        'dsh': {'image': DSH_IMAGE,
                **({} if 'GREENROOM_DSH_IMAGE' in os.environ else
                   {'build': build('runtime/dsh/Dockerfile')}),
                'user': '10001:10000', 'read_only': True,
                'environment': {'MEMBER_ID': MEMBER, 'DSH_HOME': '/var/lib/dsh', 'DSH_DEFAULT_WORKSPACE': '/workspace',
                                'GREENROOM_DSH_ORIGIN': RUNTIME, 'GREENROOM_DSH_NATIVE': '1',
                                'GREENROOM_DSH_EXPERIMENTS': '1'},
                'volumes': [bind(DATA/'member/home','/var/lib/dsh',False), bind(DATA/'member/workspace','/workspace',False),
                    bind(DATA/'member/launch','/run/dsh',False), bind(DATA/'patch','/etc/dsh'),
                    bind(DATA/'catalog.json','/opt/creative-plugins/catalog.json')],
                'tmpfs': ['/tmp:rw,exec,size=536870912,uid=10001,gid=10000'], 'stop_grace_period': '60s',
                'healthcheck': health(['node','-e',"const fs=require('fs');if(!fs.existsSync('/run/dsh/launch-token'))process.exit(1);fetch('http://127.0.0.1:18767/health').then(r=>r.json()).then(x=>{if(!x.ready)process.exit(1)}).catch(()=>process.exit(1))"])},
        'connector': {'image': IMAGE_PREFIX + 'connector:local', 'build': build('runtime/connector/Dockerfile'),
                'network_mode': 'service:dsh', 'read_only': True, 'user': '10002:10000',
                'environment': {'MEMBER_ID': MEMBER, 'MODEL_BROKER_URL': 'https://broker:8444',
                                'GREENROOM_STANDALONE': 'true', 'GREENROOM_DSH_VERSION': DSH_VERSION},
                'volumes': [bind(DATA/'tls/dsh-local','/etc/greenroom/tls'), bind(DATA/'member/launch','/run/dsh'),
                            bind(DATA/'member/workspace','/workspace'), bind(ROOT/'runtime/connector/app.py','/app/runtime/connector/app.py')]},
        'canvas': {'image': IMAGE_PREFIX + 'canvas:local', 'build': build('runtime/canvas/Dockerfile'),
                'network_mode': 'service:dsh', 'read_only': True, 'user': '10003:10000',
                'environment': {'MEMBER_ID': MEMBER},
                'volumes': [bind(DATA/'member/canvas','/var/lib/canvas',False),
                            bind(ROOT/'runtime/canvas/managed-runtime.cjs','/app/backend/src/greenroom-managed-runtime.js')],
                'tmpfs': ['/tmp:rw,size=1073741824,uid=10003,gid=10000'], 'stop_grace_period': '60s',
                'healthcheck': health(['node','-e',"fetch('http://127.0.0.1:18766/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"])},
        'asset': {'image': 'node:24.22.1-trixie-slim', 'command': ['node', '/app/server.mjs'],
                'env_file': [str(DATA / 'asset.env')],
                'environment': {'HOST': '0.0.0.0', 'PORT': '18081', 'DATA_DIR': '/data',
                                'ASSET_INTERNAL_URL': 'http://asset:18081'},
                'networks': ['assets'],
                'volumes': [bind(ROOT/'runtime/local-asset-service/server.mjs', '/app/server.mjs'),
                            bind(DATA/'asset-store', '/data', False)],
                'healthcheck': health(['node', '-e', "fetch('http://asset:18081/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"])},
        'aid': {'image': IMAGE_PREFIX + 'aid-studio:local',
                'build': build('runtime/creative-plugins/aid-studio/Dockerfile'),
                'user': '10001:10000', 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'env_file': [str(DATA / 'aid.env')],
                'volumes': [bind(DATA / 'aid/data', '/data/aid', False)],
                'tmpfs': ['/tmp:rw,exec,size=536870912,uid=10001,gid=10000'],
                'stop_grace_period': '60s',
                'healthcheck': health(['node', '-e', "fetch('http://127.0.0.1:18807/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], 60),
                'depends_on': {'aid-mysql': {'condition': 'service_healthy'},
                               'aid-redis': {'condition': 'service_healthy'}}},
        'aid-mysql': {'image': IMAGE_PREFIX + 'aid-database:local',
                'build': build('runtime/creative-plugins/aid-studio/database.Dockerfile'),
                'user': '999:10000', 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'env_file': [str(DATA / 'aid-mysql.env')],
                'volumes': [bind(DATA / 'aid/mysql', '/var/lib/mysql', False)],
                'tmpfs': ['/var/run/mysqld:rw,size=16777216,uid=999,gid=10000',
                          '/tmp:rw,size=268435456,uid=999,gid=10000'],
                'stop_grace_period': '60s',
                'healthcheck': {'test': ['CMD-SHELL', 'MYSQL_PWD="$$MYSQL_PASSWORD" mysql -h 127.0.0.1 -u "$$MYSQL_USER" -D "$$MYSQL_DATABASE" -Nse "SELECT 1" >/dev/null'],
                                'interval': '5s', 'timeout': '5s', 'retries': 60, 'start_period': '60s'}},
        'aid-redis': {'image': 'docker.io/library/redis:7.4.7-bookworm',
                'user': '999:10000', 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'env_file': [str(DATA / 'aid-redis.env')],
                'entrypoint': ['/bin/sh', '-ec'],
                'command': ['exec redis-server --bind 0.0.0.0 --appendonly yes --requirepass "$$REDIS_PASSWORD"'],
                'volumes': [bind(DATA / 'aid/redis', '/data', False)],
                'healthcheck': {'test': ['CMD-SHELL', 'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping | grep -q PONG'],
                                'interval': '5s', 'timeout': '5s', 'retries': 36, 'start_period': '15s'}},
        'aigc-render': {'image': IMAGE_PREFIX + 'aigc-render:local', 'build': build('runtime/aigc-render/Dockerfile'),
                'profiles': ['render']},
    }
    for manifest in manifests:
        if not manifest.get('runtime') or manifest.get('deployment', {}).get('shared'):
            continue
        identifier = manifest['id']
        services[identifier] = {
            'image': IMAGE_PREFIX + identifier + ':local',
            'build': build('runtime/creative-plugins/' + identifier + '/Dockerfile'),
            'network_mode': 'service:dsh', 'read_only': True, 'user': '10001:10000',
            'environment': {
                'GREENROOM_BROKER_URL': 'http://127.0.0.1:3081/plugin/' + identifier,
                'GREENROOM_MANAGED_URL': 'http://127.0.0.1:18767/managed/for/' + identifier,
            },
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'volumes': [bind(DATA / 'member/home/creative-plugins' / identifier,
                             '/var/lib/dsh/creative-plugins/' + identifier, False)],
            'tmpfs': ['/tmp:rw,exec,size=2147483648,uid=10001,gid=10000'],
            'stop_grace_period': '60s',
        }
    compose_config = {'services': services, 'networks': {'assets': {'internal': True}}}
    (DATA / 'compose.json').write_text(json.dumps(compose_config, ensure_ascii=False, indent=2))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '_prepare':
        container_prepare()
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['up','restart','build','status','logs','down','trust'])
    parser.add_argument('services', nargs='*')
    args = parser.parse_args()
    os.environ.update(COMPOSE_ANSI='never', COMPOSE_PROGRESS='plain', COMPOSE_PARALLEL_LIMIT='1')
    if args.action in {'up', 'build', 'restart'}:
        if args.action != 'up' and not args.services:
            parser.error(args.action + ' requires affected service names or all; finish in-flight tasks first')
        configure()
        prepared = set()
        if args.action != 'restart':
            # The environment preparation runs inside the API image, so that image has to
            # exist before it starts; the remaining images follow their own rules below.
            reference = json.loads((DATA / 'compose.json').read_text())['services']['api']['image']
            if not image_exists(reference):
                compose('build', 'api')
                prepared.add(reference)
        prepare_environment()
        services = json.loads((DATA / 'compose.json').read_text())['services']
        complete = not args.services or 'all' in args.services
        if complete:
            if args.action == 'build':
                names = [name for name, service in services.items() if service.get('build')]
            else:
                names = [name for name, service in services.items() if not service.get('profiles')]
        else:
            names = list(dict.fromkeys(args.services))
        unknown = set(names) - services.keys()
        if unknown:
            parser.error('unknown services: ' + ', '.join(sorted(unknown)))
        if args.action in {'up', 'restart'} and 'dsh' in names:
            names = list(dict.fromkeys([*names, *[name for name, service in services.items()
                                                if service.get('network_mode') == 'service:dsh']]))
        if args.action == 'restart':
            compose('up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '600', *names)
        else:
            # Deduplicate against the shared images this invocation has already built, so
            # an explicit `build broker` still rebuilds a shared image that already exists.
            build_names = [name for name in build_targets(names, services, args.action == 'up')
                           if services[name]['image'] not in prepared]
            if args.action == 'up' and complete and not image_exists(services['aigc-render']['image']):
                # The render image only feeds the broker's isolated rendering, which is not
                # part of the startup set, so it is prepared once and reused afterwards.
                build_names.append('aigc-render')
            if 'canvas' in build_names:
                prepare_canvas_source()
            if {'aid', 'aid-mysql'} & set(build_names):
                prepare_aid_source()
            for name in build_names:
                compose('build', name)
        if args.action == 'up':
            compose('up', '-d', '--wait', '--wait-timeout', '600', *names)
    elif args.action == 'trust':
        run('security','add-trusted-cert','-r','trustRoot','-k',str(Path.home()/'Library/Keychains/login.keychain-db'), str(DATA/'tls/edge/ca.crt'))
    elif args.action == 'down': compose('down')
    elif args.action == 'logs': compose('logs','--tail','80',*args.services)
    else: compose('ps')
    active = subprocess.check_output(['docker','compose','-p',PROJECT,
                '-f',str(DATA/'compose.json'),'ps','-q','api'],text=True).strip()
    source = subprocess.check_output(['docker','inspect','--format',
                '{{range .Mounts}}{{if eq .Destination "/greenroom/server"}}{{.Source}}{{end}}{{end}}',active],
                text=True).strip() if active else '未运行；启动脚本位于 ' + str(ROOT)
    print(f'入口：{MAIN}\nDSH：{RUNTIME}\n实际 API 源码：{source}\n数据：{DATA}\n配置：{DATA / "development.env"}')
    print('本地用户无需口令；页面可自动进入。停止不会删除数据。')
    check_dev_memory()


if __name__ == '__main__':
    main()
