"""Member-private original-ID planning and actual work reservation, NEVER delivery.

No production caller is wired. resolve_context must be supplied by the authenticated
host, not a plugin/request payload. Its authority is a caller precondition, not
established by this module. Missing resolver is fail-closed. #30 is required.
"""
import json
from pathlib import Path
import sqlite3
import threading
from uuid import uuid4
from contextlib import contextmanager

COMPONENTS = ('bridge', 'canvas', 'connector')


def observe_poll_inventory(path):
    """Observe #27 parent provenance in one read snapshot, NEVER authorize.

    The caller must establish member-private inventory ownership. A matching
    current parent row is not authentication, original-argument immutability,
    project/shot selection proof or continuing work protection.
    """
    media_operations = {'shot_image': 'image', 'shot_video': 'video',
                        'generate_image': 'image', 'generate_video': 'video',
                        'angle_switch': 'image'}
    with sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        job_columns = {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}
        media_columns = {row['name'] for row in db.execute('PRAGMA table_info(media_jobs)')}
        # Read old schemas without migration or inventing/backfilling a parent.
        args_column = 'args' if 'args' in job_columns else 'NULL AS args'
        parent_column = 'parent_job_id' if 'parent_job_id' in media_columns else 'NULL AS parent_job_id'
        kind_column = 'kind' if 'kind' in media_columns else 'NULL AS kind'
        jobs = db.execute('SELECT id,operation,state,' + args_column + ' FROM jobs').fetchall()
        media = db.execute('SELECT id,upstream_id,state,' + parent_column + ',' + kind_column + ' FROM media_jobs').fetchall()
    observed = []
    for row in media:
        if (row['state'] in ('pending', 'waiting', 'running')
                and isinstance(row['id'], str) and row['id']
                and isinstance(row['upstream_id'], str) and row['upstream_id'].strip()):
            parent_id = row['parent_job_id']
            parents = [job for job in jobs if job['id'] == parent_id] if isinstance(parent_id, str) and parent_id else []
            reason = 'parent_record_unavailable'
            operation = None
            if len(parents) == 1:
                parent = parents[0]
                operation = parent['operation']
                if operation not in media_operations or row['kind'] != media_operations[operation]:
                    reason = 'parent_operation_or_media_kind_unverified'
                else:
                    try:
                        args = json.loads(parent['args'])
                    except (TypeError, ValueError):
                        args = None
                    reason = ('parent_record_observed_not_authorized' if isinstance(args, dict)
                              else 'parent_arguments_unverified')
            observed.append({'media_id': row['id'], 'upstream_id': row['upstream_id'],
                             'parent_job_id': parent_id, 'parent_operation': operation,
                             'parent_observation': reason,
                             'authorization': 'unavailable_parent_binding'})
    return {'known': False, 'busy': bool(jobs or media), 'recover': False,
            'observed': sorted(observed, key=lambda row: row['media_id'])}


def poll_candidates(path):
    # Do not invent a registry, trust an external ID, or parse a naming convention.
    # Parent observations do not establish caller/consumer authority: none authorize.
    observe_poll_inventory(path)
    return []


