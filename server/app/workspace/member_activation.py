"""Unwired durable activation protocol storage; NOT a wake or authorization API.

Only a future trusted coordinator may use this after validating the original
identity/admission/work contracts. No caller currently imports this module.
Missing records denote legacy-unmanaged environments, not permission to pause
or activate them. New background starts must be declared BEFORE any Pod starts.
No expiry, retirement, lease release or backend action is implemented here.
"""
from contextlib import contextmanager
import json
import sqlite3
import threading

COMPONENTS = frozenset({'bridge', 'canvas', 'connector'})


def _text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError('Expected a nonempty bounded identifier')
    return value


def _epoch(value):
    if type(value) is not int or value < 1:
        raise ValueError('Expected a positive wake epoch')
    return value


def _instances(value):
    if not isinstance(value, dict) or set(value) != COMPONENTS:
        raise ValueError('Expected every component instance')
    return {key: _text(value[key]) for key in sorted(COMPONENTS)}


class ActivationConflict(RuntimeError):
    pass


class MemberActivationStore:
    """Separate protocol table, never mutating existing runtime/work/drain rows.

    Methods are internal persistence primitives, not proof of authentication,
    idle inventory, memory admission or component isolation. Caller must retain
    its existing work protection through unknown/activating results. A matching
    ack is merely a persisted receipt, not an instruction to free that guard.
    """
    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, timeout=5, isolation_level=None,
                                  check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('''CREATE TABLE IF NOT EXISTS member_activation_contract (
            member TEXT PRIMARY KEY, wake_epoch INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('prepared_core','core_only','activating','active')),
            pod_uid TEXT NOT NULL DEFAULT '', instances TEXT NOT NULL DEFAULT '{}',
            operation_id TEXT NOT NULL DEFAULT '', protection_id TEXT NOT NULL DEFAULT '',
            acknowledgements TEXT NOT NULL DEFAULT '{}')''')

    def close(self):
        with self.lock:
            self.db.close()

    @contextmanager
    def _transaction(self):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                yield
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def _row(self, member):
        return self.db.execute('SELECT * FROM member_activation_contract WHERE member=?',
                               (member,)).fetchone()

    @staticmethod
    def _view(row):
        if row is None:
            return {'managed': False, 'state': 'legacy_unmanaged',
                    'action': 'none', 'activation_confirmed': False}
        value = dict(row)
        for key in ('instances', 'acknowledgements'):
            value[key] = json.loads(value[key])
        return {'managed': True, **value, 'action': 'none',
                'activation_confirmed': value['state'] == 'active'}

    def read(self, member):
        _text(member)
        with self.lock:
            return self._view(self._row(member))

    def prepare_core(self, member, wake_epoch):
        """Persist intent before a FUTURE background launch, without launching.

        Never adopt an existing Pod because its record happens to be absent.
        Caller must first prove this is a new eligible wake under its ledger.
        No overwriting/retirement contract exists yet, so other epochs reject.
        """
        _text(member); _epoch(wake_epoch)
        with self._transaction():
            row = self._row(member)
            if row is not None:
                if row['wake_epoch'] != wake_epoch:
                    raise ActivationConflict('Existing activation record is protected')
            else:
                self.db.execute('INSERT INTO member_activation_contract(member,wake_epoch,state) VALUES(?,?,?)',
                                (member, wake_epoch, 'prepared_core'))
            return self._view(self._row(member))

    def bind_core(self, member, wake_epoch, pod_uid, instances):
        """Bind actual identities; no component is authorized to run business."""
        _text(member); _epoch(wake_epoch); _text(pod_uid)
        instances = _instances(instances)
        with self._transaction():
            row = self._exact(member, wake_epoch)
            if row['state'] == 'prepared_core':
                self.db.execute('UPDATE member_activation_contract SET state=?,pod_uid=?,instances=? WHERE member=?',
                                ('core_only', pod_uid, json.dumps(instances, sort_keys=True), member))
            elif row['pod_uid'] != pod_uid or json.loads(row['instances']) != instances:
                raise ActivationConflict('Pod/component binding changed; retain protection')
            return self._view(self._row(member))

    def _exact(self, member, wake_epoch, pod_uid=None, instances=None):
        row = self._row(member)
        if (row is None or row['wake_epoch'] != wake_epoch
                or (pod_uid is not None and row['pod_uid'] != pod_uid)
                or (instances is not None and json.loads(row['instances']) != instances)):
            raise ActivationConflict('Stale or foreign activation identity')
        return row

    def begin_activation(self, member, wake_epoch, pod_uid, instances, operation_id, protection_id):
        """Record one operation AFTER upstream auth/admission/protection succeed.

        Persist before delivery. Retrying the same intent returns its original
        state; this method never sends/replays a component request. A lost reply
        must be reconciled, not inferred failed or automatically retried.
        """
        _text(member); _epoch(wake_epoch); _text(pod_uid)
        _text(operation_id); _text(protection_id); instances = _instances(instances)
        with self._transaction():
            row = self._exact(member, wake_epoch, pod_uid, instances)
            if row['state'] == 'core_only':
                self.db.execute('UPDATE member_activation_contract SET state=?,operation_id=?,protection_id=? WHERE member=?',
                                ('activating', operation_id, protection_id, member))
            elif (row['state'] not in {'activating', 'active'}
                  or row['operation_id'] != operation_id or row['protection_id'] != protection_id):
                raise ActivationConflict('Different or unbound activation intent')
            return self._view(self._row(member))

    def acknowledge(self, member, wake_epoch, pod_uid, operation_id, component, instance_id):
        """Store a verified component receipt; never release any work guard.

        Caller authenticates transport and validates an affirmative activation
        receipt before invoking this. We additionally match every bound ID.
        """
        _text(member); _epoch(wake_epoch); _text(pod_uid); _text(operation_id); _text(instance_id)
        if component not in COMPONENTS:
            raise ValueError('Unknown component')
        with self._transaction():
            row = self._exact(member, wake_epoch, pod_uid)
            instances = json.loads(row['instances'])
            if (row['state'] not in {'activating', 'active'} or row['operation_id'] != operation_id
                    or instances.get(component) != instance_id):
                raise ActivationConflict('Unrequested, stale or foreign receipt')
            acks = json.loads(row['acknowledgements'])
            acks[component] = instance_id
            state = 'active' if acks == instances else 'activating'
            self.db.execute('UPDATE member_activation_contract SET state=?,acknowledgements=? WHERE member=?',
                            (state, json.dumps(acks, sort_keys=True), member))
            return self._view(self._row(member))
