"""Node-budgeted member memory claims and in-place Pod resize."""

import asyncio
import json
import os
import re
import socket
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING
from urllib.parse import urlencode

import aiohttp
import httpx

from app.creative.creative_render import APPLIED, NOT_APPLIED, UNKNOWN, NAMESPACE, member_slot
from app.identity.auth import AuthError


def memory_bytes(value):
    match = re.fullmatch(r'([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([numkKMGTPE]|Ki|Mi|Gi|Ti|Pi|Ei)?', str(value))
    if not match:
        raise ValueError('Invalid Kubernetes memory quantity')
    factors = {'': 1, 'n': Decimal('0.000000001'), 'u': Decimal('0.000001'),
               'm': Decimal('0.001'), 'k': 1000, 'K': 1000, 'M': 1000**2,
               'G': 1000**3, 'T': 1000**4, 'P': 1000**5, 'E': 1000**6,
               'Ki': 1024, 'Mi': 1024**2, 'Gi': 1024**3, 'Ti': 1024**4,
               'Pi': 1024**5, 'Ei': 1024**6}
    number = Decimal(match.group(1)) * factors[match.group(2) or '']
    return int(number.to_integral_value(rounding=ROUND_CEILING))


def _container_request(container, status):
    desired = container.get('resources', {}).get('requests', {}).get('memory', '0')
    actual = status.get('resources', {}).get('requests', {}).get('memory', '0')
    allocated = status.get('allocatedResources', {}).get('memory', '0')
    return max(memory_bytes(desired), memory_bytes(actual), memory_bytes(allocated))


def pod_request(pod):
    spec, status = pod.get('spec', {}), pod.get('status', {})
    regular_status = {item.get('name'): item for item in status.get('containerStatuses', [])}
    init_status = {item.get('name'): item for item in status.get('initContainerStatuses', [])}
    regular = sum(_container_request(item, regular_status.get(item.get('name'), {}))
                  for item in spec.get('containers', []))
    sidecars = 0
    init_peak = 0
    for item in spec.get('initContainers', []):
        request = _container_request(item, init_status.get(item.get('name'), {}))
        if item.get('restartPolicy') == 'Always':
            sidecars += request
            init_peak = max(init_peak, sidecars)
        else:
            init_peak = max(init_peak, sidecars + request)
    pod_level = memory_bytes(spec.get('resources', {}).get('requests', {}).get('memory', '0'))
    return max(regular + sidecars, init_peak, pod_level) + memory_bytes(spec.get('overhead', {}).get('memory', '0'))


def _fresh(item, max_age):
    try:
        stamp = datetime.fromisoformat(item['timestamp'].replace('Z', '+00:00'))
        age = (datetime.now(timezone.utc) - stamp).total_seconds()
    except (KeyError, TypeError, ValueError):
        return False
    return -10 <= age <= max_age


def _host_memory_used(node, pods, namespace, node_name, allocatable):
    """Read memory pressure only when /proc belongs to the budgeted node."""
    if node.get('metadata', {}).get('name') != node_name:
        raise ValueError('Node identity mismatch')
    conditions = node.get('status', {}).get('conditions', [])
    pressure = [item for item in conditions if item.get('type') == 'MemoryPressure']
    if len(pressure) != 1 or pressure[0].get('status') != 'False':
        raise ValueError('Node memory pressure is not confirmed clear')
    local = [pod for pod in pods if pod.get('metadata', {}).get('namespace') == namespace
             and pod.get('metadata', {}).get('name') == socket.gethostname()]
    if (len(local) != 1 or local[0].get('spec', {}).get('nodeName') != node_name
            or local[0].get('metadata', {}).get('labels', {}).get('app.kubernetes.io/name') != 'greenroom-web'
            or local[0].get('metadata', {}).get('deletionTimestamp')
            or local[0].get('status', {}).get('phase') != 'Running'):
        raise ValueError('Local web Pod node is not confirmed')
    capacity = memory_bytes(node['status']['capacity']['memory'])
    values = {}
    with open('/proc/meminfo', encoding='ascii') as source:
        for line in source:
            key = line.split(':', 1)[0]
            if key not in {'MemTotal', 'MemAvailable'}:
                continue
            match = re.fullmatch(r'(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*', line)
            if not match or key in values:
                raise ValueError('Invalid node memory information')
            values[key] = int(match.group(2)) * 1024
    total, available = values['MemTotal'], values['MemAvailable']
    if total <= 0 or total != capacity or not 0 <= available <= total or allocatable > capacity:
        raise ValueError('Node memory capacity mismatch')
    return total - available


def _container_resources(pod, name):
    containers = [item for item in pod.get('spec', {}).get('containers', []) if item.get('name') == name]
    if len(containers) != 1:
        raise AuthError(503, '成员容器状态未确认，请稍后重试')
    values = containers[0].get('resources', {})
    try:
        request = memory_bytes(values['requests']['memory'])
        limit = memory_bytes(values['limits']['memory'])
    except (KeyError, ValueError, TypeError):
        raise AuthError(503, '成员容器内存配置未确认，请稍后重试')
    if request <= 0 or limit < request:
        raise AuthError(503, '成员容器内存配置未确认，请稍后重试')
    return request, limit


def _container_limit(pod, name):
    _, desired = _container_resources(pod, name)
    statuses = [item for item in pod.get('status', {}).get('containerStatuses', []) if item.get('name') == name]
    if len(statuses) != 1:
        raise AuthError(503, '成员容器状态未确认，请稍后重试')
    try:
        actual = memory_bytes(statuses[0]['resources']['limits']['memory'])
    except (KeyError, TypeError, ValueError):
        raise AuthError(503, '成员容器内存状态未确认，请稍后重试')
    return max(desired, actual)


