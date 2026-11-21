"""Fixed, member-bound render Jobs; generated code never runs in broker."""
import asyncio
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

import httpx

from app.identity.auth import AuthError
from app.creative.creative_catalog import creative_catalog
from app.core.roster import ROSTER

NAMESPACE = 'greenroom-local'
SUITES = {'lemo-opuscar', 'take-one', 'hypit'}
KUBE_CREDENTIALS = Path('/var/run/greenroom-render')
# Where a render binding is persisted before its Job is submitted. The API and
# the broker both run against this one file, so a member's render work is
# visible to a scale-down whichever process submitted it.
RENDER_BINDINGS = Path(os.environ.get('DATA_DIR', './data')) / 'render-bindings.sqlite3'
# How one member scale attempt ended. Only APPLIED means the API server
# confirmed the target replica count; NOT_APPLIED means the call provably did
# not take effect; UNKNOWN means the outcome cannot be established from here,
# so the caller must keep the operation and never resend it.
NOT_APPLIED, UNKNOWN, APPLIED = 'not_applied', 'unknown', 'applied'


class ScaleOutcome(AuthError):
    """A member scale result the caller must settle rather than retry.

    The outcome says whether the PATCH was sent and what came back, so a
    caller never has to guess from an exception's base class whether the
    Deployment may already have changed.
    """

    def __init__(self, outcome, message, replicas=None):
        super().__init__(503, message)
        self.outcome = outcome
        self.replicas = replicas


def member_slot(member_id):
    """The roster's fixed member slots; the only Deployments sleep may scale."""
    return next((f'{index:02d}' for index, member in enumerate(ROSTER, 1)
                 if member['id'] == member_id), None)


