"""Default-off member sleep and on-demand wake, on the existing DSH slots.

This is not a scheduler: it holds one runtime_state per member, merges
concurrent wakes of the same member, bounds whole-machine wake concurrency,
and scales the roster's fixed member Deployments through the render job's
existing Kubernetes credential channel.

Every cross-process decision goes through HarnessSessions' short transactions
on the shared harness.sqlite3, so the web process and the broker process agree
on a member's busy state, drain epoch and wake ownership without a new service,
lease or lock. The local asyncio primitives below only wait efficiently; they
never decide a global slot or a completion.
"""
import asyncio
import time

import aiohttp
import httpx

from app.core.roster import ROSTER_BY_ID
from app.identity.auth import AuthError
from app.creative.creative_render import APPLIED, NOT_APPLIED, UNKNOWN, ScaleOutcome, member_slot
from app.workspace.harness_sessions import SLEEPING, STARTING, READY, DRAINING, FAILED


class MemberSleep:
    def __init__(self, settings, render, sessions=None, components=None):
        self.settings = settings
        self.render = render
        self.sessions = sessions
        # The three real member-side components, reached over the existing mTLS
        # control chain. Without it no instance can be named, so no drain opens
        # and no confirmation is invented.
        self.components = components
        self.enabled = settings.member_sleep_enabled
        self.memory = None
        self.idle_ms = settings.member_sleep_idle_ms
        self.limit = min(2, settings.member_wake_concurrency)
        self.wake_timeout = settings.member_wake_timeout_ms / 1000
        self.slots = settings.runtime_slots or {}
        # Automatic sleep only ever applies to members named in the explicit
        # list; an absent or blank list is an empty set, never all members.
        listed = tuple(settings.member_sleep_members)
        unknown = [member for member in listed if member not in self.slots or member not in ROSTER_BY_ID]
        if unknown:
            raise RuntimeError('Unknown member sleep roster entry: ' + ', '.join(sorted(unknown)))
        self.targets = set(listed)
        self.replicas = {}
        self._draining = set()
        self._waking = {}
        # Local waiting helpers only. The authoritative state, wake ownership
        # and concurrency count live in the shared transactions.
        self._locks = {member: asyncio.Lock() for member in self.slots}

    # A restart only clears this process's caches. The shared coordination rows
    # survive: an epoch, a wake owner, in-flight work and an unresolved scale
    # are facts about the member, not about this process, and no restart, failed
    # read or missing local future proves they ended.
    def reset(self):
        self.replicas.clear()
        self._draining.clear()
        self._waking.clear()

    def memory_active(self):
        return self.memory is not None and self.sessions.memory_active()

    async def observe(self, *, initial=False, memory=False):
        """Read the real replicas of the fixed member Deployments by name.

        Only a named GET is used: the Role grants no list, and the labels a
        selector would match live on the Pod template, not on the Deployment
        metadata. A member whose replicas cannot be read is recorded as
        unobserved, which keeps it out of every automatic scale-down; nothing
        is invented and no existing operation stage is cleared. A confirmed
        reading updates the observation fact only: it never turns a member that
        is still draining, reopening, waking or carrying an unresolved scale
        back to ready just because its replica count is above zero.
        """
        if not self.enabled and not memory:
            return
        for member in self.slots:
            try:
                resource = await self.render.read_deployment(member)
            except ScaleOutcome:
                if self.sessions is not None:
                    self.sessions.record_unobserved(member)
                continue
            replicas = resource.get('spec', {}).get('replicas')
            if not isinstance(replicas, int) or replicas < 0:
                if self.sessions is not None:
                    self.sessions.record_unobserved(member)
                continue
            self.replicas[member] = replicas
            if self.sessions is not None:
                self.sessions.observe_runtime(member, replicas, time.time() if initial else None)

    def member_for(self, member_id):
        if member_id not in ROSTER_BY_ID or member_id not in self.slots:
            raise AuthError(403, '成员运行环境未配置')
        return member_id

    async def recover_scales(self):
        """Converge every unresolved scale on the operation that owns it.

        An UNKNOWN result, a timeout, a dropped reply or a controller restart
        all leave an operation registered with its send state. None of them
        proves the PATCH failed, so this never resends one: each operation is
        settled by reading the member's real Deployment and matching the
        replica count its own operation recorded. Once that count is observed
        the scale phase ends on the original operation and the member continues
        with its health and reopen. A member that cannot be read, or whose count
        does not match, keeps its operation and its slot with the reason it is
        still open.
        """
        if (not self.enabled and not self.memory_active()) or self.sessions is None:
            return
        for member in self.slots:
            row = self.sessions.runtime_row(member)
            if row is None or not row['scale'] or row['op_started'] != 1:
                continue
            try:
                resource = await self.render.read_deployment(member)
            except ScaleOutcome as exc:
                # The Deployment cannot be read, so the operation stays exactly
                # as it was: nothing is resent and no slot is freed.
                self.replicas.pop(member, None)
                self.sessions.record_unobserved(member)
                continue
            replicas = resource.get('spec', {}).get('replicas')
            if not isinstance(replicas, int) or replicas < 0:
                self.sessions.record_unobserved(member)
                continue
            self.replicas[member] = replicas
            self.sessions.observe_runtime(member, replicas, None)
            self.sessions.record_scale(member, row['op_id'], APPLIED, replicas)

    def runtime_state(self, member_id):
        """The committed state, or FAILED when nothing has confirmed it yet."""
        if self.sessions is not None:
            return self.sessions.runtime_state(member_id)
        return FAILED

    def sleep_eligible(self, member_id):
        """Automatic sleep only applies to explicitly listed members."""
        return ((self.enabled and member_id in self.targets)
                or (self.memory_active() and member_id in self.slots))

    def touch(self, member_id, *, foreground=False):
        """Only real foreground activity extends the idle window.

        The durable activity column is what begin_drain reads, so a background
        poll never renews a member's window.
        """
        if not foreground or member_id not in self.slots:
            return
        if self.sessions is not None:
            self.sessions.record_activity(member_id, time.time())

    def admit(self, member_id):
        """Serialize request admission with the member's scale-down decision."""
        if (not self.enabled and not self.memory_active()) or member_id not in self._locks:
            return None
        return self._locks[member_id]

    async def wake(self, member_id, probe):
        """Wake one member; concurrent callers of the same member share it.

        The feature switch and the sleep roster only control automatic sleep:
        a member outside the roster, or woken while the switch is off, is still
        started here for a legitimate current member. A member with no open
        wake, scale, reopen or drain gate is first probed as a resident
        environment, because health rather than a label is what settles it: a
        member that is missing, FAILED, or carries no session row at all but is
        really healthy completes on its own path without a needless Kubernetes
        call, and a member whose replica count is unknown is read before any
        scale is considered. An unhealthy member with no operation to share
        falls through to a coordinated wake, and one that is already carrying
        one shares or waits on it instead.
        """
        self.member_for(member_id)
        if self.memory_active():
            entry = self.sessions.entry(member_id)
            if (not entry or entry['state'] not in {'starting', 'active'}
                    or self.sessions.unpause(member_id)):
                raise AuthError(503, '成员运行环境正在排队，请稍后重试')
        lock = self._locks.get(member_id)
        if lock is not None:
            await lock.acquire()
        try:
            row = self.sessions.runtime_row(member_id) if self.sessions is not None else None
            if row is not None and row['state'] == DRAINING and not row['scale']:
                await self._abandon(member_id, row['epoch'])
                row = self.sessions.runtime_row(member_id)
            if row is not None and row['reopen'] and not row['scale']:
                await self._reopen(member_id, row['epoch'])
                row = self.sessions.runtime_row(member_id)
            gate = row['epoch'] if row else 0
            if row is None or (row['state'] in {READY, SLEEPING, FAILED} and not row['scale']
                               and not row['wake'] and not row['reopen'] and row['state'] != DRAINING):
                # Resident fast path. Health rather than a label settles this:
                # a member that is missing, FAILED, or carries no session row at
                # all but is really healthy completes here, re-confirmed in a
                # short transaction that must still see the same gate epoch. A
                # member that is not on the sleep list and has the switch off
                # never needs a Kubernetes call to get here.
                if await self._resident(member_id, probe, gate):
                    return READY
            if row is None or (row['state'] in {SLEEPING, FAILED} and not row['scale']
                               and not row['wake'] and not row['reopen']):
                # Read the real Deployment before assuming anything about the
                # replica count: a row nobody ever wrote is read exactly like a
                # sleeping one, an unreadable state is never guessed as either,
                # and neither a zero nor a positive count is left as a stale
                # earlier cache.
                replicas = await self._read_replicas(member_id)
                if replicas is None:
                    raise AuthError(503, '成员运行环境状态未确认，请稍后重试')
                self.replicas[member_id] = replicas
                self.sessions.observe_runtime(member_id, replicas, time.time())
                if row is None:
                    row = self.sessions.runtime_row(member_id)
                else:
                    row = dict(row, replicas=replicas)
            claim = self.sessions.claim_wake(member_id, self.limit) if self.sessions is not None else None
            if claim is None:
                raise AuthError(503, '缺少共享协调状态，无法确认成员运行环境')
            if claim['decision'] == 'shared':
                # Another process owns this wake; wait for the completion it
                # commits rather than treating this process's view as the result.
                return await self._await_wake(member_id, claim['operation_id'], claim['epoch'])
            if claim['decision'] == 'wait':
                raise AuthError(503, '成员运行环境正在准备，请稍后重试')
            # Whether this wake needs a PATCH was decided inside the claim, from
            # the replica count that member's row carried in that same
            # transaction. It is never re-derived here from a row this process
            # read earlier, which could have gone stale in between.
            return await self._owned_wake(member_id, claim, probe)
        finally:
            if lock is not None:
                lock.release()

    async def _resident(self, member_id, probe, gate):
        """Probe a member with no open gate, and re-confirm it in a transaction.

        The probe is the only entry: a READY label on its own never settles a
        wake, and neither does a missing row. The transaction that follows the
        probe must still see the same gate epoch and no open gate, so a drain,
        a reopen, a wake or a scale that appeared meanwhile keeps its own
        outcome. An unhealthy member returns False and its caller decides what
        an uncoordinated scale would mean; this method never touches Kubernetes
        to stand in for a coordinated wake.
        """
        try:
            if await probe() is not True:
                return False
        except (AuthError, OSError, ValueError):
            return False
        return self._confirm_resident(member_id, gate)

    async def _read_replicas(self, member_id):
        """The member Deployment's confirmed replica count, or None if unreadable.

        Both a zero and a positive count are real observations and are recorded
        as such; a failed read returns None and leaves the caller's cache alone,
        because an unreadable member must not be claimed as scaled nor patched.
        """
        try:
            resource = await self.render.read_deployment(member_id)
        except ScaleOutcome:
            return None
        replicas = resource.get('spec', {}).get('replicas')
        if not isinstance(replicas, int) or replicas < 0:
            return None
        return replicas

    def _confirm_resident(self, member_id, gate_epoch):
        """Re-confirm a healthy resident environment in a short transaction.

        The probe's success is not itself a completion: this re-reads the epoch
        and the operation flags, and only then records real activity. A member
        whose drain, reopen, wake or scale appeared meanwhile is not confirmed.
        """
        return self.sessions.confirm_resident(member_id, time.time(), gate_epoch)

    async def _owned_wake(self, member_id, claim, probe):
        """Run the wake this process owns, and settle its shared operation.

        The operation is persisted by the claim before anything is sent, so an
        interruption still leaves the owner recorded. Only a provably unstarted
        attempt releases the slot; an APPLIED replica count without health, a
        health timeout, a cancellation, a process failure and an UNKNOWN result
        all keep the operation, its owner and its global slot, and none of them
        authorises another PATCH. The scale that is sent is decided by the
        replica count this claim confirmed, never by a local cache this process
        may hold stale.
        """
        operation, epoch = claim['operation_id'], claim['epoch']
        try:
            if claim['needs_scale']:
                await self._scale(member_id, 1, operation=operation)
            result = await self._wait_ready(member_id, probe, operation, epoch)
            if not self.sessions.release_wake(member_id, operation, epoch, gate_epoch=result['gate_epoch'],
                                              state=READY, replicas=self.replicas.get(member_id, 1),
                                              activity=time.time(), result='ready'):
                # The compare-and-set lost, so this is not a completion.
                raise AuthError(503, '成员运行环境门禁已变化，请稍后重试')
            return READY
        except ScaleOutcome as exc:
            if exc.outcome == NOT_APPLIED:
                # Provably never sent or explicitly rejected: the scale phase is
                # settled as never applied, and this owner's wake finishes as
                # failed so a foreground retry may open a new operation. A
                # reopen that is still open keeps its own gate and the member
                # stays STARTING rather than being reported ready.
                if not self.sessions.release_wake(member_id, operation, epoch, gate_epoch=epoch,
                                                  state=FAILED, replicas=self.replicas.get(member_id, 1),
                                                  activity=time.time(), result='not_applied'):
                    raise AuthError(503, '成员运行环境准备失败，请重试') from exc
            # APPLIED without health, and UNKNOWN, both keep the operation.
            raise
        except BaseException:
            # Interrupted, timed out or failed in an unknown way: keep the
            # operation and its slot rather than leaking the owner or resending.
            raise

    async def _await_wake(self, member_id, operation, epoch):
        """Wait for the completion the owner commits for this exact operation.

        Only the stored completion identity — operation id and its claim epoch —
        counts, together with the member currently having no unresolved scale or
        reopen. A different operation, a missing completion identity, a member
        that has since drained or reopened, or a replaced state leaves the
        caller waiting; a vanished owner is never read as success. The waiter
        never probes, releases or rescales on the owner's behalf.
        """
        deadline = time.monotonic() + self.wake_timeout
        while True:
            row = self.sessions.runtime_row(member_id)
            if row is None:
                raise AuthError(503, '成员运行环境状态未确认，请稍后重试')
            if not row['wake']:
                # The completion must belong to this exact operation and claim
                # epoch, and must still be the member's current gate phase: a
                # drain or a reopen that advanced the member since is a
                # different phase, not this wait's success.
                completion = self.sessions.wake_completion(member_id, operation, epoch)
                if completion is not None and completion['result'] == 'ready' \
                        and row['state'] == READY and not completion['scale'] \
                        and not completion['reopen']:
                    return READY
                if completion is not None:
                    raise AuthError(503, '成员运行环境准备失败，请重试')
            if time.monotonic() >= deadline:
                # A timeout never touches another process's owner or markers.
                raise AuthError(503, '成员运行环境准备超时，请手动重试')
            await asyncio.sleep(1)

    async def _scale(self, member_id, replicas, *, operation=None):
        """Scale one member, or leave the member exactly as it was.

        The operation is registered for sending in a short transaction before
        any network call, so an operation that already started or whose result
        is unknown can never be sent twice. The send right is granted exactly
        once per operation, and the caller that holds it settles that
        operation's result here and nowhere else: an APPLIED replica count that
        matches the target ends the scale phase, and a provably NOT_APPLIED one
        — a failed read before the PATCH, a missing resourceVersion, or an
        explicit API rejection — ends it as never applied. An UNKNOWN result
        keeps the phase, so nothing is resent and no slot is freed.
        """
        slot = member_slot(member_id)
        if not slot:
            # No Deployment exists to scale, so there is no scale phase to
            # settle: this attempt never got a send right to begin with.
            raise ScaleOutcome(NOT_APPLIED, '成员运行环境未配置，未执行伸缩')
        if self.sessions is not None and operation is not None:
            if not self.sessions.start_scale(member_id, operation):
                # Another attempt already sent this operation, or its result is
                # unknown: do not send it again.
                raise ScaleOutcome(UNKNOWN, '本次伸缩操作已开始或结果未知，未重复发送')
        try:
            resource = await self.render.read_deployment(member_id)
            if replicas == 1 and self.memory_active():
                from app.workspace.member_memory import _pod_limit
                meta = resource.get('metadata', {})
                generation = meta.get('generation')
                observed = resource.get('status', {}).get('observedGeneration')
                entry = self.sessions.entry(member_id)
                try:
                    cap, _ = _pod_limit({'spec': resource['spec']['template']['spec']}, template=True)
                except (KeyError, TypeError, ValueError):
                    raise ScaleOutcome(NOT_APPLIED, '成员部署内存尚未确认，未执行唤醒')
                if (resource.get('spec', {}).get('paused', False)
                        or not isinstance(generation, int) or not isinstance(observed, int)
                        or observed < generation or not entry or entry['state'] not in {'starting', 'active'}
                        or cap > entry['reserved_bytes']):
                    raise ScaleOutcome(NOT_APPLIED, '成员部署模板尚未就绪，未执行唤醒')
            version = resource.get('metadata', {}).get('resourceVersion')
            confirmed = await self.render.scale_deployment(member_id, replicas, version)
        except ScaleOutcome as exc:
            # The send right already granted, this outcome is settled against
            # it here: a provably NOT_APPLIED clears the scale phase, while an
            # UNKNOWN one keeps it for the operation that owns it.
            self._settle_scale(member_id, operation, exc.outcome,
                               exc.replicas if exc.outcome == APPLIED else None)
            raise
        self.replicas[member_id] = confirmed
        self._settle_scale(member_id, operation, APPLIED, confirmed)
        return confirmed

    def _settle_scale(self, member_id, operation, result, replicas=None):
        """Settle this operation's scale phase exactly once, from its send right.

        Only the caller that was granted the send right records the result, so
        an outcome is never written twice and a caller without that right never
        rewrites another attempt's scale.
        """
        if self.sessions is None or operation is None:
            return
        self.sessions.record_scale(member_id, operation, result, replicas)

    async def _wait_ready(self, member_id, probe, operation, epoch):
        """Wait for this operation's health, inside the gate epoch it is running.

        The scale of this operation must be settled and its reopen, if any,
        completed before the health probe counts, and the probe is only a
        completion candidate while the member still carries this owner, this
        claim epoch and the same gate epoch the probe saw. A probe's True is
        therefore never a committed completion by itself: the caller commits it
        against that gate epoch, and an epoch that moved on keeps waiting for
        the new phase's health instead of letting an old probe finish it.
        """
        deadline = time.monotonic() + self.wake_timeout
        while True:
            row = self.sessions.runtime_row(member_id) if self.sessions is not None else None
            if row is not None and row['wake'] == operation and row['op_epoch'] == epoch \
                    and row['reopen'] and not row['scale']:
                await self._reopen(member_id, row['epoch'])
                row = self.sessions.runtime_row(member_id)
            gate = row['epoch'] if row else 0
            scale = row['scale'] if row else ''
            reopen = bool(row['reopen']) if row else False
            if operation is None or (row is not None and row['wake'] == operation
                                     and row['op_epoch'] == epoch and not scale and not reopen):
                try:
                    if await probe() is True:
                        return {'gate_epoch': gate}
                except (AuthError, OSError, ValueError):
                    pass
            if time.monotonic() >= deadline:
                raise AuthError(503, '成员运行环境准备超时，请手动重试')
            await asyncio.sleep(1)

    async def sleep_if_idle(self, member_id, *, probe, busy, waiting_only=False):
        """Scale one member down only when it is provably and stably idle."""
        if not self.sleep_eligible(member_id):
            return False
        if self.runtime_state(member_id) != READY:
            return False
        if not self.observed(member_id):
            return False
        if not self.replicas.get(member_id):
            return False
        lock = self._locks.get(member_id)
        if lock is None:
            return False
        # Holding the member lock makes the final check and the scale-down
        # mutually exclusive with admitting a request for the same member.
        async with lock:
            if self.runtime_state(member_id) != READY or not self.observed(member_id):
                return False
            if not self.replicas.get(member_id):
                return False
            # The drain epoch is opened in the shared transaction, which itself
            # confirms the idle window, the absence of in-flight work and that
            # the real component instances were bound for this epoch.
            instances = await self._instances(member_id)
            idle_ms = min(self.idle_ms, 60_000) if waiting_only else self.idle_ms
            epoch = (self.sessions.begin_drain(member_id, idle_ms, instances, waiting_only=True)
                     if self.sessions is not None and waiting_only else
                     self.sessions.begin_drain(member_id, idle_ms, instances)
                     if self.sessions is not None else None)
            if epoch is None:
                return False
            self._draining.add(member_id)
            try:
                # Re-check inside the marker: a request admitted during the idle
                # window, or work that cannot be confirmed finished, wins.
                if not await probe():
                    await self._abandon(member_id, epoch)
                    return False
                try:
                    occupied = await busy()
                except Exception:
                    occupied = True
                if occupied:
                    await self._abandon(member_id, epoch)
                    return False
                # Component confirmations are the linearization point. Until the
                # connector, DSH bridge and canvas report their closed and idle
                # state for this exact epoch and bound instance, no scale is
                # authorized.
                confirmations = await self._confirmations(member_id, epoch)
                retiring_pod = None
                if self.memory_active():
                    try:
                        retiring_pod = await self.memory.resident(member_id)
                    except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, ValueError):
                        await self._abandon(member_id, epoch)
                        return False
                if not self.sessions.commit_scale(member_id, epoch, 0, confirmations,
                                                  retiring_pod=retiring_pod, waiting_only=waiting_only):
                    await self._abandon(member_id, epoch)
                    return False
                operation = self.sessions.scale_operation(member_id)
                try:
                    # The send right settles its own result, so a NOT_APPLIED
                    # scale ends the phase as never applied and an UNKNOWN or
                    # unconfirmed one keeps it; this drain only reports whether
                    # the member actually reached its target zero.
                    confirmed = await self._scale(member_id, 0, operation=operation)
                except ScaleOutcome:
                    # The member never reached target zero. A provably
                    # NOT_APPLIED attempt leaves the member closed and lets the
                    # reopen path recover it, while an UNKNOWN one keeps the
                    # operation and the closure until that scale is resolved.
                    if not self.sessions.scale_result(member_id)[0]:
                        await self._abandon(member_id, epoch)
                    return False
                return True
            finally:
                self._draining.discard(member_id)

    def observed(self, member_id):
        return self.sessions.observed(member_id) if self.sessions is not None else False

    async def _instances(self, member_id):
        """The real component instances to bind when a drain epoch opens.

        Each component reports its own member and instance identity over the
        existing mTLS control chain, so the epoch binds the instances that
        really exist now. A component that cannot be reached, or that answers
        for another member, yields nothing for it: the drain then refuses
        rather than naming an instance nobody confirmed.
        """
        if self.components is None:
            return {}
        try:
            return await self.components.instances(member_id)
        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, ValueError):
            return {}

    async def _abandon(self, member_id, epoch):
        """Give up an uncommitted drain and arm the reopen protocol.

        cancel_drain only requests the reopen: it invalidates the old epoch and
        leaves the member closed until the components confirm they reopened.
        The new epoch's expected instances are read from the components again,
        so a restart that replaced one of them is caught here instead of being
        confirmed against a dead identity. A member whose scale already began is
        refused outright and keeps its operation.
        """
        instances = await self._instances(member_id)
        if not instances:
            # No component can be named, so the reopen protocol has nothing
            # real to check against and the member stays closed.
            return
        following = self.sessions.cancel_drain(member_id, epoch, instances)
        if following is not None:
            await self._reopen(member_id, following)

    async def _confirmations(self, member_id, epoch):
        """Component closed-and-idle confirmations for this drain epoch.

        Each component answers for this exact epoch and its own instance. A
        component that is unreachable, answers for another member or epoch, or
        reports work still running contributes nothing, so commit_scale refuses
        the scale-down rather than treating a silence as idle.
        """
        if self.components is None:
            return {}
        try:
            confirmations = await self.components.confirmations(member_id, epoch)
        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, ValueError):
            return {}
        return confirmations if isinstance(confirmations, dict) else {}

    async def _reopen(self, member_id, epoch):
        """Settle a reopen the components have actually reopened for.

        The three components must each report opened for this epoch and their
        bound instance. An incomplete set leaves the member closed, so its next
        request waits rather than reaching a component that has not reopened;
        this wake keeps its operation and slot until the protocol completes.
        """
        if self.components is None:
            return False
        row = self.sessions.runtime_row(member_id)
        if row is None or row['epoch'] != epoch or not row['reopen'] or row['scale']:
            return False
        instances = await self._instances(member_id)
        if not instances:
            return False
        if instances != self.sessions.component_instances(member_id, epoch):
            epoch = self.sessions.invalidate_epoch(member_id, epoch, instances)
            if epoch is None:
                return False
        try:
            opened = await self.components.opened(member_id, epoch)
        except (AuthError, aiohttp.ClientError, httpx.HTTPError, OSError, ValueError):
            return False
        if not isinstance(opened, dict) or not opened:
            return False
        return bool(self.sessions.complete_reopen(member_id, epoch, opened))
