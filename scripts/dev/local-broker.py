#!/usr/bin/env python3
"""Development broker bootstrap with fixed, member-bound Docker render jobs."""
from __future__ import annotations

import asyncio
from datetime import datetime
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server'))

from app.creative import creative_render
from app.creative.creative_render import CreativeRender, render_job
from app.identity.auth import AuthError
from app.integrations import model_relay

MEMBER = 'user_greenroom_local'
MEMBER_DATA = Path('/state/member')
IMAGE = os.environ['AIGC_RENDER_IMAGE']
PREFIX = 'greenroom-local-'
DEADLINE = 1800
COMMAND = ['--signal=KILL', f'{DEADLINE}s', 'node', '/opt/aigc-render/runner.mjs']


def task_resource(annotations):
    if annotations.get('greenroom/member') != MEMBER:
        raise AuthError(403, '本地渲染仅允许配置的开发成员')
    return render_job(MEMBER, annotations.get('greenroom/suite'),
                      annotations.get('greenroom/project'), annotations.get('greenroom/job'), IMAGE)


def local_member_slot(member_id):
    return '01' if member_id == MEMBER else None


class ContainerCreativeRender(CreativeRender):
    def __init__(self):
        super().__init__()
        self.host_data = Path(os.environ.get('GREENROOM_LOCAL_RENDER_DATA', ''))
        if not self.host_data.is_absolute():
            raise RuntimeError('GREENROOM_LOCAL_RENDER_DATA must be the absolute host DATA/member path')

    async def docker(self, *args):
        process = await asyncio.create_subprocess_exec(
            'docker', *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await process.communicate()
        return process.returncode, output.decode(), error.decode()

    async def request(self, method, path, payload=None):
        if method == 'POST':
            resource = task_resource(payload['metadata']['annotations'])
            name = PREFIX + resource['metadata']['name']
            mounts = resource['spec']['template']['spec']['containers'][0]['volumeMounts'][:2]
            for mount in mounts:
                local = MEMBER_DATA / mount['subPath']
                try:
                    resolved = local.resolve(strict=True)
                except OSError:
                    raise AuthError(422, '原渲染任务的 input/output 目录不存在')
                if resolved != local or not resolved.is_dir():
                    raise AuthError(422, '渲染挂载必须为原任务的 input/output 目录')
            argv = ['create', '--pull', 'never', '--name', name,
                    '--network', 'none', '--read-only', '--user', '10001:10000',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                    '--cpus', '2', '--memory', '2147483648', '--memory-swap', '2147483648',
                    '--tmpfs', '/tmp:rw,size=536870912,uid=10001,gid=10000',
                    '--tmpfs', '/dev/shm:rw,size=268435456,uid=10001,gid=10000',
                    '--mount', f"type=bind,source={self.host_data / mounts[0]['subPath']},target=/input,readonly",
                    '--mount', f"type=bind,source={self.host_data / mounts[1]['subPath']},target=/output"]
            for key, value in resource['metadata']['annotations'].items():
                argv.extend(['--label', f'{key}={value}'])
            # The deadline lives with the render process, including broker restarts.
            argv.extend(['--entrypoint', '/usr/bin/timeout', IMAGE, *COMMAND])
            code, _, error = await self.docker(*argv)
            if code:
                existing, _, _ = await self.docker('inspect', name)
                if existing == 0:
                    return 409, None
                raise AuthError(502, '实际隔离渲染容器创建失败：' + error.strip())
            code, _, error = await self.docker('start', name)
            if code:
                raise AuthError(502, '实际隔离渲染容器启动失败：' + error.strip())
            return await self.request('GET', path + '/' + resource['metadata']['name'])

        name = PREFIX + path.rsplit('/', 1)[-1]
        code, output, error = await self.docker('inspect', name)
        if code:
            if 'No such object:' in error or 'No such container:' in error:
                return 404, None
            raise AuthError(502, '实际隔离渲染状态查询失败，未自动重新提交')
        actual = json.loads(output)[0]
        config, host = actual['Config'], actual['HostConfig']
        resource = task_resource(config.get('Labels') or {})
        expected = resource['spec']['template']['spec']['containers'][0]['volumeMounts'][:2]
        mounts = {item['Destination']: item for item in actual['Mounts']}
        credential = any(any(word in entry.split('=', 1)[0].upper()
                             for word in ('TOKEN', 'API_KEY', 'SECRET', 'GRANT'))
                         for entry in config.get('Env', []))
        if (name != PREFIX + resource['metadata']['name'] or config['Image'] != IMAGE
                or config['Entrypoint'] != ['/usr/bin/timeout'] or config['Cmd'] != COMMAND
                or host['NetworkMode'] != 'none' or not host['ReadonlyRootfs']
                or config['User'] != '10001:10000' or credential
                or 'ALL' not in host.get('CapDrop', [])
                or 'no-new-privileges' not in host.get('SecurityOpt', [])
                or host['NanoCpus'] != 2_000_000_000 or host['Memory'] != 2_147_483_648
                or mounts.get('/input', {}).get('RW') is not False
                or mounts.get('/output', {}).get('RW') is not True
                or any(mounts.get(mount['mountPath'], {}).get('Source') != str(self.host_data / mount['subPath'])
                       for mount in expected)
                or any(item['Type'] == 'bind' and item['Destination'] not in {'/input', '/output'}
                       for item in actual['Mounts'])):
            raise AuthError(502, '实际渲染容器的镜像、资源或隔离配置不符合要求')
        state = actual['State']
        status = {'active': 1} if state['Running'] else (
            {'succeeded': 1} if state['Status'] == 'exited' and state['ExitCode'] == 0
            else {'failed': 1, 'conditions': [{'type': 'Failed', 'status': 'True',
                                              'reason': 'RenderProcessExited'}]}
            if state['Status'] in {'exited', 'dead'} else {})
        if status.get('failed') and state['ExitCode'] == 137 and not state.get('OOMKilled'):
            elapsed = (datetime.fromisoformat(state['FinishedAt'].replace('Z', '+00:00'))
                       - datetime.fromisoformat(state['StartedAt'].replace('Z', '+00:00'))).total_seconds()
            if elapsed >= DEADLINE:
                status['conditions'][0]['reason'] = 'DeadlineExceeded'
        return 200, {'metadata': {'name': name, 'annotations': config['Labels']}, 'status': status}


def main():
    settings = model_relay.load_settings()
    if (settings.environment != 'development' or settings.external_auth_enabled
            or not settings.standalone or settings.local_member_id != MEMBER):
        raise RuntimeError('Local Docker render requires standalone development mode and its local member')
    if os.environ.get('AIGC_RENDER_IMAGE') != IMAGE:
        raise RuntimeError('Local Docker render requires AIGC_RENDER_IMAGE=' + IMAGE)
    creative_render.member_slot = local_member_slot
    model_relay.CreativeRender = ContainerCreativeRender
    model_relay.main()


if __name__ == '__main__':
    main()