class MoyinRecoveryIntent:
    def __init__(self, path, sessions, resolve_context=None):
        self.sessions = sessions
        self.resolve_context = resolve_context
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE IF NOT EXISTS moyin_recovery_intent '
                        '(member TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL,'
                        'items TEXT NOT NULL,protection_id TEXT,detail TEXT NOT NULL)')
        self.db.commit()
        # Serialize compatibility migration; old intents stay uncorrelated.
        with self.tx():
            columns = {row['name'] for row in self.db.execute('PRAGMA table_info(moyin_recovery_intent)')}
            if 'admission_origin' not in columns:
                self.db.execute('ALTER TABLE moyin_recovery_intent ADD COLUMN admission_origin TEXT')
            self.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS moyin_recovery_origin '
                            'ON moyin_recovery_intent(admission_origin) WHERE admission_origin IS NOT NULL')

    @contextmanager
    def tx(self):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                yield
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def close(self):
        self.db.close()

    def context(self, opaque_session):
        if self.resolve_context is None:
            return None
        value = self.resolve_context(opaque_session)
        if not isinstance(value, dict):
            raise ValueError('Authenticated host context unavailable')
        binding = {k: value[k] for k in ('member', 'pod_uid', 'epoch', 'instances', 'runner_instance')}
        if (not all(isinstance(binding[k], str) and binding[k].strip() for k in ('member','pod_uid','runner_instance'))
                or type(binding['epoch']) is not int or binding['epoch'] < 1
                or not isinstance(binding['instances'], dict)
                or set(binding['instances']) != set(COMPONENTS)
                or not all(isinstance(v,str) and v for v in binding['instances'].values())):
            raise ValueError('Invalid resolved binding')
        # The host maps this path from authenticated membership, never from request args.
        return binding, value['inventory_path']

    def read(self, opaque_session):
        resolved = self.context(opaque_session)
        if resolved is None:
            return {'state':'disabled','delivery_enabled':False,'release_allowed':False}
        binding, _ = resolved
        with self.lock:
            row = self.db.execute('SELECT * FROM moyin_recovery_intent WHERE member=?',(binding['member'],)).fetchone()
        if row is None:
            return {'state':'absent','delivery_enabled':False,'release_allowed':False}
        if json.loads(row['binding']) != binding:
            raise ValueError('Existing operation has a different binding')
        return {'state':row['state'], 'binding':binding, 'protection_id':row['protection_id'],
                'items':json.loads(row['items']), 'detail':row['detail'], 'admission_origin':row['admission_origin'],
                'delivery_enabled':False,'release_allowed':False}

    def record(self, member, state, protection=None, detail=''):
        with self.tx():
            self.db.execute('UPDATE moyin_recovery_intent SET state=?,protection_id=COALESCE(?,protection_id),detail=? WHERE member=?',
                            (state, protection, detail, member))

    def reserve(self, opaque_session, *, replan=False):
        resolved = self.context(opaque_session)
        if resolved is None:
            return self.read(opaque_session)
        binding, inventory = resolved
        member = binding['member']
        encoded = json.dumps(binding,sort_keys=True)
        with self.tx():
            existing = self.db.execute('SELECT binding,state,protection_id FROM moyin_recovery_intent WHERE member=?',(member,)).fetchone()
            if existing:
                if existing['binding'] != encoded:
                    raise ValueError('Existing operation has a different binding')
                # Only blocked-before-admission can explicitly replan; no attempt is discarded.
                if replan and existing['state'] == 'blocked' and existing['protection_id'] is None:
                    self.db.execute("UPDATE moyin_recovery_intent SET state='planning',detail='' WHERE member=?",(member,))
                    existing = None
            else:
                self.db.execute('INSERT INTO moyin_recovery_intent(member,binding,state,items,protection_id,detail) VALUES(?,?,?, ?,NULL,?)',
                                (member,encoded,'planning','[]',''))
        if existing:
            return self.read(opaque_session)  # unknown/reserved operations never replay admission
        try:
            items = poll_candidates(inventory)
            if not items:
                self.record(member,'blocked',detail='No verified original polling candidates')
                return self.read(opaque_session)
            with self.sessions.lock:
                self.sessions.db.execute('BEGIN IMMEDIATE')
                try:
                    runtime = self.sessions.db.execute('SELECT state,epoch FROM member_runtime WHERE member=?',(member,)).fetchone()
                    components = dict(self.sessions.db.execute('SELECT component,instance FROM member_component WHERE member=? AND epoch=?',
                                                               (member,binding['epoch'])).fetchall())
                    if runtime is None or runtime['state'] not in ('ready', 'draining') or runtime['epoch'] != binding['epoch'] or components != binding['instances']:
                        raise ValueError('Observed member epoch/components mismatch')
                finally:
                    self.sessions.db.rollback()
            origin = 'moyin-recovery:' + str(uuid4())
            with self.tx():
                self.db.execute('UPDATE moyin_recovery_intent SET state=?,items=?,admission_origin=? WHERE member=?',
                    ('admission_unknown',json.dumps([{**item,'receipt':'not_sent'} for item in items]),origin,member))
            decision = self.sessions.admit_work(member,'moyin_recovery',origin=origin,instances=binding['instances'],
                require_entry=True,expected_pod_uid=binding['pod_uid'],allow_reopen=False)
            if decision.get('decision') != 'admitted':
                self.record(member,'not_admitted',detail=str(decision.get('decision')))
            else:
                operation = decision.get('operation_id')
                if not isinstance(operation,str) or not operation or decision.get('epoch') != binding['epoch']:
                    raise ValueError('Admission binding changed')
                self.record(member,'postcheck_pending',operation)
                # Point-in-time post-admission check, not a future send permission.
                with self.sessions.lock:
                    self.sessions.db.execute('BEGIN IMMEDIATE')
                    try:
                        runtime = self.sessions.db.execute('SELECT state,epoch FROM member_runtime WHERE member=?',(member,)).fetchone()
                        work = self.sessions.db.execute('SELECT member,kind,epoch FROM member_work WHERE id=?',(operation,)).fetchone()
                        entry = self.sessions.db.execute('SELECT state,pod_uid FROM member_entry WHERE member=?',(member,)).fetchone()
                        components = dict(self.sessions.db.execute('SELECT component,instance FROM member_component WHERE member=? AND epoch=?',
                                                                   (member,binding['epoch'])).fetchall())
                        if (runtime is None or runtime['state'] != 'ready' or runtime['epoch'] != binding['epoch']
                                or work is None or work['member'] != member or work['kind'] != 'moyin_recovery'
                                or work['epoch'] != binding['epoch'] or entry is None or entry['state'] != 'active'
                                or entry['pod_uid'] != binding['pod_uid'] or components != binding['instances']):
                            raise ValueError('Post-admission identity changed')
                    finally:
                        self.sessions.db.rollback()
                self.record(member,'reserved_verified_not_sent',operation)
        except Exception as error:
            self.record(member,'unknown',detail=type(error).__name__)
        return self.read(opaque_session)

    def reconcile(self, opaque_session):
        """Recover only the exact work ID; never send, admit, finish or retire.

        Origin correlates storage, not authentication. Zero matches can mean an
        in-flight admission. Legacy rows have no provable correlation. Both stay
        unresolved. A retained guard is not a currently verified send permission.
        """
        resolved = self.context(opaque_session)
        if resolved is None:
            return self.read(opaque_session)
        binding, _ = resolved
        member = binding['member']
        # Admission takes the session lock before beginning a SQLite write.
        # Keep the same order when both stores use the same database file.
        with self.sessions.lock:
            with self.tx():
                row = self.db.execute('SELECT * FROM moyin_recovery_intent WHERE member=?',(member,)).fetchone()
                if row is not None:
                    if json.loads(row['binding']) != binding:
                        raise ValueError('Existing operation has a different binding')
                    origin = row['admission_origin']
                    if (origin and row['protection_id'] is None
                            and row['state'] in ('admission_unknown','unknown','admission_unresolved')):
                        self.sessions.db.execute('BEGIN')
                        try:
                            matches = self.sessions.db.execute('SELECT id,member,kind,epoch FROM member_work WHERE origin=?',(origin,)).fetchall()
                        finally:
                            self.sessions.db.rollback()
                        exact = (len(matches) == 1 and matches[0]['member'] == member
                                 and matches[0]['kind'] == 'moyin_recovery' and matches[0]['epoch'] == binding['epoch'])
                        if exact:
                            self.db.execute('UPDATE moyin_recovery_intent SET state=?,protection_id=?,detail=? WHERE member=?',
                                            ('reconciled_guard_retained',matches[0]['id'],'Correlation only; not send permission',member))
                        else:
                            self.db.execute('UPDATE moyin_recovery_intent SET state=?,detail=? WHERE member=?',
                                            ('admission_unresolved','No unique matching original guard; retain uncertainty',member))
                    # Known guards, item receipts and uncorrelated legacy rows stay untouched.
        return self.read(opaque_session)

    def inspect_protected_items(self, opaque_session):
        """Read current guard and original IDs; NEVER a send/restore permit.

        Host resolution remains a precondition. This point-in-time check cannot
        authenticate a runner, establish parent linkage, or protect a later RPC.
        Even a matching snapshot leaves delivery and release disabled.
        """
        saved = self.read(opaque_session)
        result = {**saved, 'guard_current': False, 'items_current': False,
                  'consumer_ready': False}
        if saved['state'] != 'reserved_verified_not_sent':
            return result
        resolved = self.context(opaque_session)
        binding, inventory = resolved
        if binding != saved['binding']:
            return result
        try:
            with self.sessions.lock:
                self.sessions.db.execute('BEGIN')
                try:
                    runtime = self.sessions.db.execute('SELECT state,epoch FROM member_runtime WHERE member=?',(binding['member'],)).fetchone()
                    entry = self.sessions.db.execute('SELECT state,pod_uid FROM member_entry WHERE member=?',(binding['member'],)).fetchone()
                    work = self.sessions.db.execute('SELECT member,kind,epoch,ended FROM member_work WHERE id=?',(saved['protection_id'],)).fetchone()
                    components = dict(self.sessions.db.execute('SELECT component,instance FROM member_component WHERE member=? AND epoch=?',
                                                               (binding['member'],binding['epoch'])).fetchall())
                    result['guard_current'] = bool(runtime and runtime['state'] == 'ready' and runtime['epoch'] == binding['epoch']
                        and entry and entry['state'] == 'active' and entry['pod_uid'] == binding['pod_uid']
                        and work and work['member'] == binding['member'] and work['kind'] == 'moyin_recovery'
                        and work['epoch'] == binding['epoch'] and work['ended'] == 0 and components == binding['instances'])
                finally:
                    self.sessions.db.rollback()
            # A fresh private-inventory read prevents treating a replaced upstream
            # ID as the reserved original. It does NOT prove its parent operation.
            with sqlite3.connect(Path(inventory).resolve().as_uri() + '?mode=ro',uri=True) as db:
                rows = db.execute('SELECT id,upstream_id,state FROM media_jobs').fetchall()
            result['items_current'] = bool(saved['items']) and all(
                item.get('mode') == 'poll_original' and item.get('receipt') == 'not_sent'
                and isinstance(item.get('upstream_id'),str) and bool(item['upstream_id'].strip())
                and len([r for r in rows if r[0] == item.get('media_id')]) == 1
                and any(r[0] == item.get('media_id') and r[1] == item['upstream_id']
                        and r[2] in ('pending','waiting','running') for r in rows)
                for item in saved['items'])
        except (sqlite3.Error, OSError, ValueError):
            result['guard_current'] = result['items_current'] = False
        return result

    def retain_unknown_receipt(self, opaque_session, *, protection_id, media_id, upstream_id):
        """Persist uncertainty for an EXACT reserved original item, not a send log.

        No success receipt contract exists yet. Unknown records can only retain
        protection; this method never asserts that a request was sent, releases
        work, re-admits, or enables a replay. Binding comes from the host resolver.
        """
        resolved = self.context(opaque_session)
        if resolved is None:
            return self.read(opaque_session)
        binding, _ = resolved
        with self.tx():
            row = self.db.execute('SELECT * FROM moyin_recovery_intent WHERE member=?',(binding['member'],)).fetchone()
            if row is None or json.loads(row['binding']) != binding or row['protection_id'] != protection_id or not protection_id:
                raise ValueError('Unknown receipt does not match reserved protection/binding')
            if row['state'] not in ('reserved_verified_not_sent','unknown'):
                raise ValueError('Operation is not receipt eligible')
            items = json.loads(row['items'])
            matches = [item for item in items if item.get('media_id') == media_id and item.get('upstream_id') == upstream_id
                       and item.get('mode') == 'poll_original']
            if len(matches) != 1:
                raise ValueError('Unknown receipt does not match one reserved original item')
            matches[0]['receipt'] = 'unknown'
            self.db.execute("UPDATE moyin_recovery_intent SET state='unknown',items=?,detail=CASE WHEN detail='' THEN 'Original query receipt unavailable; sent status not established' ELSE detail END WHERE member=?",
                            (json.dumps(items),binding['member']))
        return self.read(opaque_session)
