"""Unwired startup-attempt journal, not authorization or a delivery service.

A future trusted coordinator must validate authentication, activation binding,
resource/work protection and consumer role before claim(). This module neither
calls a component nor proves those prerequisites. No timeout/replay/retirement.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from uuid import uuid4
from pathlib import Path

UNITS = json.loads((Path(__file__).resolve().parents[3] / 'runtime/shared/activation-startup-units.json').read_text())
KEYS = frozenset({'startup_unit', 'parent_instance_id', 'member_id', 'wake_epoch', 'pod_uid', 'component', 'instance_id', 'activation_id'})


def _binding(value):
    if not isinstance(value, dict) or set(value) != KEYS:
        raise ValueError('Invalid activation binding')
    if type(value['wake_epoch']) is not int or not 0 < value['wake_epoch'] <= 9007199254740991:
        raise ValueError('Invalid wake epoch')
    for key in KEYS - {'wake_epoch'}:
        if not isinstance(value[key], str) or not value[key].strip() or len(value[key]) > 512:
            raise ValueError('Invalid binding identifier')
    unit = UNITS.get(value['startup_unit'])
    if not unit or value['component'] != unit['component']:
        raise ValueError('Unknown startup unit or wrong parent component')
    return json.dumps(value, sort_keys=True)


class DeliveryConflict(RuntimeError):
    pass


class ActivationDeliveryStore:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, isolation_level=None, timeout=5, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('''CREATE TABLE IF NOT EXISTS activation_unit_delivery_contract (
            member_id TEXT NOT NULL, wake_epoch INTEGER NOT NULL, startup_unit TEXT NOT NULL,
            binding TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('attempted','unknown','imported')),
            PRIMARY KEY(member_id,startup_unit))''')

    def close(self):
        with self.lock: self.db.close()

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

    def _row(self, binding):
        # No automatic migration/relabeling of legacy component-keyed attempts.
        # Any old attempt for this member fences all new units until an explicit
        # independently reviewed reconciliation exists.
        legacy = self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activation_delivery_contract'").fetchone()
        if legacy and self.db.execute('SELECT 1 FROM activation_delivery_contract WHERE member_id=? LIMIT 1',
                                      (binding['member_id'],)).fetchone():
            raise DeliveryConflict('Legacy component attempt needs explicit reconciliation')
        return self.db.execute('SELECT * FROM activation_unit_delivery_contract WHERE member_id=? AND startup_unit=?',
                               (binding['member_id'], binding['startup_unit'])).fetchone()

    @staticmethod
    def _view(row, disposition='existing'):
        return {'binding': json.loads(row['binding']), 'attempt_id': row['attempt_id'],
                'state': row['state'], 'disposition': disposition}

    def read(self, binding):
        encoded = _binding(binding)
        with self.lock:
            row = self._row(binding)
            if row is None: return None
            if row['binding'] != encoded: raise DeliveryConflict('Different binding retains protection')
            return self._view(row)

    def claim(self, binding):
        """Commit attempted BEFORE returning fresh; a repeated claim is never fresh."""
        encoded = _binding(binding)
        with self._tx():
            row = self._row(binding)
            if row is not None:
                if row['binding'] != encoded: raise DeliveryConflict('Different binding retains protection')
                return self._view(row)
            self.db.execute('INSERT INTO activation_unit_delivery_contract VALUES(?,?,?,?,?,?)',
                            (binding['member_id'], binding['wake_epoch'], binding['startup_unit'],
                             encoded, str(uuid4()), 'attempted'))
            return self._view(self._row(binding), 'fresh')

    def _record(self, binding, attempt_id, state):
        encoded = _binding(binding)
        with self._tx():
            row = self._row(binding)
            if row is None or row['binding'] != encoded or row['attempt_id'] != attempt_id:
                raise DeliveryConflict('Stale or foreign receipt')
            # A successful import receipt may resolve unknown, but unknown must
            # never erase an already recorded import. Neither means Ready.
            if row['state'] != 'imported':
                self.db.execute('UPDATE activation_unit_delivery_contract SET state=? WHERE attempt_id=?',
                                (state, attempt_id))
            return self._view(self._row(binding))

    def mark_imported(self, binding, attempt_id):
        return self._record(binding, attempt_id, 'imported')

    def mark_unknown(self, binding, attempt_id):
        return self._record(binding, attempt_id, 'unknown')


def startup_binding(activation_record, unit_id, instance_id):
    """Pure mapping from a trusted coordinator's #26 snapshot, not authorization.

    No member/component/epoch supplied by a plugin request is copied separately.
    The caller must obtain this record and the runner instance from its verified
    operation/inventory, and hold real work protection across claim/delivery.
    """
    unit = UNITS.get(unit_id)
    if not unit or not isinstance(activation_record, dict) or activation_record.get('state') != 'activating':
        raise ValueError('No activating parent record for fixed startup unit')
    parent = activation_record.get('instances', {}).get(unit['component'])
    value = dict(startup_unit=unit_id, parent_instance_id=parent,
                 member_id=activation_record.get('member'), wake_epoch=activation_record.get('wake_epoch'),
                 pod_uid=activation_record.get('pod_uid'), component=unit['component'],
                 instance_id=instance_id, activation_id=activation_record.get('operation_id'))
    _binding(value)
    return value
