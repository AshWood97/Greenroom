"""Unwired durable admission coordinator. No endpoint, send, wake or release.

Only a future authenticated platform caller may invoke begin(). Stored identities
and supplied stores are not authentication. No result authorizes initialization.
Unknown admission outcomes are never automatically admitted again.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager


class ProtectedActivationConflict(RuntimeError):
    pass


class ProtectedActivationCoordinator:
    def __init__(self, path, sessions, activations):
        self.sessions, self.activations = sessions, activations
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute('''CREATE TABLE IF NOT EXISTS protected_activation_intent (
            member TEXT PRIMARY KEY, binding TEXT NOT NULL,
            state TEXT NOT NULL, operation_id TEXT NOT NULL DEFAULT '',
            work_epoch INTEGER, detail TEXT NOT NULL DEFAULT '')''')

    @contextmanager
    def _tx(self):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                yield
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def close(self):
        with self.lock: self.db.close()

    @staticmethod
    def _binding(member, wake_epoch, pod_uid, instances):
        if (not isinstance(member, str) or not member.strip() or len(member) > 512
                or type(wake_epoch) is not int or wake_epoch < 1
                or not isinstance(pod_uid, str) or not pod_uid.strip() or len(pod_uid) > 512
                or not isinstance(instances, dict) or set(instances) != {'bridge', 'canvas', 'connector'}
                or any(not isinstance(v, str) or not v.strip() or len(v) > 512 for v in instances.values())):
            raise ValueError('Invalid activation identity')
        return dict(member=member, wake_epoch=wake_epoch, pod_uid=pod_uid, instances=dict(instances))

    def read(self, member):
        with self.lock:
            row = self.db.execute('SELECT * FROM protected_activation_intent WHERE member=?', (member,)).fetchone()
        if row is None: return None
        return {**dict(row), 'binding': json.loads(row['binding']),
                'action': 'none', 'delivery_enabled': False, 'protection_verified_now': False}

    def _record(self, member, state, operation='', epoch=None, detail=''):
        with self._tx():
            self.db.execute('UPDATE protected_activation_intent SET state=?,operation_id=?,work_epoch=?,detail=? WHERE member=?',
                            (state, operation, epoch, detail, member))

    def begin(self, member, wake_epoch, pod_uid, instances, *, retry_wait=False):
        """Reserve before actual admit_work; bind its ID to #26 without sending.

        Authentication and verified inventory remain caller preconditions.
        Cross-store failure may retain an orphan real work row. There is no
        timeout, delete, finish_work, automatic replay or reconciliation API.
        A caller may explicitly retry a confirmed wait for the same binding.
        """
        binding = self._binding(member, wake_epoch, pod_uid, instances)
        encoded = json.dumps(binding, sort_keys=True)
        with self._tx():
            row = self.db.execute('SELECT * FROM protected_activation_intent WHERE member=?', (member,)).fetchone()
            if row is not None:
                if row['binding'] != encoded: raise ProtectedActivationConflict('Existing intent retains its binding')
                if (retry_wait and row['state'] == 'not_admitted' and row['detail'] == 'wait'
                        and not row['operation_id'] and row['work_epoch'] is None):
                    self.db.execute("UPDATE protected_activation_intent SET state='admission_unknown',detail='' WHERE member=?",
                                    (member,))
                    existing = False
                else:
                    existing = True
            else:
                self.db.execute('INSERT INTO protected_activation_intent(member,binding,state) VALUES(?,?,?)',
                                (member, encoded, 'admission_unknown'))
                existing = False
        if existing: return self.read(member)
        operation = ''; work_epoch = None
        try:
            parent = self.activations.read(member)
            if (parent.get('state') != 'core_only'
                    or any(parent.get(k) != v for k, v in binding.items())):
                self._record(member, 'blocked', detail='Parent core binding does not match')
                return self.read(member)
            # Actual shared admission, never connector ACTIVE_WORK.
            decision = self.sessions.admit_work(member, 'activation', instances=binding['instances'],
                                                require_entry=True, expected_pod_uid=pod_uid, allow_reopen=False)
            if decision.get('decision') != 'admitted':
                if (decision.get('decision') == 'wait'
                        and ('operation_id' not in decision or decision['operation_id'] is not None)):
                    candidate = decision.get('operation_id')
                    epoch = decision.get('epoch')
                    if isinstance(candidate, str):
                        operation = candidate
                    if type(epoch) is int:
                        work_epoch = epoch
                    raise ProtectedActivationConflict('Ambiguous wait receipt')
                self._record(member, 'not_admitted', detail=str(decision.get('decision')))
                return self.read(member)
            candidate = decision.get('operation_id'); epoch = decision.get('epoch')
            if not isinstance(candidate, str) or not candidate or type(epoch) is not int:
                raise ProtectedActivationConflict('Malformed admission receipt')
            operation, work_epoch = candidate, epoch
            self._record(member, 'protected', operation, work_epoch)
            # Explicit dependency on #25 schema. This is only a point-in-time
            # check, not a future permission or proof of component authentication.
            with self.sessions.lock:
                self.sessions.db.execute('BEGIN IMMEDIATE')
                try:
                    work = self.sessions.db.execute('SELECT * FROM member_work WHERE id=?', (operation,)).fetchone()
                    entry = self.sessions.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
                    if (work is None or work['member'] != member or work['epoch'] != work_epoch
                            or work['kind'] != 'activation' or entry is None
                            or entry['state'] != 'active' or entry['pod_uid'] != pod_uid):
                        raise ProtectedActivationConflict('Actual work/entry binding changed')
                finally:
                    self.sessions.db.rollback()  # Read-only; does not release work.
            self.activations.begin_activation(member, wake_epoch, pod_uid, binding['instances'], operation, operation)
            self._record(member, 'bound', operation, work_epoch)
        except Exception as error:
            # Admission/parent may already have committed. Do not retry or free.
            self._record(member, 'unknown', operation, work_epoch, type(error).__name__)
        return self.read(member)