def render_address(member_id, suite_id, project_id, job_id):
    slot = member_slot(member_id)
    if not slot:
        raise AuthError(403, '渲染成员身份无效')
    if not isinstance(suite_id, str) or suite_id not in SUITES or not isinstance(project_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', project_id):
        raise AuthError(422, '渲染工程无效')
    try:
        identifier = uuid.UUID(job_id)
        if str(identifier) != job_id:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise AuthError(422, '渲染任务编号无效')
    return slot, f'greenroom-render-{slot}-{identifier.hex}'


def render_job(member_id, suite_id, project_id, job_id, image, memory_target=None):
    slot, name = render_address(member_id, suite_id, project_id, job_id)
    task_path = f'home/creative-plugins/{suite_id}/projects/{project_id}/renders/{job_id}'
    labels = {'greenroom-component': 'aigc-render', 'greenroom-render-member': slot}
    return {
        'apiVersion': 'batch/v1', 'kind': 'Job',
        'metadata': {'name': name, 'namespace': NAMESPACE, 'labels': labels,
                     'annotations': {'greenroom/member': member_id, 'greenroom/suite': suite_id,
                                     'greenroom/project': project_id, 'greenroom/job': job_id}},
        'spec': {'backoffLimit': 0, 'activeDeadlineSeconds': 1800,
                 'template': {'metadata': {'labels': labels}, 'spec': {
                     'restartPolicy': 'Never', 'automountServiceAccountToken': False,
                     'enableServiceLinks': False,
                     'securityContext': {'runAsNonRoot': True, 'runAsUser': 10001, 'runAsGroup': 10000,
                                         'fsGroup': 10000, 'seccompProfile': {'type': 'RuntimeDefault'}},
                     'affinity': {'podAffinity': {'requiredDuringSchedulingIgnoredDuringExecution': [{
                         'labelSelector': {'matchLabels': {'app': 'greenroom-dsh-' + slot}},
                         'topologyKey': 'kubernetes.io/hostname'}]}},
                     'containers': [{'name': 'render', 'image': image,
                                     'command': ['node', '/opt/aigc-render/runner.mjs'],
                                     'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                                                         'capabilities': {'drop': ['ALL']}},
                                     'volumeMounts': [
                                         {'name': 'task', 'mountPath': '/input', 'subPath': task_path + '/input', 'readOnly': True},
                                         {'name': 'task', 'mountPath': '/output', 'subPath': task_path + '/output'},
                                         {'name': 'tmp', 'mountPath': '/tmp'},
                                         {'name': 'shm', 'mountPath': '/dev/shm'}],
                                     'resources': {'requests': {'cpu': '100m', 'memory': str(memory_target) if memory_target else '256Mi'},
                                                   'limits': {'cpu': '2', 'memory': str(memory_target) if memory_target else '2Gi'}}}],
                     'volumes': [{'name': 'task', 'persistentVolumeClaim': {'claimName': 'greenroom-dsh-' + slot}},
                                 {'name': 'tmp', 'emptyDir': {'sizeLimit': '512Mi'}},
                                 {'name': 'shm', 'emptyDir': {'medium': 'Memory', 'sizeLimit': '256Mi'}}],
                 }}},
    }


class RenderBindings:
    """Durable render bindings, one row per member-bound render Job.

    A binding is written before the Job is submitted, so an interrupted submit
    still leaves a record that says this member has render work. Recovery reads
    the bindings and checks each Job by its fixed name; nothing here can list
    Jobs, and nothing is ever resubmitted.

    This ledger is deliberately separate from harness.sqlite3: that file stays
    the only admission, epoch, work and wake authority. A binding records render
    work so the scale-down knows it exists; the shared work row still covers the
    request that created it, so a crash between the binding and the submit never
    leaves a window where work exists that neither ledger can see.
    """

    def __init__(self, path=RENDER_BINDINGS):
        self.path = path
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA busy_timeout=5000')
        self.db.execute('CREATE TABLE IF NOT EXISTS render_bindings (member TEXT NOT NULL, suite TEXT NOT NULL, project TEXT NOT NULL, job TEXT NOT NULL, name TEXT NOT NULL, submitted INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, PRIMARY KEY (member, suite, project, job))')
        self.db.commit()

    def record(self, member_id, suite_id, project_id, job_id, name):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('INSERT OR IGNORE INTO render_bindings (member,suite,project,job,name,created) VALUES (?,?,?,?,?,?)', (member_id, suite_id, project_id, job_id, name, int(time.time())))
            self.db.commit()

    def mark_submitted(self, member_id, suite_id, project_id, job_id):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('UPDATE render_bindings SET submitted=1 WHERE member=? AND suite=? AND project=? AND job=?', (member_id, suite_id, project_id, job_id))
            self.db.commit()

    def mark_archived(self, member_id, suite_id, project_id, job_id):
        """Record that this Job's product reached the member's durable store.

        Only a confirmed archive releases a binding, so a Job that succeeded but
        whose product is still waiting keeps the member busy.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('UPDATE render_bindings SET archived=1 WHERE member=? AND suite=? AND project=? AND job=?', (member_id, suite_id, project_id, job_id))
            self.db.commit()

    def for_member(self, member_id):
        with self.lock:
            return [dict(row) for row in self.db.execute('SELECT * FROM render_bindings WHERE member=?', (member_id,)).fetchall()]

    def get(self, member_id, suite_id, project_id, job_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM render_bindings WHERE member=? AND suite=? AND project=? AND job=?',
                                  (member_id, suite_id, project_id, job_id)).fetchone()
        return dict(row) if row else None

    def discard_unsubmitted(self, member_id, suite_id, project_id, job_id):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute('DELETE FROM render_bindings WHERE member=? AND suite=? AND project=? AND job=? AND submitted=0',
                                      (member_id, suite_id, project_id, job_id)).rowcount
            self.db.commit()
        return changed == 1


class CreativeRender:
    def __init__(self, bindings=None):
        self.bindings = bindings if bindings is not None else RenderBindings()

    async def request(self, method, path, payload=None, *, content_type=None, return_statuses=()):
        """One Kubernetes call on the existing render credential channel.

        The default keeps the original render-Job behaviour: a JSON body with
        httpx's own content type. Member sleep passes an explicit merge-patch
        content type for the scale subresource. No path or payload is built by
        string interpolation from caller input beyond the fixed member slot.
        """
        if not (KUBE_CREDENTIALS / 'token').exists():
            raise AuthError(503, '隔离渲染调度尚未配置，请联系管理员')
        token = (KUBE_CREDENTIALS / 'token').read_text().strip()
        headers = {'Authorization': 'Bearer ' + token}
        body, json_body = None, payload
        if content_type is not None:
            headers['Content-Type'] = content_type
            body, json_body = json.dumps(payload).encode(), None
        async with httpx.AsyncClient(verify=str(KUBE_CREDENTIALS / 'ca.crt'), trust_env=False, timeout=20) as client:
            response = await client.request(method, 'https://kubernetes.default.svc' + path,
                                            headers=headers, json=json_body, content=body)
        if response.status_code in {404, 409} or response.status_code in return_statuses:
            return response.status_code, None
        if not response.is_success:
            raise AuthError(502, f'隔离渲染调度失败（HTTP {response.status_code}），未自动重新提交')
        return response.status_code, response.json()

    @staticmethod
    def verify_owner(resource, member_id, suite_id, project_id, job_id):
        annotations = resource.get('metadata', {}).get('annotations', {})
        expected = {'member': member_id, 'suite': suite_id, 'project': project_id, 'job': job_id}
        if any(annotations.get('greenroom/' + key) != value for key, value in expected.items()):
            raise AuthError(403, '无权读取此渲染任务')

    @staticmethod
    def state(resource, job_id):
        value = resource.get('status', {})
        conditions = {row.get('type') for row in value.get('conditions', []) if row.get('status') == 'True'}
        status = 'succeeded' if value.get('succeeded') or 'Complete' in conditions else 'failed' if value.get('failed') or 'Failed' in conditions else 'running' if value.get('active') else 'pending'
        result = {'jobId': job_id, 'status': status}
        if status == 'failed':
            condition = next((row for row in value.get('conditions', []) if row.get('type') == 'Failed'), {})
            result['error'] = '隔离渲染任务未完成：' + (condition.get('reason') or '请读取任务输出中的具体失败原因')
        return result

    @staticmethod
    def memory_target_matches(resource, target):
        from app.workspace.member_memory import memory_bytes
        try:
            containers = resource['spec']['template']['spec']['containers']
            render = [item for item in containers if item['name'] == 'render']
            return bool(resource['metadata']['uid']) and len(render) == 1 and all(
                memory_bytes(render[0]['resources'][kind]['memory']) == target for kind in ('requests', 'limits'))
        except (KeyError, TypeError, ValueError):
            return False

    async def submit(self, member_id, payload, *, memory=None, memory_minimum=None):
        if not isinstance(payload, dict) or set(payload) != {'suiteId', 'projectId', 'jobId'}:
            raise AuthError(422, '渲染仅接受套件、工程和任务编号')
        if not creative_catalog().get('aigcSkillsReady'):
            raise AuthError(404, 'AIGC Skills 本批尚未开放')
        image = os.environ.get('AIGC_RENDER_IMAGE', '')
        if not image or image == 'AIGC_RENDER_IMAGE_REF':
            raise AuthError(503, '隔离渲染镜像尚未配置，请联系管理员')
        suite_id, project_id, job_id = (payload[key] for key in ('suiteId', 'projectId', 'jobId'))
        slot, name = render_address(member_id, suite_id, project_id, job_id)
        memory_operation = 'render:' + name
        memory_target = None
        if memory is not None:
            claim = await asyncio.to_thread(memory.sessions.memory_claim, memory_operation)
            if claim is None:
                # A Job from before the controller was enabled remains the
                # original Job; never create another one to obtain a claim.
                code, previous = await self.request('GET', f'/apis/batch/v1/namespaces/{NAMESPACE}/jobs/{name}')
                if code == 200:
                    self.verify_owner(previous, member_id, suite_id, project_id, job_id)
                    self.bindings.record(member_id, suite_id, project_id, job_id, name)
                    self.bindings.mark_submitted(member_id, suite_id, project_id, job_id)
                    return self.state(previous, job_id)
                if code != 404:
                    raise AuthError(503, '原渲染任务状态未确认，请稍后重试')
                desired = 2 * 1024**3
                minimum = desired if memory_minimum is None else memory_minimum
                if not isinstance(minimum, int) or not 256 * 1024**2 <= minimum <= desired:
                    raise AuthError(503, '渲染内存需求尚未配置')
                try:
                    result = await memory.reserve_job(memory_operation, member_id, name, desired, minimum)
                except AuthError as exc:
                    if exc.status != 503:
                        raise
                    # An unavailable budget observation is not a failed Job.
                    return {'waiting_memory': True, 'retry_after_ms': 2000}
                except (httpx.HTTPError, OSError):
                    return {'waiting_memory': True, 'retry_after_ms': 2000}
                if result['decision'] == 'wait':
                    return {'waiting_memory': True, 'retry_after_ms': 2000}
                if result['decision'] == 'cancelled':
                    return {'jobId': job_id, 'status': 'cancelled',
                            'error': '已取消等待，未创建渲染任务'}
                claim = result['claim']
            if claim['member'] != member_id or claim['kind'] != 'job' or claim['object_name'] != name:
                raise AuthError(403, '渲染内存申请身份不匹配')
            if claim['sent']:
                # A sent or unknown submission is recovered only by reading
                # its original Job. A missing result is never resubmitted.
                code, previous = await self.request('GET', f'/apis/batch/v1/namespaces/{NAMESPACE}/jobs/{name}')
                if code != 200 or not isinstance(previous, dict):
                    raise AuthError(503, '原渲染任务状态未确认，未自动重新提交')
                self.verify_owner(previous, member_id, suite_id, project_id, job_id)
                if not self.memory_target_matches(previous, claim['granted_bytes']):
                    raise AuthError(503, '原渲染任务内存状态未确认，未自动重新提交')
                if not await asyncio.to_thread(memory.sessions.bind_memory_job, memory_operation,
                                               previous['metadata']['uid']):
                    raise AuthError(503, '原渲染任务身份未确认，未自动重新提交')
                if claim['state'] != 'active':
                    await asyncio.to_thread(memory.sessions.record_memory_operation, memory_operation, APPLIED)
                self.bindings.record(member_id, suite_id, project_id, job_id, name)
                self.bindings.mark_submitted(member_id, suite_id, project_id, job_id)
                return self.state(previous, job_id)
            memory_target = claim['granted_bytes']
            if not await asyncio.to_thread(memory.sessions.start_memory_operation, memory_operation,
                                           memory_target, memory_target):
                raise AuthError(503, '渲染内存申请正在准备，请稍后重试')
        # The binding is durable before anything is sent, so an interrupted
        # submit still leaves a record that this member has render work.
        try:
            self.bindings.record(member_id, suite_id, project_id, job_id, name)
        except Exception:
            if memory is not None:
                await asyncio.to_thread(memory.sessions.record_memory_operation, memory_operation, NOT_APPLIED)
            raise
        resource = render_job(member_id, suite_id, project_id, job_id, image, memory_target)
        path = f'/apis/batch/v1/namespaces/{NAMESPACE}/jobs'
        try:
            code, result = await self.request('POST', path, resource)
        except Exception:
            if memory is not None:
                await asyncio.to_thread(memory.sessions.record_memory_operation, memory_operation, UNKNOWN)
            raise
        if code == 409:
            if memory is not None:
                await asyncio.to_thread(memory.sessions.record_memory_operation, memory_operation, NOT_APPLIED)
            self.bindings.mark_submitted(member_id, suite_id, project_id, job_id)
            return await self.status(member_id, suite_id, project_id, job_id)
        try:
            self.verify_owner(result, member_id, suite_id, project_id, job_id)
            if memory is not None and not self.memory_target_matches(result, memory_target):
                raise AuthError(503, '渲染任务内存状态未确认，未自动重新提交')
            if memory is not None and not await asyncio.to_thread(memory.sessions.bind_memory_job,
                    memory_operation, result['metadata']['uid']):
                raise AuthError(503, '渲染任务身份未确认，未自动重新提交')
        except Exception:
            if memory is not None:
                await asyncio.to_thread(memory.sessions.record_memory_operation, memory_operation, UNKNOWN)
            raise
        if memory is not None:
            await asyncio.to_thread(memory.sessions.record_memory_operation, memory_operation, APPLIED)
        self.bindings.mark_submitted(member_id, suite_id, project_id, job_id)
        return self.state(result, job_id)

    async def status(self, member_id, suite_id, project_id, job_id, *, memory=None):
        _, name = render_address(member_id, suite_id, project_id, job_id)
        code, resource = await self.request('GET', f'/apis/batch/v1/namespaces/{NAMESPACE}/jobs/{name}')
        if code == 404:
            if memory is not None:
                operation = 'render:' + name
                waiting = await asyncio.to_thread(memory.sessions.memory_wait, operation, member_id)
                claim = await asyncio.to_thread(memory.sessions.memory_claim, operation)
                # A queue entry or an unsent reservation can be resumed. Once
                # the send right was taken, a missing Job remains unknown.
                resumable = (claim is not None and claim.get('member') == member_id
                             and claim.get('kind') == 'job' and claim.get('resource_id') == name
                             and claim.get('object_name') == name and claim.get('state') == 'reserved'
                             and claim.get('sent') == 0)
                if (waiting and claim is None) or resumable:
                    return {'jobId': job_id, 'status': 'queued', 'waiting_memory': True,
                            'retry_after_ms': 2000}
                if claim is None and not waiting and await asyncio.to_thread(
                        memory.sessions.memory_cancelled, operation, member_id):
                    return {'jobId': job_id, 'status': 'cancelled',
                            'error': '已取消等待，未创建渲染任务'}
            raise AuthError(404, '原渲染任务不存在，未自动重新创建；请检查已有输出')
        self.verify_owner(resource, member_id, suite_id, project_id, job_id)
        return self.state(resource, job_id)

    async def cancel_wait(self, member_id, suite_id, project_id, job_id, *, memory=None):
        """Cancel only a render that is provably not sent to Kubernetes."""
        if memory is None:
            return False
        _, name = render_address(member_id, suite_id, project_id, job_id)
        code, resource = await self.request('GET', f'/apis/batch/v1/namespaces/{NAMESPACE}/jobs/{name}')
        if code == 200:
            self.verify_owner(resource, member_id, suite_id, project_id, job_id)
            return False
        if code != 404:
            raise AuthError(503, '原渲染任务状态未确认，无法取消等待')
        binding = self.bindings.get(member_id, suite_id, project_id, job_id)
        if binding and binding['submitted']:
            return False
        operation = 'render:' + name
        if binding:
            waiting = await asyncio.to_thread(memory.sessions.memory_wait, operation, member_id)
            claim = await asyncio.to_thread(memory.sessions.memory_claim, operation)
            unsent = (claim is not None and claim.get('member') == member_id
                      and claim.get('kind') == 'job' and claim.get('resource_id') == name
                      and claim.get('object_name') == name and claim.get('state') == 'reserved'
                      and claim.get('sent') == 0)
            if not waiting and not unsent:
                # An older unsubmitted binding may hide an unknown send.
                return False
        return await asyncio.to_thread(memory.sessions.cancel_memory_wait, operation, member_id)

    async def member_busy(self, member_id, *, inventory=None, media_store=None, memory=None):
        """Whether this member may still have an unfinished render Job.

        Saved member project records reconcile tasks created before this ledger.
        A complete inventory is required even after an archive was acknowledged:
        an empty new ledger, or a failed later read, cannot prove the member idle.
        Success releases only after both the controlled media and the saved
        business reference exist. Recognition occurs on this coordinator read,
        not an archive callback. Existing Jobs are only read, never resubmitted.
        """
        slot = member_slot(member_id)
        if (not slot or not isinstance(inventory, dict)
                or inventory.get('member_id') != member_id
                or inventory.get('known') is not True
                or not isinstance(inventory.get('jobs'), list)):
            return True
        assets = {}
        for item in inventory['jobs']:
            if not isinstance(item, dict):
                return True
            suite, project, job = (item.get(key) for key in ('suiteId', 'projectId', 'jobId'))
            try:
                _, name = render_address(member_id, suite, project, job)
            except AuthError:
                return True
            self.bindings.record(member_id, suite, project, job, name)
            assets[(suite, project, job)] = item.get('assetId')
        for binding in self.bindings.for_member(member_id):
            # A binding whose product was confirmed archived is the only one
            # that stops counting as work.
            if binding.get('archived'):
                continue
            try:
                code, resource = await self.request(
                    'GET', f'/apis/batch/v1/namespaces/{NAMESPACE}/jobs/{binding["name"]}')
            except (AuthError, httpx.HTTPError, OSError, ValueError):
                # The Job could not be read, so whether it finished is unknown.
                return True
            if code == 404:
                if (memory is not None and not binding['submitted']
                        and await asyncio.to_thread(memory.sessions.memory_cancelled,
                                                    'render:' + binding['name'], member_id)
                        and not await asyncio.to_thread(memory.sessions.memory_claim,
                                                        'render:' + binding['name'])):
                    # A persisted cancellation proves this unsubmitted queue
                    # item never obtained a send right.
                    if self.bindings.discard_unsubmitted(member_id, binding['suite'],
                                                         binding['project'], binding['job']):
                        continue
                # The Job is gone, but a missing Job does not prove the task
                # ended: it may have been collected before its product was
                # archived, so the binding stays unconfirmed and the member
                # stays busy until an operator reconciles the ledger.
                return True
            if code != 200 or not isinstance(resource, dict):
                return True
            try:
                self.verify_owner(resource, member_id, binding['suite'], binding['project'], binding['job'])
            except AuthError:
                return True
            self.bindings.mark_submitted(member_id, binding['suite'], binding['project'], binding['job'])
            status = self.state(resource, binding['job'])['status']
            if status in {'running', 'pending'}:
                return True
            # Succeeded but not yet archived is still work: the product has to
            # reach the member's durable store before the binding releases.
            if status == 'succeeded':
                asset_id = assets.get((binding['suite'], binding['project'], binding['job']))
                if not isinstance(asset_id, str) or not asset_id or media_store is None:
                    return True
                try:
                    asset = media_store.get(asset_id)
                except (AuthError, sqlite3.Error, OSError, ValueError):
                    return True
                if asset.get('owner_id') != member_id or asset.get('state') != 'ready':
                    return True
                self.bindings.mark_archived(member_id, binding['suite'], binding['project'], binding['job'])
        return False

    async def read_deployment(self, member_id):
        """Read one fixed member Deployment by name, with its resourceVersion.

        Only a named GET is used: the Role grants no list, and the labels a
        selector would match live on the Pod template rather than on the
        Deployment metadata. An unreadable Deployment raises ScaleOutcome
        NOT_APPLIED so the caller leaves the member exactly as it was instead
        of guessing a replica count.
        """
        slot = member_slot(member_id)
        if not slot:
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境未配置，未执行伸缩')
        try:
            code, resource = await self.request(
                'GET', f'/apis/apps/v1/namespaces/{NAMESPACE}/deployments/greenroom-dsh-{slot}')
        except AuthError as exc:
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境状态未确认，未执行伸缩：' + exc.message) from exc
        except (httpx.HTTPError, OSError, ValueError) as exc:
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境状态未确认，未执行伸缩：' + str(exc)) from exc
        if code != 200 or not isinstance(resource, dict):
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境状态未确认，未执行伸缩')
        return resource

    async def scale_deployment(self, member_id, replicas, resource_version):
        """Scale one fixed member Deployment through its scale subresource.

        Returns the confirmed replica count on APPLIED. Everything else raises
        ScaleOutcome carrying the classification: a validation or read failure
        before the PATCH was sent, or an explicit API rejection such as
        404/409, is NOT_APPLIED; a timeout, a dropped connection, a 5xx, or a
        success body that does not confirm the target is UNKNOWN. The caller
        settles its own operation from that and never resends on its own.
        """
        slot = member_slot(member_id)
        if not slot:
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境未配置，未执行伸缩')
        if not isinstance(resource_version, str) or not resource_version:
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境版本未确认，未执行伸缩')
        try:
            code, resource = await self.request(
                'PATCH', f'/apis/apps/v1/namespaces/{NAMESPACE}/deployments/greenroom-dsh-{slot}/scale',
                content_type='application/merge-patch+json',
                payload={'metadata': {'resourceVersion': resource_version}, 'spec': {'replicas': replicas}})
        except AuthError as exc:
            # The PATCH was sent; whether the API server applied it is not
            # knowable from this side, so the outcome stays UNKNOWN.
            raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩结果未知：' + exc.message) from exc
        except (httpx.HTTPError, OSError, ValueError) as exc:
            raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩结果未知：' + str(exc)) from exc
        if code in {404, 409}:
            # The API server explicitly refused this patch, so it was not sent.
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境伸缩未生效，未自动重发')
        if code != 200 or not isinstance(resource, dict):
            # The PATCH was accepted but the body cannot be read as an object.
            raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩回执无法解析')
        spec = resource.get('spec')
        if not isinstance(spec, dict):
            raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩回执无法确认副本数')
        confirmed = spec.get('replicas')
        if confirmed is None and replicas == 0 and spec == {}:
            # K3s may omit the zero-valued ScaleSpec.replicas field. The PATCH
            # was already sent: do not resend it or infer success from the
            # status replica count. Confirm the desired replicas by reading the
            # same named Deployment instead.
            metadata = resource.get('metadata')
            if (resource.get('kind') != 'Scale' or resource.get('apiVersion') != 'autoscaling/v1'
                    or not isinstance(metadata, dict) or metadata.get('name') != f'greenroom-dsh-{slot}'
                    or metadata.get('namespace') != NAMESPACE
                    or not isinstance(metadata.get('resourceVersion'), str)
                    or not metadata['resourceVersion']):
                raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩回执无法确认副本数')
            try:
                deployment = await self.read_deployment(member_id)
            except ScaleOutcome as exc:
                raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩结果暂未确认') from exc
            deployment_spec = deployment.get('spec')
            confirmed = deployment_spec.get('replicas') if isinstance(deployment_spec, dict) else None
        if type(confirmed) is not int or confirmed < 0:
            raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩回执无法确认副本数')
        if confirmed != replicas:
            raise ScaleOutcome(UNKNOWN, '成员运行环境伸缩回执与目标副本不一致')
        return confirmed