def _pod_limit(pod, *, template=False):
    """Account each live member container's limit, including resize in flight."""
    spec, status = pod.get('spec', {}), pod.get('status', {})
    containers = spec.get('containers', [])
    if not containers or spec.get('resources'):
        raise ValueError('Invalid member Pod resources')
    values = {}
    for container in containers:
        name = container['name']
        if name in values:
            raise ValueError('Duplicate member container')
        limit = memory_bytes(container['resources']['limits']['memory'])
        if limit <= 0:
            raise ValueError('Missing member limit')
        values[name] = limit if template else _container_limit(pod, name)
    total = sum(values.values())
    init_status = {item.get('name'): item for item in status.get('initContainerStatuses', [])}
    for container in spec.get('initContainers', []):
        state = init_status.get(container.get('name'), {}).get('state', {})
        if not template and state.get('terminated') is not None:
            continue
        limit = memory_bytes(container['resources']['limits']['memory'])
        if limit <= 0 or container.get('restartPolicy') == 'Always':
            raise ValueError('Unbounded member init container')
        total = max(total, limit)
    total += memory_bytes(spec.get('overhead', {}).get('memory', '0'))
    return total, values


def _container_instance(pod, name):
    statuses = [item for item in pod.get('status', {}).get('containerStatuses', []) if item.get('name') == name]
    if len(statuses) != 1 or not statuses[0].get('containerID') or not isinstance(statuses[0].get('restartCount'), int):
        return None
    return statuses[0]['containerID'], statuses[0]['restartCount']


def resize_confirmed(pod, uid, container, request_bytes, limit_bytes, generation=0):
    """Confirm desired and actual resources for every regular container."""
    metadata, status = pod.get('metadata', {}), pod.get('status', {})
    current_generation = metadata.get('generation')
    observed_generation = status.get('observedGeneration')
    if (metadata.get('uid') != uid or not isinstance(current_generation, int)
            or not isinstance(observed_generation, int)
            or observed_generation < max(current_generation, generation)
            or status.get('resize') in {'Proposed', 'InProgress', 'Deferred', 'Infeasible'}
            or any(item.get('status') == 'True' and item.get('type') in {'PodResizePending', 'PodResizeInProgress'}
                   for item in status.get('conditions', []))):
        return False
    containers = pod.get('spec', {}).get('containers', [])
    actual = {item.get('name'): item for item in status.get('containerStatuses', [])}
    if not containers or len(actual) != len(containers) or container not in actual:
        return False
    try:
        for item in containers:
            name = item['name']
            spec_values = item['resources']
            live_values = actual[name]['resources']
            for kind in ('requests', 'limits'):
                if memory_bytes(spec_values[kind]['memory']) != memory_bytes(live_values[kind]['memory']):
                    return False
        return _container_resources(pod, container) == (request_bytes, limit_bytes)
    except (AuthError, KeyError, TypeError, ValueError):
        return False


def core_ready(pod):
    """Observed core probes and effective resources, never a desired replica count."""
    meta, status = pod.get('metadata', {}), pod.get('status', {})
    if (not meta.get('uid') or meta.get('deletionTimestamp') or status.get('phase') != 'Running'
            or not any(row.get('type') == 'Ready' and row.get('status') == 'True'
                       for row in status.get('conditions', []))):
        return False
    statuses = {row.get('name'): row for row in status.get('containerStatuses', [])}
    for name in ('dsh', 'connector', 'canvas'):
        row = statuses.get(name, {})
        if row.get('ready') is not True or row.get('state', {}).get('running') is None:
            return False
    try:
        request, limit = _container_resources(pod, 'dsh')
        return resize_confirmed(pod, meta['uid'], 'dsh', request, limit)
    except (AuthError, KeyError, TypeError, ValueError):
        return False


def resident_summary(snapshot, inventory, target):
    """Read-only totals. Starting/unknown commitments never masquerade as Ready."""
    if not isinstance(target, int) or isinstance(target, bool) or target < 0:
        raise ValueError('Member resident target must be a non-negative integer')
    result = {'target_ready_members': target, 'mode': 'observe_only', 'refill_enabled': False,
              'next_action': 'none', 'blocked_reason': 'startup_recovery_not_isolated',
              'ready_members': None, 'starting_members': None, 'unready_members': None,
              'resident_or_reserved_members': None, 'deficit': None}
    if snapshot is None:
        result['blocked_reason'] = 'observation_unavailable'
        return result
    ready, starting, occupied = set(), set(), set()
    for member, pods in snapshot['member_pods'].items():
        records = inventory.get(member, {})
        entry, runtime = records.get('entry') or {}, records.get('runtime') or {}
        pending = any(runtime.get(key) for key in ('wake', 'scale', 'reopen'))
        if pods or entry.get('state') in {'starting', 'active', 'retiring'} or pending:
            occupied.add(member)
        if entry.get('state') == 'starting' or runtime.get('state') == 'starting' or runtime.get('wake'):
            starting.add(member)
            occupied.add(member)
        if (len(pods) == 1 and pods[0].get('core_ready') is True
                and entry.get('state') == 'active' and entry.get('pod_uid') == pods[0]['uid']
                and runtime.get('state') == 'ready' and runtime.get('observed') == 1
                and runtime.get('replicas') == 1 and not pending):
            ready.add(member)
    result.update(ready_members=len(ready), starting_members=len(starting),
                  unready_members=len(occupied - ready - starting),
                  resident_or_reserved_members=len(occupied), deficit=max(0, target-len(ready)))
    if target == 0:
        result['blocked_reason'] = 'target_disabled'
    return result


class MemberMemory:
    def __init__(self, sessions, kube, slots, *, namespace=NAMESPACE, metrics_max_age=90):
        self.sessions = sessions
        self.kube = kube
        self.slots = slots or {}
        self.namespace = namespace
        self.metrics_max_age = metrics_max_age

    async def _get(self, path):
        code, result = await self.kube.request('GET', path)
        if code != 200 or not isinstance(result, dict):
            raise AuthError(503, '节点内存状态未确认，请稍后重试')
        return result

    async def resident_status(self, target):
        """Observe only: no wake, prewarm, resize or recovery call is reachable here."""
        try:
            if not self.slots or not self.sessions.memory_active():
                result = resident_summary(None, {}, target)
                result['blocked_reason'] = 'memory_admission_inactive'
                return result
            snapshot, _ = await self.snapshot(next(iter(self.slots)), include_core_ready=True)
            inventory = await asyncio.to_thread(self.sessions.resident_inventory)
            return resident_summary(snapshot, inventory, target)
        except (AuthError, OSError, sqlite3.Error, AttributeError, KeyError, TypeError, ValueError,
                httpx.HTTPError, aiohttp.ClientError):
            return resident_summary(None, {}, target)

    async def resident(self, member, *, require_ready=False):
        """Read the exact already-running Pod for a verified legacy session."""
        slot = member_slot(member) if member in self.slots else None
        if not slot:
            raise AuthError(403, '成员运行环境未配置')
        path = '/api/v1/namespaces/' + self.namespace + '/pods?'
        result = await self._get(path + urlencode({'labelSelector': 'app=greenroom-dsh-' + slot}))
        pods = result.get('items', [])
        if (len(pods) != 1 or pods[0].get('status', {}).get('phase') != 'Running'
                or pods[0].get('metadata', {}).get('deletionTimestamp')
                or pods[0].get('spec', {}).get('nodeName') != os.environ.get('GREENROOM_NODE_NAME', '').strip()):
            raise AuthError(503, '成员运行环境状态未确认，请稍后重试')
        if require_ready and not any(item.get('type') == 'Ready' and item.get('status') == 'True'
                                     for item in pods[0].get('status', {}).get('conditions', [])):
            raise AuthError(503, '成员运行环境正在准备，请稍后重试')
        try:
            cap, _ = _pod_limit(pods[0])
            meta = pods[0]['metadata']
            return meta['uid'], meta['name'], cap
        except (KeyError, TypeError, ValueError):
            raise AuthError(503, '成员运行环境内存未确认，请稍后重试')

    async def reconcile_replacement(self, member, expected_uid=None):
        entry = await asyncio.to_thread(self.sessions.entry, member)
        if not entry or entry['state'] != 'active' or not entry['pod_uid']:
            return False
        uid, name, cap = await self.resident(member, require_ready=True)
        if expected_uid is not None and uid != expected_uid:
            return False
        if uid == entry['pod_uid']:
            return True
        deployment = await self.kube.read_deployment(member)
        try:
            template_cap, _ = _pod_limit({'spec': deployment['spec']['template']['spec']}, template=True)
        except (KeyError, TypeError, ValueError):
            return False
        return await asyncio.to_thread(self.sessions.rebind_entry, member, entry['pod_uid'], uid, name,
                                       max(cap, template_cap))

    async def startup_failure(self, member):
        slot = member_slot(member) if member in self.slots else None
        if not slot:
            return None
        path = '/api/v1/namespaces/' + self.namespace + '/pods?'
        result = await self._get(path + urlencode({'labelSelector': 'app=greenroom-dsh-' + slot}))
        pods = result.get('items', [])
        if len(pods) != 1:
            return None
        pod = pods[0]
        if pod.get('metadata', {}).get('deletionTimestamp'):
            return None
        for status in pod.get('status', {}).get('initContainerStatuses', []):
            current = status.get('state', {})
            failed = current.get('terminated')
            if failed is None and current.get('waiting', {}).get('reason') == 'CrashLoopBackOff':
                failed = status.get('lastState', {}).get('terminated')
            if isinstance(failed, dict) and isinstance(failed.get('exitCode'), int) and failed['exitCode'] != 0:
                uid = pod.get('metadata', {}).get('uid')
                if uid:
                    detail = ('工作台初始化内存不足，正在安全回收，请稍后重试' if failed.get('reason') == 'OOMKilled'
                              else '工作台初始化失败，正在安全回收，请稍后重试')
                    return uid, detail
        return None

    async def reconcile_retirement(self, member):
        """Finish scale-to-zero and a paused template without repeating a PATCH."""
        slot = member_slot(member) if member in self.slots else None
        if not slot:
            return False
        deployment = await self.kube.read_deployment(member)
        meta, spec = deployment.get('metadata', {}), deployment.get('spec', {})
        uid, version, generation = meta.get('uid'), meta.get('resourceVersion'), meta.get('generation')
        if (not isinstance(uid, str) or not uid or not isinstance(version, str) or not version
                or not isinstance(generation, int) or spec.get('replicas') != 0):
            return False
        observed = deployment.get('status', {}).get('observedGeneration', 0)
        status_replicas = deployment.get('status', {}).get('replicas', 0)
        if (not isinstance(observed, int) or observed < generation
                or not isinstance(status_replicas, int) or status_replicas != 0):
            return False
        path = '/api/v1/namespaces/' + self.namespace + '/pods?'
        pods = await self._get(path + urlencode({'labelSelector': 'app=greenroom-dsh-' + slot}))
        if not isinstance(pods.get('items'), list) or pods['items']:
            return False
        marker = await asyncio.to_thread(self.sessions.unpause, member)
        if spec.get('paused', False):
            if marker is not None:
                return False
            if not await asyncio.to_thread(self.sessions.begin_unpause, member, uid, version, generation):
                return False
            patch = [{'op': 'test', 'path': '/metadata/uid', 'value': uid},
                     {'op': 'test', 'path': '/metadata/resourceVersion', 'value': version},
                     {'op': 'replace', 'path': '/spec/paused', 'value': False}]
            target = '/apis/apps/v1/namespaces/' + self.namespace + '/deployments/greenroom-dsh-' + slot
            try:
                code, _ = await self.kube.request('PATCH', target, patch,
                                                  content_type='application/json-patch+json', return_statuses=(422,))
            except (AuthError, httpx.HTTPError, OSError, ValueError):
                return False
            if code in {404, 409, 422}:
                await asyncio.to_thread(self.sessions.reject_unpause, member, uid, version)
            return False
        try:
            template_bytes, _ = _pod_limit({'spec': spec['template']['spec']}, template=True)
        except (KeyError, TypeError, ValueError):
            return False
        # No wake can start while the retiring lease or unpause marker exists.
        return await asyncio.to_thread(self.sessions.finish_retirement, member, uid, generation, template_bytes)

    async def snapshot(self, member, *, include_core_ready=False):
        """Account live member limits and reserve sleeping templates only on entry."""
        if member not in self.slots:
            raise AuthError(403, '成员运行环境未配置')
        names = {}
        for item in self.slots:
            slot = member_slot(item)
            if not slot:
                raise AuthError(503, '成员运行环境配置未确认')
            names['greenroom-dsh-' + slot] = item
        namespace_path = '/api/v1/namespaces/' + self.namespace
        first = await self._get(namespace_path + '/pods?' + urlencode({'labelSelector': 'greenroom-component=runtime'}))
        if not isinstance(first.get('items'), list):
            raise AuthError(503, '成员运行环境状态未确认，请稍后重试')
        candidates = [pod for pod in first.get('items', [])
                      if pod.get('metadata', {}).get('labels', {}).get('app') in names]
        node_name = os.environ.get('GREENROOM_NODE_NAME', '').strip()
        if (not node_name or any(pod.get('spec', {}).get('nodeName') != node_name for pod in candidates)):
            raise AuthError(503, '成员运行节点状态未确认，请稍后重试')
        node, node_metrics, pods, metrics, *deployments = await asyncio.gather(
            self._get('/api/v1/nodes/' + node_name),
            self._get('/apis/metrics.k8s.io/v1beta1/nodes/' + node_name),
            self._get('/api/v1/pods?' + urlencode({'fieldSelector': 'spec.nodeName=' + node_name})),
            self._get('/apis/metrics.k8s.io/v1beta1/pods'),
            *(self.kube.read_deployment(item) for item in self.slots))
        try:
            allocatable = memory_bytes(node['status']['allocatable']['memory'])
            if allocatable <= 0 or not _fresh(node_metrics, self.metrics_max_age):
                raise ValueError()
            # Validate the metric even though reclaimable host cache is not
            # charged as fixed non-Pod usage.
            memory_bytes(node_metrics['usage']['memory'])
            physical_used = _host_memory_used(node, pods['items'], self.namespace, node_name, allocatable)
            targets = json.loads(os.environ.get('MEMBER_MEMORY_TARGETS', '{}'))
            minimums = json.loads(os.environ.get('MEMBER_MEMORY_MINIMUMS', '{}'))
            if not isinstance(targets, dict) or not targets or not isinstance(minimums, dict):
                raise ValueError('Missing plugin memory targets')
            render_minimum = memory_bytes(os.environ.get('MEMBER_MEMORY_RENDER_MINIMUM', '2Gi'))
            if not 256 * 1024**2 <= render_minimum <= 2 * 1024**3:
                raise ValueError('Invalid render minimum')
            work_headroom = render_minimum
            templates, base_requests, base_limits = {}, {}, {}
            for item, deployment in zip(self.slots, deployments):
                spec = deployment['spec']['template']['spec']
                metadata = deployment['metadata']
                generation = metadata['generation']
                observed = deployment.get('status', {}).get('observedGeneration', 0)
                if not isinstance(generation, int) or not isinstance(observed, int):
                    raise ValueError()
                try:
                    cap, _ = _pod_limit({'spec': spec}, template=True)
                except (KeyError, TypeError, ValueError):
                    cap = 0
                templates[item] = {'bytes': cap, 'paused': deployment['spec'].get('paused', False),
                                   'observed': observed >= generation}
                for container in spec.get('containers', []):
                    base_requests[(item, container['name'])] = memory_bytes(
                        container.get('resources', {}).get('requests', {}).get('memory', '0'))
                    base_limits[(item, container['name'])] = memory_bytes(
                        container.get('resources', {}).get('limits', {}).get('memory', '0'))
                for plugin, target in targets.items():
                    desired = memory_bytes(target)
                    minimum = memory_bytes(minimums.get(plugin, target))
                    base = base_limits.get((item, plugin), 0)
                    if not base or not 0 < minimum <= desired:
                        raise ValueError('Invalid plugin memory target')
                    work_headroom = max(work_headroom, max(0, minimum - base))
            measured = {(item['metadata']['namespace'], item['metadata']['name']): item
                        for item in metrics['items']}
            member_pods = {item: [] for item in self.slots}
            container_usage, requests, job_uids = {}, {}, {}
            other_committed = member_committed = 0
            found_target = None
            found_uids = set()
            for pod in pods['items']:
                meta, spec, status = pod['metadata'], pod['spec'], pod.get('status', {})
                app = meta.get('labels', {}).get('app')
                owner = (names.get(app) if meta.get('namespace') == self.namespace
                         and meta.get('labels', {}).get('greenroom-component') == 'runtime' else None)
                if owner is None and status.get('phase') in {'Succeeded', 'Failed'}:
                    continue
                request = pod_request(pod)
                sample = measured.get((meta['namespace'], meta['name']))
                statuses = status.get('containerStatuses', []) + status.get('initContainerStatuses', [])
                running = {item['name'] for item in statuses if item.get('state', {}).get('running') is not None}
                if sample is None and status.get('phase') in {'Pending', 'Succeeded', 'Failed'} and not running:
                    values = {}
                else:
                    if not isinstance(sample, dict) or not _fresh(sample, self.metrics_max_age):
                        raise ValueError('Missing Pod metrics')
                    values = {item['name']: memory_bytes(item['usage']['memory']) for item in sample['containers']}
                    required = running or {item['name'] for item in spec.get('containers', [])}
                    if not required.issubset(values):
                        raise ValueError('Incomplete Pod metrics')
                working = sum(values.values())
                if owner is None:
                    other_committed += max(request, working)
                    if meta.get('namespace') == self.namespace:
                        for ref in meta.get('ownerReferences', []):
                            if ref.get('kind') == 'Job' and ref.get('name'):
                                key = ('job', ref['name'], '')
                                requests[key] = requests.get(key, 0) + request
                                job_uids.setdefault(ref['name'], set()).add(ref.get('uid'))
                    continue
                uid = meta['uid']
                found_uids.add(uid)
                cap, limits = _pod_limit(pod)
                member_pods[owner].append({'uid': uid, 'name': meta['name'], 'bytes': cap})
                if include_core_ready:
                    member_pods[owner][-1]['core_ready'] = core_ready(pod)
                member_committed += max(cap, working)
                for name, limit in limits.items():
                    requests[('container', uid, name)] = limit
                container_usage.update({(uid, name): value for name, value in values.items()})
                if (owner == member and status.get('phase') == 'Running'
                        and not meta.get('deletionTimestamp')):
                    if found_target is not None:
                        raise ValueError('Multiple target Pods')
                    found_target = pod
            if {pod['metadata']['uid'] for pod in candidates} != found_uids:
                raise ValueError('Member Pod inventory changed')
            # physical_used includes current Pod usage. Deliberately count the
            # full commitments too: Pod working sets and MemAvailable use
            # different cache definitions and cannot be safely subtracted.
            used = physical_used + other_committed + member_committed
        except (KeyError, TypeError, ValueError, OSError, AuthError):
            raise AuthError(503, '节点内存状态未确认，请稍后重试')
        return {'allocatable_bytes': allocatable, 'used_bytes': used, 'requests': requests,
                'member_pods': member_pods, 'templates': templates,
                'base_requests': base_requests, 'base_limits': base_limits,
                'work_headroom': work_headroom, 'container_usage': container_usage,
                'job_uids': {name: next(iter(uids)) if len(uids) == 1 else None
                             for name, uids in job_uids.items()}}, found_target

    async def reserve_container(self, operation, member, container, desired_bytes, minimum_bytes=None, *, expected_uid=None):
        snapshot, pod = await self.snapshot(member)
        if pod is None:
            raise AuthError(503, '成员运行环境状态未确认，请稍后重试')
        current_limit = _container_limit(pod, container)
        metadata = pod['metadata']
        if expected_uid is not None and metadata.get('uid') != expected_uid:
            raise AuthError(403, '成员运行环境身份不匹配')
        desired_bytes = max(desired_bytes, current_limit)
        minimum = desired_bytes if minimum_bytes is None else max(minimum_bytes, current_limit)
        return await asyncio.to_thread(self.sessions.reserve_memory, operation, member, 'container',
                                       metadata['uid'], container, metadata['name'], minimum, desired_bytes, snapshot)

    async def reserve_job(self, operation, member, job_name, desired_bytes, minimum_bytes=None):
        minimum = desired_bytes if minimum_bytes is None else minimum_bytes
        queued = await asyncio.to_thread(self.sessions.queue_job_wait, operation, member, job_name, minimum, desired_bytes)
        if queued['decision'] != 'wait':
            return queued
        snapshot, _ = await self.snapshot(member)
        return await asyncio.to_thread(self.sessions.reserve_memory, operation, member, 'job',
                                       job_name, '', job_name, minimum, desired_bytes, snapshot)

    async def apply_container(self, operation):
        """Increase only after the existing container limit is fully reserved."""
        claim = await asyncio.to_thread(self.sessions.memory_claim, operation)
        if claim is None or claim['kind'] != 'container' or claim['state'] == 'reclaiming':
            return {'decision': 'wait'}
        path = '/api/v1/namespaces/' + self.namespace + '/pods/' + claim['object_name']
        try:
            code, pod = await self.kube.request('GET', path)
        except (AuthError, httpx.HTTPError, OSError, ValueError):
            return {'decision': 'wait'}
        if code != 200 or not isinstance(pod, dict) or pod.get('metadata', {}).get('uid') != claim['resource_id']:
            if not claim['sent']:
                await asyncio.to_thread(self.sessions.cancel_memory_reservation, operation)
            return {'decision': 'wait'}
        try:
            effective_limit = _container_limit(pod, claim['resource_name'])
        except AuthError:
            return {'decision': 'wait'}
        if effective_limit > claim['granted_bytes']:
            if claim['sent']:
                await asyncio.to_thread(self.sessions.account_memory_limit, operation, claim['resource_id'], effective_limit)
            else:
                await asyncio.to_thread(self.sessions.cancel_memory_reservation, operation)
            return {'decision': 'wait'}
        if claim['sent']:
            if (claim['target_request'] and resize_confirmed(pod, claim['resource_id'], claim['resource_name'],
                    claim['target_request'], claim['target_limit'], claim['generation'])):
                if claim['state'] != 'active':
                    await asyncio.to_thread(self.sessions.record_memory_operation, operation, APPLIED,
                                            pod['metadata']['generation'])
                return {'decision': 'applied', 'granted_bytes': claim['granted_bytes']}
            return {'decision': 'wait'}
        request, limit = _container_resources(pod, claim['resource_name'])
        if not resize_confirmed(pod, claim['resource_id'], claim['resource_name'], request, limit):
            return {'decision': 'wait'}
        target_request = max(request, claim['granted_bytes'])
        target_limit = max(limit, target_request)
        if not await asyncio.to_thread(self.sessions.start_memory_operation, operation, target_request, target_limit):
            return {'decision': 'wait'}
        if (target_request, target_limit) == (request, limit):
            await asyncio.to_thread(self.sessions.record_memory_operation, operation, APPLIED, pod['metadata']['generation'])
            return {'decision': 'applied', 'granted_bytes': claim['granted_bytes']}
        payload = {'metadata': {'resourceVersion': pod['metadata']['resourceVersion']},
                   'spec': {'containers': [{'name': claim['resource_name'], 'resources': {
                       'requests': {'memory': str(target_request)}, 'limits': {'memory': str(target_limit)}}}]}}
        try:
            code, result = await self.kube.request('PATCH', path + '/resize', payload,
                                                   content_type='application/strategic-merge-patch+json')
        except (AuthError, httpx.HTTPError, OSError, ValueError):
            await asyncio.to_thread(self.sessions.record_memory_operation, operation, UNKNOWN)
            return {'decision': 'wait'}
        if code in {404, 409}:
            await asyncio.to_thread(self.sessions.record_memory_operation, operation, NOT_APPLIED)
            return {'decision': 'wait'}
        generation = result.get('metadata', {}).get('generation', 0) if isinstance(result, dict) else 0
        generation = generation if isinstance(generation, int) else 0
        await asyncio.to_thread(self.sessions.record_memory_operation, operation, UNKNOWN, generation)
        for _ in range(5):
            result = await self.apply_container(operation)
            if result['decision'] == 'applied':
                return result
            await asyncio.sleep(1)
        return {'decision': 'wait'}

    async def reconcile_reclaim(self, operation, sleep):
        """Read an interrupted shrink; never resend an uncertain PATCH."""
        claim = await asyncio.to_thread(self.sessions.memory_claim, operation)
        if claim is None or claim['state'] != 'reclaiming':
            return False
        if not claim['sent']:
            if await asyncio.to_thread(self.sessions.cancel_memory_reclaim, operation):
                await sleep._abandon(claim['member'], claim['reclaim_epoch'])
            return False
        path = '/api/v1/namespaces/' + self.namespace + '/pods/' + claim['object_name']
        try:
            code, pod = await self.kube.request('GET', path)
        except (AuthError, httpx.HTTPError, OSError, ValueError):
            return False
        if (code != 200 or not isinstance(pod, dict)
                or not resize_confirmed(pod, claim['resource_id'], claim['resource_name'],
                                        claim['reclaim_request'], claim['reclaim_limit'])):
            return False
        if await asyncio.to_thread(self.sessions.record_memory_reclaim, operation, APPLIED):
            await sleep._abandon(claim['member'], claim['reclaim_epoch'])
            return True
        return False

    async def retire_replaced_container(self, operation, sleep):
        """Reconcile a vanished Pod after its replacement is fully observable."""
        claim = await asyncio.to_thread(self.sessions.memory_claim, operation)
        if claim is None or claim['kind'] != 'container':
            return False
        path = '/api/v1/namespaces/' + self.namespace + '/pods/' + claim['object_name']
        try:
            code, old = await self.kube.request('GET', path)
            if code == 200:
                if not isinstance(old, dict):
                    return False
                if (old.get('metadata', {}).get('uid') == claim['resource_id']
                        and old.get('status', {}).get('phase') not in {'Succeeded', 'Failed'}):
                    return False
            elif code != 404:
                return False
            snapshot, replacement = await self.snapshot(claim['member'])
            if (replacement is None or replacement.get('metadata', {}).get('uid') == claim['resource_id']
                    or ('container', claim['resource_id'], claim['resource_name']) in snapshot['requests']):
                return False
        except (AuthError, httpx.HTTPError, OSError, KeyError, TypeError, ValueError):
            return False
        if not await asyncio.to_thread(self.sessions.retire_memory_container, operation, claim['resource_id']):
            return False
        if claim['state'] == 'reclaiming':
            await sleep._abandon(claim['member'], claim['reclaim_epoch'])
        return True

    async def _plugin_pod_absent(self, marker):
        slot = member_slot(marker['member'])
        if not slot:
            return False
        path = '/api/v1/namespaces/' + self.namespace + '/pods?'
        result = await self._get(path + urlencode({'labelSelector': 'app=greenroom-dsh-' + slot}))
        items = result.get('items')
        return (isinstance(items, list)
                and all(isinstance(item, dict) and item.get('metadata', {}).get('uid')
                        and item['metadata']['uid'] != marker['resource_id'] for item in items))

    async def reconcile_plugin_reclaim(self, operation, components):
        marker = await asyncio.to_thread(self.sessions.plugin_reclaim, operation)
        if marker is None:
            return True
        try:
            if await self._plugin_pod_absent(marker):
                return await asyncio.to_thread(self.sessions.discard_plugin_reclaim, operation, marker['resource_id'])
            claim = await asyncio.to_thread(self.sessions.memory_claim, operation)
            if marker['phase'] == 'resizing' and claim and claim['state'] == 'reclaiming':
                path = '/api/v1/namespaces/' + self.namespace + '/pods/' + marker['object_name']
                code, pod = await self.kube.request('GET', path)
                if (code != 200 or not isinstance(pod, dict)
                        or not resize_confirmed(pod, marker['resource_id'], marker['resource_name'],
                                                claim['reclaim_request'], claim['reclaim_limit'], claim['generation'])):
                    return False
                if not await asyncio.to_thread(self.sessions.record_memory_reclaim, operation, APPLIED):
                    return False
            if not await asyncio.to_thread(self.sessions.reopen_plugin_reclaim, operation):
                return False
            try:
                await components.plugin_memory(marker['member'], 'reopen', marker['resource_name'],
                                               marker['resource_id'], marker['instance'], marker['epoch']+1)
            except (AuthError, aiohttp.ClientError, OSError, ValueError):
                path = '/api/v1/namespaces/' + self.namespace + '/pods/' + marker['object_name']
                code, pod = await self.kube.request('GET', path)
                if code != 200 or not isinstance(pod, dict) or pod.get('metadata', {}).get('uid') != marker['resource_id']:
                    return False
                container = _container_instance(pod, marker['resource_name'])
                if (container is None or container[0] == marker['container_id']
                        or container[1] <= marker['restart_count']):
                    return False
                current = await components.stopped_plugin(marker['member'], marker['resource_name'])
                if (not current or current.get('pod_uid') != marker['resource_id']
                        or current.get('instance_id') == marker['instance']):
                    return False
                if not await asyncio.to_thread(self.sessions.replace_plugin_instance, operation, marker['instance'],
                                               current['instance_id'], *container):
                    return False
                await components.plugin_memory(marker['member'], 'reopen', marker['resource_name'],
                                               marker['resource_id'], current['instance_id'], marker['epoch']+1)
            return await asyncio.to_thread(self.sessions.finish_plugin_reclaim, operation)
        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, TypeError, ValueError):
            return False

    async def reclaim_plugin(self, operation, sleep, *, probe, minimum_limit_bytes=None, legacy=None):
        """Shrink one locked, stopped launcher while other member work continues."""
        claim = await asyncio.to_thread(self.sessions.memory_claim, operation)
        if claim is None and isinstance(legacy, dict):
            claim = {**legacy, 'kind': 'container', 'state': 'legacy'}
        if (claim is None or claim['kind'] != 'container' or claim['state'] not in {'active', 'legacy'}
                or claim['resource_name'] in {'dsh', 'connector', 'canvas'} or sleep.components is None):
            return False
        member, name, uid = claim['member'], claim['resource_name'], claim['resource_id']
        epoch = None
        try:
            first = await probe()
            if not isinstance(first, dict) or first.get('pod_uid') != uid or not first.get('instance_id'):
                return False
            snapshot, pod = await self.snapshot(member)
            if pod is None or pod.get('metadata', {}).get('uid') != uid:
                return False
            request, limit = _container_resources(pod, name)
            original_container = _container_instance(pod, name)
            if original_container is None or not resize_confirmed(pod, uid, name, request, limit):
                return False
            confirmed = await probe()
            if (not isinstance(confirmed, dict) or confirmed.get('pod_uid') != uid
                    or confirmed.get('instance_id') != first['instance_id']):
                return False
            base_bytes = snapshot.get('templates', {}).get(member, {}).get('bytes', 0)
            if not isinstance(base_bytes, int) or base_bytes <= 0:
                return False
            epoch = await asyncio.to_thread(self.sessions.begin_plugin_reclaim, operation, member, uid, name,
                                            claim['object_name'], first['instance_id'], request, limit, base_bytes,
                                            *original_container)
            if epoch is None:
                return False
            await sleep.components.plugin_memory(member, 'drain', name, uid, first['instance_id'], epoch)
            locked = await probe(epoch)
            if (not isinstance(locked, dict) or locked.get('pod_uid') != uid
                    or locked.get('instance_id') != first['instance_id']):
                return False
            snapshot, pod = await self.snapshot(member)
            if pod is None or pod.get('metadata', {}).get('uid') != uid:
                return False
            instance = _container_instance(pod, name)
            if instance is None or not resize_confirmed(pod, uid, name, request, limit):
                return False
            base = snapshot['base_requests'].get((member, name), 0)
            base_limit = snapshot['base_limits'].get((member, name), 0)
            usage = snapshot['container_usage'].get((uid, name))
            current = locked.get('memory_current_bytes')
            if (not base or not base_limit or base > request or usage is None
                    or not isinstance(current, int) or isinstance(current, bool) or current <= 0):
                return False
            target_limit = max(base, base_limit, minimum_limit_bytes or base, (max(usage, current)*13+9)//10)
            if target_limit >= limit:
                return False
            path = '/api/v1/namespaces/' + self.namespace + '/pods/' + claim['object_name']
            code, current_pod = await self.kube.request('GET', path)
            final = await probe(epoch)
            if (code != 200 or not isinstance(current_pod, dict) or not isinstance(final, dict)
                    or final.get('pod_uid') != uid or final.get('instance_id') != first['instance_id']
                    or not isinstance(final.get('memory_current_bytes'), int)
                    or final['memory_current_bytes'] <= 0 or final['memory_current_bytes'] > target_limit
                    or _container_instance(current_pod, name) != instance
                    or not resize_confirmed(current_pod, uid, name, request, limit)):
                return False
            if not await asyncio.to_thread(self.sessions.start_plugin_resize, operation, base, target_limit):
                return False
            payload = {'metadata': {'resourceVersion': current_pod['metadata']['resourceVersion']},
                       'spec': {'containers': [{'name': name, 'resources': {
                           'requests': {'memory': str(base)}, 'limits': {'memory': str(target_limit)}}}]}}
            try:
                code, _ = await self.kube.request('PATCH', path + '/resize', payload,
                                                   content_type='application/strategic-merge-patch+json')
            except (AuthError, httpx.HTTPError, OSError, ValueError):
                return False
            if code in {404, 409}:
                await asyncio.to_thread(self.sessions.record_memory_reclaim, operation, NOT_APPLIED)
            for _ in range(5):
                if await self.reconcile_plugin_reclaim(operation, sleep.components):
                    return True
                await asyncio.sleep(1)
            return False
        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, TypeError, ValueError):
            return False
        finally:
            if epoch is not None:
                await self.reconcile_plugin_reclaim(operation, sleep.components)

    async def reclaim_container(self, operation, sleep, *, probe, busy, minimum_limit_bytes=None, legacy=None):
        """Shrink an idle member only after the existing drain confirms it."""
        if (minimum_limit_bytes is not None and (not isinstance(minimum_limit_bytes, int)
                or isinstance(minimum_limit_bytes, bool) or minimum_limit_bytes <= 0)):
            raise ValueError('A configured minimum container limit is required')
        claim = await asyncio.to_thread(self.sessions.memory_claim, operation)
        if claim is None and isinstance(legacy, dict):
            claim = {**legacy, 'kind': 'container', 'state': 'legacy'}
        if claim is None or claim['kind'] != 'container':
            return False
        if claim['resource_name'] in {'dsh', 'connector', 'canvas'}:
            return False
        if claim['state'] == 'reclaiming':
            return await self.reconcile_reclaim(operation, sleep)
        if claim['state'] not in {'active', 'legacy'}:
            return False
        member = claim['member']
        lock = sleep._locks.get(member)
        if lock is None:
            return False
        async with lock:
            instances = await sleep._instances(member)
            epoch = await asyncio.to_thread(self.sessions.begin_drain, member, 0, instances)
            if epoch is None:
                return False
            committed = False
            try:
                try:
                    first = await probe()
                    if not isinstance(first, dict) or await busy():
                        return False
                except Exception:
                    return False
                confirmations = await sleep._confirmations(member, epoch)
                locked = await probe(epoch)
                if (not isinstance(locked, dict) or locked.get('pod_uid') != claim['resource_id']
                        or locked.get('instance_id') != first.get('instance_id')):
                    return False
                snapshot, pod = await self.snapshot(member)
                if pod is None or pod.get('metadata', {}).get('uid') != claim['resource_id']:
                    return False
                instance = _container_instance(pod, claim['resource_name'])
                if instance is None:
                    return False
                request, limit = _container_resources(pod, claim['resource_name'])
                if not resize_confirmed(pod, claim['resource_id'], claim['resource_name'], request, limit):
                    return False
                base = snapshot['base_requests'].get((member, claim['resource_name']), 0)
                base_limit = snapshot['base_limits'].get((member, claim['resource_name']), 0)
                usage = snapshot['container_usage'].get((claim['resource_id'], claim['resource_name']))
                if not base or not base_limit or usage is None:
                    return False
                if base > request:
                    return False
                target_request = base
                current = locked.get('memory_current_bytes')
                if not isinstance(current, int) or isinstance(current, bool) or current <= 0:
                    return False
                target_limit = max(target_request, base_limit, minimum_limit_bytes or target_request,
                                   (max(usage, current) * 13 + 9) // 10)
                if target_limit >= limit:
                    return False
                if claim['state'] == 'legacy':
                    began = await asyncio.to_thread(self.sessions.begin_memory_migration, operation, member,
                                                    claim['resource_id'], claim['resource_name'], claim['object_name'],
                                                    epoch, confirmations, request, limit, target_request, target_limit)
                else:
                    began = await asyncio.to_thread(self.sessions.begin_memory_reclaim, operation, member, epoch,
                                                    confirmations, target_request, target_limit)
                if not began:
                    return False
                committed = True
                # Re-read the same bound components immediately before sending.
                confirmations = await sleep._confirmations(member, epoch)
                final = await probe(epoch)
                if (not isinstance(final, dict) or final.get('pod_uid') != claim['resource_id']
                        or final.get('instance_id') != locked.get('instance_id')
                        or not isinstance(final.get('memory_current_bytes'), int)
                        or isinstance(final.get('memory_current_bytes'), bool)
                        or final['memory_current_bytes'] <= 0 or final['memory_current_bytes'] > target_limit):
                    if await asyncio.to_thread(self.sessions.cancel_memory_reclaim, operation):
                        committed = False
                    return False
                path = '/api/v1/namespaces/' + self.namespace + '/pods/' + claim['object_name']
                code, current_pod = await self.kube.request('GET', path)
                if (code != 200 or not isinstance(current_pod, dict)
                        or current_pod.get('metadata', {}).get('uid') != claim['resource_id']
                        or _container_instance(current_pod, claim['resource_name']) != instance
                        or not resize_confirmed(current_pod, claim['resource_id'], claim['resource_name'], request, limit)):
                    if await asyncio.to_thread(self.sessions.cancel_memory_reclaim, operation):
                        committed = False
                    return False
                if not await asyncio.to_thread(self.sessions.start_memory_reclaim, operation, confirmations):
                    if await asyncio.to_thread(self.sessions.cancel_memory_reclaim, operation):
                        committed = False
                    return False
                if (target_request, target_limit) == (request, limit):
                    await asyncio.to_thread(self.sessions.record_memory_reclaim, operation, APPLIED)
                    committed = False
                    return True
                payload = {'metadata': {'resourceVersion': current_pod['metadata']['resourceVersion']},
                           'spec': {'containers': [{'name': claim['resource_name'], 'resources': {
                               'requests': {'memory': str(target_request)}, 'limits': {'memory': str(target_limit)}}}]}}
                try:
                    code, _ = await self.kube.request('PATCH', path + '/resize', payload,
                                                       content_type='application/strategic-merge-patch+json')
                except (AuthError, httpx.HTTPError, OSError, ValueError):
                    await asyncio.to_thread(self.sessions.record_memory_reclaim, operation, UNKNOWN)
                    return False
                if code in {404, 409}:
                    await asyncio.to_thread(self.sessions.record_memory_reclaim, operation, NOT_APPLIED)
                    committed = False
                    return False
                for _ in range(5):
                    if await self.reconcile_reclaim(operation, sleep):
                        return True
                    await asyncio.sleep(1)
                return False
            except (AuthError, httpx.HTTPError, OSError, TypeError, ValueError):
                return False
            finally:
                if not committed:
                    await sleep._abandon(member, epoch)

    async def reclaim_job(self, operation, *, busy):
        """Release a render loan only after its original Job and Pods ended."""
        claim = await asyncio.to_thread(self.sessions.memory_claim, operation)
        if claim is None or claim['kind'] != 'job' or not claim['sent']:
            return False
        job_path = '/apis/batch/v1/namespaces/' + self.namespace + '/jobs/' + claim['object_name']
        pods_path = ('/api/v1/namespaces/' + self.namespace + '/pods?'
                     + urlencode({'labelSelector': 'job-name=' + claim['object_name']}))
        try:
            code, job = await self.kube.request('GET', job_path)
            if code != 200 or not isinstance(job, dict):
                return False
            if (job.get('metadata', {}).get('annotations', {}).get('greenroom/member') != claim['member']
                    or not self.kube.memory_target_matches(job, claim['granted_bytes'])):
                return False
            uid = job['metadata']['uid']
            if not await asyncio.to_thread(self.sessions.bind_memory_job, operation, uid):
                return False
            status = job.get('status', {})
            terminal = bool(status.get('succeeded') or status.get('failed') or any(
                item.get('type') in {'Complete', 'Failed'} and item.get('status') == 'True'
                for item in status.get('conditions', [])))
            if not terminal:
                return False
            pods = await self._get(pods_path)
            for pod in pods.get('items', []):
                refs = pod.get('metadata', {}).get('ownerReferences', [])
                if not any(ref.get('kind') == 'Job' and ref.get('uid') == uid for ref in refs):
                    return False
                if pod.get('status', {}).get('phase') not in {'Succeeded', 'Failed'}:
                    return False
            if await busy():
                return False
        except (AuthError, httpx.HTTPError, OSError, KeyError, TypeError, ValueError):
            return False
        if claim['state'] != 'active':
            if not await asyncio.to_thread(self.sessions.record_memory_operation, operation, APPLIED):
                return False
        return await asyncio.to_thread(self.sessions.complete_memory_job, operation)
