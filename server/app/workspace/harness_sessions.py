"""Opaque one-use launch tickets and encrypted, revocable runtime sessions.

It also holds the member-runtime coordination rows: the shared, short
transactions every process uses to admit work and to agree on a scale-down.
The web process and the broker process each open this same file, so a member's
busy state and its drain epoch are visible across process boundaries without
any new service or lock.
"""
import hashlib
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from app.creative.creative_render import APPLIED, NOT_APPLIED, UNKNOWN
from app.identity.auth import AuthError

# Runtime states a member environment can be in. READY means resident and
# accepting business; the others are transient or terminal.
SLEEPING, STARTING, READY, DRAINING, FAILED = 'sleeping', 'starting', 'ready', 'draining', 'failed'
# The three member-side components whose closed-and-idle confirmation a
# scale-down requires. Anything else in a confirmation set is refused.
COMPONENTS = ('connector', 'bridge', 'canvas')


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


class HarnessSessions:
    def __init__(self, path: Path, key: str):
        self.cipher = Fernet(key.encode()) if key else None
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA busy_timeout=5000')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS launches (hash TEXT PRIMARY KEY, member TEXT, origin TEXT, token BLOB, expires INTEGER);
          CREATE TABLE IF NOT EXISTS runtimes (hash TEXT PRIMARY KEY, member TEXT, origin TEXT, token BLOB, main_hash TEXT, expires INTEGER, revoked INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS member_runtime (
            member TEXT PRIMARY KEY, state TEXT NOT NULL, replicas INTEGER NOT NULL DEFAULT 1,
            activity INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
            scale TEXT NOT NULL DEFAULT '', scale_result TEXT NOT NULL DEFAULT '',
            wake TEXT NOT NULL DEFAULT '', idle_ms INTEGER NOT NULL DEFAULT 0,
            owner TEXT NOT NULL DEFAULT '', observed INTEGER NOT NULL DEFAULT 0,
            reopen INTEGER NOT NULL DEFAULT 0,
            op_id TEXT NOT NULL DEFAULT '', op_epoch INTEGER NOT NULL DEFAULT 0,
            op_target INTEGER NOT NULL DEFAULT 0, op_started INTEGER NOT NULL DEFAULT 0,
            done_op TEXT NOT NULL DEFAULT '', done_epoch INTEGER NOT NULL DEFAULT 0,
            done_result TEXT NOT NULL DEFAULT '');
          CREATE TABLE IF NOT EXISTS member_foreground_activity (
            member TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS member_work (
            id TEXT PRIMARY KEY, member TEXT NOT NULL, kind TEXT NOT NULL,
            origin TEXT NOT NULL DEFAULT '', epoch INTEGER NOT NULL DEFAULT 0,
            started INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS member_component (
            member TEXT NOT NULL, epoch INTEGER NOT NULL, component TEXT NOT NULL,
            instance TEXT NOT NULL DEFAULT '', PRIMARY KEY (member, epoch, component));
          CREATE TABLE IF NOT EXISTS member_entry (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL, touched INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL DEFAULT 0,
            pod_uid TEXT NOT NULL DEFAULT '', pod_name TEXT NOT NULL DEFAULT '',
            requested INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS member_unpause (
            member TEXT PRIMARY KEY, deployment_uid TEXT NOT NULL,
            resource_version TEXT NOT NULL, generation INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS member_memory_control (
            id INTEGER PRIMARY KEY CHECK (id=1), active INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS member_idle_checkpoint (member TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS member_start_failure (
            member TEXT PRIMARY KEY, pod_uid TEXT NOT NULL, detail TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS member_start_unknown (member TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS member_memory_wait (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL UNIQUE,
            member TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
            resource_name TEXT NOT NULL, object_name TEXT NOT NULL,
            minimum_bytes INTEGER NOT NULL, desired_bytes INTEGER NOT NULL, touched INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS member_memory_cancel (
            operation TEXT PRIMARY KEY, member TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS member_plugin_reclaim (
            operation TEXT PRIMARY KEY, member TEXT NOT NULL UNIQUE, resource_id TEXT NOT NULL,
            resource_name TEXT NOT NULL, object_name TEXT NOT NULL, instance TEXT NOT NULL,
            epoch INTEGER NOT NULL, phase TEXT NOT NULL, old_limit INTEGER NOT NULL, base_bytes INTEGER NOT NULL,
            container_id TEXT NOT NULL, restart_count INTEGER NOT NULL, legacy INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS member_memory_claim (
            operation TEXT PRIMARY KEY, member TEXT NOT NULL, kind TEXT NOT NULL,
            resource_id TEXT NOT NULL, resource_name TEXT NOT NULL, object_name TEXT NOT NULL,
            minimum_bytes INTEGER NOT NULL, desired_bytes INTEGER NOT NULL,
            granted_bytes INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'reserved',
            sent INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
            target_request INTEGER NOT NULL DEFAULT 0, target_limit INTEGER NOT NULL DEFAULT 0,
            job_uid TEXT NOT NULL DEFAULT '',
            reclaim_request INTEGER NOT NULL DEFAULT 0, reclaim_limit INTEGER NOT NULL DEFAULT 0,
            reclaim_epoch INTEGER NOT NULL DEFAULT 0);''')
        self._migrate()
        self.db.commit()

    def _migrate(self):
        """Add the coordination columns an existing database is missing.

        Existing rows are preserved: a member that already had a wake, a scale
        or an epoch keeps all of them, and the new columns simply describe the
        operation that is already recorded there. Nothing is rebuilt or cleared.
        """
        columns = {row['name'] for row in self.db.execute('PRAGMA table_info(member_runtime)')}
        for name, definition in {
                'op_id': "TEXT NOT NULL DEFAULT ''", 'op_epoch': 'INTEGER NOT NULL DEFAULT 0',
                'op_target': 'INTEGER NOT NULL DEFAULT 0', 'op_started': 'INTEGER NOT NULL DEFAULT 0',
                'done_op': "TEXT NOT NULL DEFAULT ''", 'done_epoch': 'INTEGER NOT NULL DEFAULT 0',
                'done_result': "TEXT NOT NULL DEFAULT ''"}.items():
            if name not in columns:
                self.db.execute('ALTER TABLE member_runtime ADD COLUMN ' + name + ' ' + definition)
        runtime_columns = {row['name'] for row in self.db.execute('PRAGMA table_info(runtimes)')}
        if 'admission_required' not in runtime_columns:
            try:
                self.db.execute('ALTER TABLE runtimes ADD COLUMN admission_required INTEGER NOT NULL DEFAULT 0')
            except sqlite3.OperationalError:
                if 'admission_required' not in {row['name'] for row in self.db.execute('PRAGMA table_info(runtimes)')}:
                    raise

    def issue(self, member, origin):
        if self.cipher is None:
            raise AuthError(503, 'DSH 会话配置尚未就绪')
        ticket = secrets.token_urlsafe(32)
        with self.lock:
            self.db.execute('DELETE FROM launches WHERE expires<?', (time.time(),))
            self.db.execute('INSERT INTO launches VALUES (?,?,?,?,?)', (digest(ticket), member.member_id, origin, self.cipher.encrypt(member.access_token.encode()), time.time()+30))
            self.db.commit()
        return ticket

    def consume(self, ticket, origin, *, admission_required=False):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT * FROM launches WHERE hash=?', (digest(ticket),)).fetchone()
            if row is None or row['origin'] != origin or row['expires'] < time.time():
                self.db.rollback()
                raise AuthError(401, 'DSH 启动凭据已失效，请重新打开')
            self.db.execute('DELETE FROM launches WHERE hash=?', (digest(ticket),))
            token = secrets.token_urlsafe(32)
            main = self.cipher.decrypt(row['token']).decode()
            self.db.execute('INSERT INTO runtimes (hash,member,origin,token,main_hash,expires,admission_required) '
                            'VALUES (?,?,?,?,?,?,?)',
                (digest(token), row['member'], origin, row['token'], digest(main), time.time()+12*3600,
                 int(admission_required)))
            self.db.commit()
        return token, row['member']

    def resolve(self, token, origin=None, member_id=None, *, include_admission=False):
        with self.lock:
            row = self.db.execute('SELECT * FROM runtimes WHERE hash=?', (digest(token),)).fetchone()
        if row is None or row['revoked'] or row['expires'] <= time.time() or (origin and row['origin'] != origin) or (member_id and row['member'] != member_id):
            raise AuthError(401, 'DSH 会话已失效，请重新登录')
        try:
            main = self.cipher.decrypt(row['token']).decode()
        except (InvalidToken, AttributeError):
            raise AuthError(401, 'DSH 会话已失效')
        if include_admission:
            return main, row['member'], bool(row['admission_required'])
        return main, row['member']

    def revoke_main(self, token):
        with self.lock:
            self.db.execute('UPDATE runtimes SET revoked=1 WHERE main_hash=?', (digest(token),))
            self.db.commit()

    # Member-runtime coordination. Every method is one short BEGIN IMMEDIATE
    # transaction: the state check and the row it decides on are never split, so
    # no process can pass a check and then lose the race to a counter it read a
    # moment earlier. The write lock is held for one local transaction only,
    # never across a network call. No work row is ever removed by a timeout: an
    # unknown leftover keeps its member closed until an operator clears it.
    def _row(self, member):
        return self.db.execute('SELECT * FROM member_runtime WHERE member=?', (member,)).fetchone()

    def memory_active(self):
        with self.lock:
            row = self.db.execute('SELECT active FROM member_memory_control WHERE id=1').fetchone()
        return bool(row and row['active'] == 1)

    def start_failure(self, member):
        with self.lock:
            row = self.db.execute('SELECT * FROM member_start_failure WHERE member=?', (member,)).fetchone()
        return dict(row) if row else None

    def start_unknown(self, member):
        with self.lock:
            row = self.db.execute('SELECT 1 FROM member_start_unknown WHERE member=?', (member,)).fetchone()
        return row is not None

    def mark_start_unknown(self, member):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            entry = self.db.execute('SELECT state FROM member_entry WHERE member=?', (member,)).fetchone()
            if row and entry and entry['state'] == 'starting' and (row['wake'] or row['scale']):
                self.db.execute('INSERT OR REPLACE INTO member_start_unknown VALUES (?)', (member,))
            self.db.commit()

    def retry_failed_entry(self, member):
        """A user retry clears the error only after confirmed retirement."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            runtime = self._row(member)
            if (runtime is None or runtime['state'] != SLEEPING or runtime['replicas'] != 0
                    or runtime['scale'] or runtime['wake'] or runtime['reopen']
                    or self.db.execute('SELECT 1 FROM member_entry WHERE member=?', (member,)).fetchone()
                    or self.db.execute('SELECT 1 FROM member_unpause WHERE member=?', (member,)).fetchone()):
                self.db.rollback()
                return False
            changed = self.db.execute('DELETE FROM member_start_failure WHERE member=?', (member,)).rowcount
            self.db.commit()
        return changed == 1

    def begin_failed_start_retirement(self, member, pod_uid, detail):
        """Retire an unadmitted failed start only after a recorded idle drain."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            entry = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            idle = self.db.execute('SELECT 1 FROM member_idle_checkpoint WHERE member=?', (member,)).fetchone()
            if (not row or not entry or not idle or entry['state'] != 'starting'
                    or (entry['pod_uid'] and entry['pod_uid'] != pod_uid)
                    or not row['wake'] or row['scale'] or row['reopen'] or row['op_target'] != 1
                    or self.db.execute('SELECT 1 FROM member_work WHERE member=?', (member,)).fetchone()
                    or self.db.execute('SELECT 1 FROM member_memory_claim WHERE member=?', (member,)).fetchone()):
                self.db.rollback()
                return None
            operation = secrets.token_urlsafe(16)
            self.db.execute('INSERT OR REPLACE INTO member_start_failure VALUES (?,?,?)', (member, pod_uid, detail))
            self.db.execute('DELETE FROM member_start_unknown WHERE member=?', (member,))
            self.db.execute("UPDATE member_entry SET state='retiring',requested=0,pod_uid=? WHERE member=?",
                            (pod_uid, member))
            self.db.execute('UPDATE member_runtime SET state=?,done_op=?,done_epoch=?,done_result=?,wake=?, '
                            'scale=?,op_id=?,op_epoch=?,op_target=0,op_started=0,scale_result=? WHERE member=?',
                            (DRAINING, row['wake'], row['op_epoch'], 'failed', '', '0', operation,
                             row['epoch'], '', member))
            self.db.commit()
        return operation

    def retry_failed_start_retirement(self, member):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            failed = self.db.execute('SELECT 1 FROM member_start_failure WHERE member=?', (member,)).fetchone()
            entry = self.db.execute('SELECT state FROM member_entry WHERE member=?', (member,)).fetchone()
            if (not row or not failed or not entry or entry['state'] != 'retiring'
                    or row['scale'] or row['wake'] or not row['observed'] or row['replicas'] == 0):
                self.db.rollback()
                return None
            operation = secrets.token_urlsafe(16)
            self.db.execute('UPDATE member_runtime SET scale=?,op_id=?,op_epoch=?,op_target=0,'
                            'op_started=0,scale_result=? WHERE member=?', ('0', operation, row['epoch'], '', member))
            self.db.commit()
        return operation

    def activate_memory(self):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('INSERT INTO member_memory_control (id,active) VALUES (1,1) '
                            'ON CONFLICT(id) DO UPDATE SET active=1')
            self.db.commit()

    def _memory_reclaiming(self, member):
        return self.db.execute("SELECT 1 FROM member_memory_claim c WHERE c.member=? AND c.state='reclaiming' "
                               "AND NOT EXISTS (SELECT 1 FROM member_plugin_reclaim p WHERE p.operation=c.operation) LIMIT 1",
                               (member,)).fetchone() is not None

    def plugin_reclaims(self):
        with self.lock:
            rows = self.db.execute('SELECT * FROM member_plugin_reclaim').fetchall()
        return [dict(row) for row in rows]

    def plugin_reclaim(self, operation):
        with self.lock:
            row = self.db.execute('SELECT * FROM member_plugin_reclaim WHERE operation=?', (operation,)).fetchone()
        return dict(row) if row else None

    def begin_plugin_reclaim(self, operation, member, uid, name, pod_name, instance, old_request, old_limit, base_bytes,
                             container_id, restart_count):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            entry = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            other = self.db.execute("SELECT 1 FROM member_memory_claim WHERE operation!=? AND kind='container' "
                                    'AND resource_id=? AND resource_name=?', (operation, uid, name)).fetchone()
            if (not row or row['state'] != READY or row['scale'] or row['wake'] or row['reopen']
                    or not entry or entry['state'] != 'active' or entry['pod_uid'] != uid or other
                    or self._memory_reclaiming(member)
                    or self.db.execute('SELECT 1 FROM member_plugin_reclaim WHERE member=?', (member,)).fetchone()
                    or not instance or not uid or not pod_name or not name
                    or not container_id or not isinstance(restart_count, int) or restart_count < 0
                    or not isinstance(old_request, int) or not isinstance(old_limit, int)
                    or not isinstance(base_bytes, int) or base_bytes <= 0
                    or old_request <= 0 or old_limit < old_request
                    or (claim and (claim['member'] != member or claim['kind'] != 'container'
                        or claim['resource_id'] != uid or claim['resource_name'] != name
                        or claim['object_name'] != pod_name or claim['state'] != 'active'))):
                self.db.rollback()
                return None
            epoch = row['epoch'] + 1
            legacy = claim is None
            if claim:
                self.db.execute("UPDATE member_memory_claim SET state='reclaiming',sent=0,"
                                'granted_bytes=MAX(granted_bytes,?),reclaim_epoch=? WHERE operation=?',
                                (old_limit, epoch, operation))
            else:
                self.db.execute('INSERT INTO member_memory_claim '
                                '(operation,member,kind,resource_id,resource_name,object_name,minimum_bytes,'
                                'desired_bytes,granted_bytes,state,sent,reclaim_epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                                (operation, member, 'container', uid, name, pod_name, old_limit, old_limit,
                                 old_limit, 'reclaiming', 0, epoch))
            self.db.execute('INSERT INTO member_plugin_reclaim VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            (operation, member, uid, name, pod_name, instance, epoch, 'draining', old_limit,
                             base_bytes, container_id, restart_count, int(legacy)))
            # Reserve both the drain and reopen epochs against whole-member sleep.
            self.db.execute('UPDATE member_runtime SET epoch=? WHERE member=?', (epoch+1, member))
            self.db.commit()
        return epoch

    def replace_plugin_instance(self, operation, old_instance, new_instance, container_id, restart_count):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("UPDATE member_plugin_reclaim SET instance=?,container_id=?,restart_count=? "
                                      "WHERE operation=? AND phase='reopening' AND instance=?",
                                      (new_instance, container_id, restart_count, operation, old_instance)).rowcount
            self.db.commit()
        return changed == 1

    def start_plugin_resize(self, operation, request_bytes, limit_bytes):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            marker = self.db.execute('SELECT * FROM member_plugin_reclaim WHERE operation=?', (operation,)).fetchone()
            if not marker or marker['phase'] != 'draining':
                self.db.rollback()
                return False
            changed = self.db.execute("UPDATE member_memory_claim SET sent=1,reclaim_request=?,reclaim_limit=? "
                                      "WHERE operation=? AND state='reclaiming' AND sent=0",
                                      (request_bytes, limit_bytes, operation)).rowcount
            if not changed:
                self.db.rollback()
                return False
            self.db.execute("UPDATE member_plugin_reclaim SET phase='resizing' WHERE operation=?", (operation,))
            self.db.commit()
        return True

    def reopen_plugin_reclaim(self, operation):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            marker = self.db.execute('SELECT * FROM member_plugin_reclaim WHERE operation=?', (operation,)).fetchone()
            claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            if (not marker or (marker['phase'] == 'resizing' and claim and claim['state'] == 'reclaiming')):
                self.db.rollback()
                return False
            self.db.execute("UPDATE member_plugin_reclaim SET phase='reopening' WHERE operation=?", (operation,))
            self.db.commit()
        return True

    def finish_plugin_reclaim(self, operation):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            marker = self.db.execute('SELECT * FROM member_plugin_reclaim WHERE operation=?', (operation,)).fetchone()
            claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            if not marker or marker['phase'] != 'reopening' or (claim and claim['state'] == 'reclaiming' and claim['sent']):
                self.db.rollback()
                return False
            if claim and marker['legacy']:
                self.db.execute('DELETE FROM member_memory_claim WHERE operation=?', (operation,))
            elif claim and claim['state'] == 'reclaiming':
                self.db.execute("UPDATE member_memory_claim SET state='active',sent=1,"
                                'reclaim_request=0,reclaim_limit=0,reclaim_epoch=0 WHERE operation=?', (operation,))
            self.db.execute('DELETE FROM member_plugin_reclaim WHERE operation=?', (operation,))
            self.db.commit()
        return True

    def discard_plugin_reclaim(self, operation, uid):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            marker = self.db.execute('SELECT * FROM member_plugin_reclaim WHERE operation=? AND resource_id=?',
                                     (operation, uid)).fetchone()
            if not marker:
                self.db.rollback()
                return False
            self.db.execute('DELETE FROM member_memory_claim WHERE operation=? AND resource_id=?', (operation, uid))
            self.db.execute('DELETE FROM member_plugin_reclaim WHERE operation=?', (operation,))
            self.db.commit()
        return True

    def runtime_state(self, member):
        """The member's committed state, or FAILED when nothing confirmed it."""
        with self.lock:
            row = self._row(member)
        return row['state'] if row else FAILED

    def runtime_row(self, member):
        with self.lock:
            row = self._row(member)
        return dict(row) if row else None

    def _pending_memory(self, snapshot):
        targets, job_uids = {}, {}
        for row in self.db.execute('SELECT * FROM member_memory_claim').fetchall():
            key = (row['kind'], row['resource_id'], row['resource_name'])
            targets[key] = max(targets.get(key, 0), row['granted_bytes'])
            if row['kind'] == 'job':
                job_uids.setdefault(key, set()).add(row['job_uid'])
        requests = snapshot['requests']
        observed_jobs = snapshot.get('job_uids', {})
        pending = 0
        for key, target in targets.items():
            observed = requests.get(key, 0)
            if (key[0] == 'job' and (not job_uids.get(key) or '' in job_uids[key]
                    or job_uids[key] != {observed_jobs.get(key[1])})):
                observed = 0
            if not isinstance(observed, int) or observed < 0:
                raise ValueError('Invalid observed memory request')
            pending += max(0, target - observed)
        return pending, targets, job_uids

    def _pending_entries(self, snapshot):
        pending = 0
        members = snapshot.get('member_pods', {})
        for row in self.db.execute("SELECT * FROM member_entry WHERE state!='waiting'").fetchall():
            pods = members.get(row['member'], [])
            if row['pod_uid']:
                represented = next((pod['bytes'] for pod in pods if pod['uid'] == row['pod_uid']), 0)
            else:
                represented = pods[0]['bytes'] if len(pods) == 1 else 0
            pending += max(0, row['reserved_bytes'] - represented)
        return pending

    def _work_borrowed(self, snapshot):
        targets = {}
        for row in self.db.execute('SELECT * FROM member_memory_claim').fetchall():
            key = (row['kind'], row['resource_id'], row['resource_name'])
            base = (snapshot.get('base_limits', {}).get((row['member'], row['resource_name']), 0)
                    if row['kind'] == 'container' else 0)
            targets[key] = max(targets.get(key, 0), max(0, row['granted_bytes'] - base))
        return sum(targets.values())

    def entry(self, member):
        with self.lock:
            row = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
        return dict(row) if row else None

    def _has_memory_waiters(self):
        now = int(time.time())
        return bool(self.db.execute("SELECT 1 FROM member_entry WHERE state='waiting' AND touched>=? LIMIT 1",
                                    (now - 180,)).fetchone()
                    or self.db.execute("SELECT 1 FROM member_memory_wait WHERE kind='job' OR touched>=? LIMIT 1",
                                       (now - 180,)).fetchone())

    def memory_waiters(self):
        with self.lock:
            return self._has_memory_waiters()

    def resident_inventory(self):
        """Read both coordination ledgers from one SQLite snapshot, without renewal."""
        with self.lock:
            self.db.execute('BEGIN')
            try:
                records = {}
                for table, key in (('member_entry', 'entry'), ('member_runtime', 'runtime')):
                    for row in self.db.execute('SELECT * FROM ' + table):
                        records.setdefault(row['member'], {})[key] = dict(row)
                return records
            finally:
                self.db.rollback()

    def warm_candidates(self, idle_ms, *, newest=True, limit=None):
        """Order idle member-owned Pods by recorded foreground use, not startup observations."""
        order = 'DESC' if newest else 'ASC'
        with self.lock:
            rows = self.db.execute(
                "SELECT r.member,e.pod_uid FROM member_runtime r JOIN member_entry e ON e.member=r.member "
                "LEFT JOIN member_foreground_activity f ON f.member=r.member "
                "WHERE r.state=? AND r.observed=1 AND r.replicas=1 AND r.scale='' AND r.wake='' "
                "AND r.reopen=0 AND e.state='active' AND e.pod_uid!='' AND r.activity<=? "
                "AND NOT EXISTS (SELECT 1 FROM member_work w WHERE w.member=r.member) "
                "ORDER BY COALESCE(f.last_seen,0) " + order + ",r.member",
                (READY, time.time() - idle_ms / 1000)).fetchall()
        result = [dict(row) for row in rows]
        return result if limit is None else result[:limit]

    def keep_warm(self, member, uid, snapshot, idle_ms, limit):
        """Protect a recent idle Pod only while spare entry and work budgets remain."""
        if (limit <= 0 or not uid or not isinstance(snapshot, dict)
                or not isinstance(snapshot.get('member_pods'), dict)
                or not isinstance(snapshot.get('templates'), dict)
                or not isinstance(snapshot.get('requests'), dict)
                or not isinstance(snapshot.get('allocatable_bytes'), int)
                or not isinstance(snapshot.get('used_bytes'), int)):
            return False
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if self._has_memory_waiters():
                    return False
                rows = self.db.execute(
                    "SELECT r.member,e.pod_uid FROM member_runtime r JOIN member_entry e ON e.member=r.member "
                    "LEFT JOIN member_foreground_activity f ON f.member=r.member "
                    "WHERE r.state=? AND r.observed=1 AND r.replicas=1 AND r.scale='' AND r.wake='' "
                    "AND r.reopen=0 AND e.state='active' AND e.pod_uid!='' AND r.activity<=? "
                    "AND NOT EXISTS (SELECT 1 FROM member_work w WHERE w.member=r.member) "
                    "ORDER BY COALESCE(f.last_seen,0) DESC,r.member LIMIT ?",
                    (READY, time.time() - idle_ms / 1000, limit)).fetchall()
                if not any(row['member'] == member and row['pod_uid'] == uid for row in rows):
                    return False
                pods = snapshot['member_pods'].get(member, [])
                if len(pods) != 1 or pods[0].get('uid') != uid:
                    return False
                entries = {row['member'] for row in self.db.execute(
                    "SELECT member FROM member_entry WHERE state!='waiting'").fetchall()}
                spare = []
                for other, template in snapshot['templates'].items():
                    if other == member or other in entries or snapshot['member_pods'].get(other):
                        continue
                    if (not isinstance(template, dict) or template.get('paused') is not False
                            or template.get('observed') is not True
                            or not isinstance(template.get('bytes'), int) or template['bytes'] <= 0):
                        return False
                    spare.append(template['bytes'])
                pending, _, _ = self._pending_memory(snapshot)
                pending += self._pending_entries(snapshot)
                headroom = max(0, snapshot.get('work_headroom', 0) - self._work_borrowed(snapshot))
                return (snapshot['used_bytes'] + pending + max(spare, default=0) + headroom
                        <= snapshot['allocatable_bytes'] * 10 // 13)
            finally:
                self.db.rollback()

    def request_entry(self, member, *, wait_timeout=180):
        """Enqueue one member once; active/reconnecting members keep their place."""
        now = int(time.time())
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute("DELETE FROM member_entry WHERE state='waiting' AND touched<?", (now-wait_timeout,))
            row = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            if row is None:
                self.db.execute("INSERT INTO member_entry (member,state,touched) VALUES (?,'waiting',?)", (member, now))
            elif row['state'] == 'retiring':
                self.db.execute('UPDATE member_entry SET requested=CASE WHEN requested=2 THEN 2 ELSE 1 END,'
                                'touched=? WHERE member=?', (now, member))
            else:
                self.db.execute('UPDATE member_entry SET touched=? WHERE member=?', (now, member))
            if row and (row['state'] in {'active', 'starting'}
                        or (row['state'] == 'retiring' and row['requested'] != 2)):
                self.db.execute('UPDATE member_runtime SET activity=? WHERE member=?', (now, member))
            row = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            self.db.commit()
        return dict(row)

    def request_restore(self, member):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("UPDATE member_entry SET requested=1,touched=? "
                                      "WHERE member=? AND state='retiring'", (int(time.time()), member)).rowcount
            self.db.commit()
        return changed == 1

    def cancel_entry(self, member):
        """Cancel only a waiting request; a sent operation keeps its budget."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("DELETE FROM member_entry WHERE member=? AND state='waiting'", (member,)).rowcount
            self.db.commit()
        return changed == 1

    def begin_unpause(self, member, uid, version, generation):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute('INSERT OR IGNORE INTO member_unpause VALUES (?,?,?,?)',
                                      (member, uid, version, generation)).rowcount
            self.db.commit()
        return changed == 1

    def unpause(self, member):
        with self.lock:
            row = self.db.execute('SELECT * FROM member_unpause WHERE member=?', (member,)).fetchone()
        return dict(row) if row else None

    def reject_unpause(self, member, uid, version):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('DELETE FROM member_unpause WHERE member=? AND deployment_uid=? AND resource_version=?',
                            (member, uid, version))
            self.db.commit()

    def finish_retirement(self, member, uid, generation, template_bytes):
        """Release or retain a retired lease only after the old Pods are gone."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            marker = self.db.execute('SELECT * FROM member_unpause WHERE member=?', (member,)).fetchone()
            if marker and (marker['deployment_uid'] != uid or marker['generation'] > generation):
                self.db.rollback()
                return False
            row = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            if row and row['state'] == 'retiring':
                failure = self.db.execute('SELECT 1 FROM member_start_failure WHERE member=?', (member,)).fetchone()
                if failure:
                    self.db.execute('DELETE FROM member_entry WHERE member=?', (member,))
                elif row['requested'] == 2:
                    self.db.execute("UPDATE member_entry SET state='waiting',reserved_bytes=0,pod_uid='',pod_name='',"
                                    'requested=0 WHERE member=?', (member,))
                elif row['requested']:
                    if not isinstance(template_bytes, int) or template_bytes <= 0:
                        self.db.rollback()
                        return False
                    self.db.execute("UPDATE member_entry SET state='starting',reserved_bytes=?,pod_uid='',pod_name='',"
                                    'requested=0 WHERE member=?', (template_bytes, member))
                else:
                    self.db.execute('DELETE FROM member_entry WHERE member=?', (member,))
            self.db.execute('DELETE FROM member_unpause WHERE member=?', (member,))
            self.db.commit()
        return True

    def reserve_entry(self, member, snapshot):
        """Reserve the FIFO head's whole member Pod before waking it."""
        if (not isinstance(snapshot, dict) or not isinstance(snapshot.get('requests'), dict)
                or not isinstance(snapshot.get('member_pods'), dict) or not isinstance(snapshot.get('templates'), dict)
                or not isinstance(snapshot.get('allocatable_bytes'), int) or snapshot['allocatable_bytes'] <= 0
                or not isinstance(snapshot.get('used_bytes'), int) or snapshot['used_bytes'] < 0):
            raise ValueError('Invalid member budget snapshot')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                row = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
                if row is None or row['state'] != 'waiting':
                    self.db.rollback()
                    return {'decision': row['state'] if row else 'cancelled'}
                first = self.db.execute("SELECT member FROM member_entry WHERE state='waiting' ORDER BY sequence LIMIT 1").fetchone()
                if first is None or first['member'] != member:
                    self.db.rollback()
                    return {'decision': 'queued'}
                self.db.execute("DELETE FROM member_memory_wait WHERE kind='container' AND touched<?", (int(time.time())-180,))
                if self.db.execute('SELECT 1 FROM member_memory_wait LIMIT 1').fetchone():
                    self.db.commit()
                    return {'decision': 'queued'}
                if self.db.execute('SELECT 1 FROM member_unpause WHERE member=?', (member,)).fetchone():
                    self.db.rollback()
                    return {'decision': 'queued'}
                template = snapshot['templates'].get(member)
                pods = snapshot['member_pods'].get(member, [])
                if (not isinstance(template, dict) or template.get('paused') is not False
                        or template.get('observed') is not True
                        or not isinstance(template.get('bytes'), int) or template['bytes'] <= 0 or len(pods) > 1):
                    self.db.rollback()
                    return {'decision': 'queued'}
                observed = pods[0]['bytes'] if pods else 0
                target = max(template['bytes'], observed)
                pending, _, _ = self._pending_memory(snapshot)
                pending += self._pending_entries(snapshot)
                needed = max(0, target-observed)
                headroom = max(0, snapshot.get('work_headroom', 0) - self._work_borrowed(snapshot))
                if snapshot['used_bytes'] + pending + needed + headroom > snapshot['allocatable_bytes'] * 10 // 13:
                    self.db.rollback()
                    return {'decision': 'queued'}
                pod = pods[0] if pods else {}
                self.db.execute("UPDATE member_entry SET state='starting',reserved_bytes=?,pod_uid=?,pod_name=? "
                                'WHERE member=? AND state=\'waiting\'',
                                (target, pod.get('uid', ''), pod.get('name', ''), member))
                self.db.commit()
                return {'decision': 'starting'}
            except Exception:
                if self.db.in_transaction:
                    self.db.rollback()
                raise

    def activate_entry(self, member, pod_uid, pod_name, pod_bytes, present_uids=None):
        if not pod_uid or not pod_name or not isinstance(pod_bytes, int) or pod_bytes <= 0:
            return False
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            runtime = self._row(member)
            if (runtime is None or runtime['state'] != READY or runtime['scale'] or runtime['wake'] or runtime['reopen']
                    or row is None or row['state'] not in {'starting', 'active'}
                    or (row['pod_uid'] and row['pod_uid'] != pod_uid
                        and (not isinstance(present_uids, (tuple, list, set))
                             or pod_uid not in present_uids or row['pod_uid'] in present_uids))):
                self.db.rollback()
                return False
            self.db.execute("UPDATE member_entry SET state='active',pod_uid=?,pod_name=?,"
                            'reserved_bytes=MAX(reserved_bytes,?),requested=0 WHERE member=?',
                            (pod_uid, pod_name, pod_bytes, member))
            self.db.execute('DELETE FROM member_idle_checkpoint WHERE member=?', (member,))
            self.db.execute('DELETE FROM member_start_unknown WHERE member=?', (member,))
            self.db.commit()
        return True

    def rebind_entry(self, member, old_uid, pod_uid, pod_name, pod_bytes):
        """Move an active lease only after its old Pod was observed absent."""
        if not old_uid or not pod_uid or old_uid == pod_uid or not pod_name or not isinstance(pod_bytes, int) or pod_bytes <= 0:
            return False
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            runtime = self._row(member)
            if (not runtime or runtime['state'] != READY or runtime['scale'] or runtime['wake'] or runtime['reopen']):
                self.db.rollback()
                return False
            changed = self.db.execute("UPDATE member_entry SET pod_uid=?,pod_name=?,reserved_bytes=? "
                                      "WHERE member=? AND state='active' AND pod_uid=?",
                                      (pod_uid, pod_name, pod_bytes, member, old_uid)).rowcount
            self.db.commit()
        return changed == 1

    def adopt_entry(self, member, pod_uid, pod_name, pod_bytes):
        """Keep a verified legacy session on its already-resident Pod."""
        if not pod_uid or not pod_name or not isinstance(pod_bytes, int) or pod_bytes <= 0:
            return False
        now = int(time.time())
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            runtime = self._row(member)
            if (runtime is None or runtime['state'] != READY or runtime['scale'] or runtime['wake']
                    or runtime['reopen']):
                self.db.rollback()
                return False
            if row is None:
                self.db.execute("INSERT INTO member_entry (member,state,touched,reserved_bytes,pod_uid,pod_name) "
                                "VALUES (?,'active',?,?,?,?)", (member, now, pod_bytes, pod_uid, pod_name))
            elif row['state'] in {'waiting', 'active'} and (not row['pod_uid'] or row['pod_uid'] == pod_uid):
                self.db.execute("UPDATE member_entry SET state='active',touched=?,pod_uid=?,pod_name=?,"
                                'reserved_bytes=MAX(reserved_bytes,?) WHERE member=?',
                                (now, pod_uid, pod_name, pod_bytes, member))
            else:
                self.db.rollback()
                return False
            self.db.execute('DELETE FROM member_idle_checkpoint WHERE member=?', (member,))
            self.db.commit()
        return True

    def reserve_memory(self, operation, member, kind, resource_id, resource_name, object_name,
                       minimum_bytes, desired_bytes, snapshot):
        """Reserve a real consumer's target against one observed node budget.

        The snapshot is collected before this short transaction. Claims from
        every process, including any created after that snapshot, are counted
        here. A target already present in the observed Pod requests is not
        counted a second time; a missing or replaced resource represents none
        of its outstanding claim. A retry with the same operation is immutable.
        """
        if (not all(isinstance(value, str) and value for value in
                    (operation, member, resource_id, object_name))
                or kind not in {'container', 'job'} or not isinstance(resource_name, str)
                or (kind == 'container' and not resource_name)
                or not isinstance(minimum_bytes, int) or isinstance(minimum_bytes, bool)
                or not isinstance(desired_bytes, int) or isinstance(desired_bytes, bool)
                or minimum_bytes <= 0 or desired_bytes < minimum_bytes
                or not isinstance(snapshot, dict) or not isinstance(snapshot.get('requests'), dict)
                or not isinstance(snapshot.get('allocatable_bytes'), int)
                or not isinstance(snapshot.get('used_bytes'), int)
                or snapshot['allocatable_bytes'] <= 0 or snapshot['used_bytes'] < 0):
            raise ValueError('Invalid memory reservation')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                existing = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?',
                                           (operation,)).fetchone()
                identity = (member, kind, resource_id, resource_name, object_name,
                            minimum_bytes, desired_bytes)
                if existing is not None:
                    saved = tuple(existing[name] for name in ('member', 'kind', 'resource_id',
                                  'resource_name', 'object_name', 'minimum_bytes', 'desired_bytes'))
                    if saved != identity:
                        self.db.rollback()
                        raise ValueError('Memory operation identity changed')
                    self.db.commit()
                    return {'decision': 'existing', 'claim': dict(existing)}
                now = int(time.time())
                self.db.execute("DELETE FROM member_memory_wait WHERE kind='container' AND touched<?", (now-180,))
                if kind == 'job' and self.db.execute('SELECT 1 FROM member_memory_cancel WHERE operation=? AND member=?',
                                                    (operation, member)).fetchone():
                    self.db.rollback()
                    return {'decision': 'cancelled'}
                waiting = self.db.execute('SELECT * FROM member_memory_wait WHERE operation=?', (operation,)).fetchone()
                if waiting is not None:
                    saved = tuple(waiting[name] for name in ('member', 'kind', 'resource_id', 'resource_name',
                                  'object_name', 'minimum_bytes', 'desired_bytes'))
                    if saved != identity:
                        self.db.rollback()
                        raise ValueError('Memory operation identity changed')
                    self.db.execute('UPDATE member_memory_wait SET touched=? WHERE operation=?', (now, operation))
                else:
                    self.db.execute('INSERT INTO member_memory_wait '
                                    '(operation,member,kind,resource_id,resource_name,object_name,'
                                    'minimum_bytes,desired_bytes,touched) VALUES (?,?,?,?,?,?,?,?,?)',
                                    (operation, *identity, now))
                first = self.db.execute('SELECT operation FROM member_memory_wait ORDER BY sequence LIMIT 1').fetchone()
                locked = (self.db.execute('SELECT 1 FROM member_plugin_reclaim WHERE member=? '
                                          'AND resource_id=? AND resource_name=?',
                                          (member, resource_id, resource_name)).fetchone()
                          if kind == 'container' else None)
                if first['operation'] != operation or locked:
                    self.db.commit()
                    return {'decision': 'wait'}
                pending, targets, job_uids = self._pending_memory(snapshot)
                pending += self._pending_entries(snapshot)
                requests = snapshot['requests']
                observed_jobs = snapshot.get('job_uids', {})
                # Keep 30% above the accounted usage, including new claims.
                available = snapshot['allocatable_bytes'] * 10 // 13 - snapshot['used_bytes'] - pending
                if available < 0:
                    self.db.commit()
                    return {'decision': 'wait'}
                key = (kind, resource_id, resource_name)
                observed = requests.get(key, 0)
                if (kind == 'job' and (key not in job_uids or '' in job_uids[key]
                        or job_uids[key] != {observed_jobs.get(resource_id)})):
                    observed = 0
                if not isinstance(observed, int) or observed < 0:
                    raise ValueError('Invalid observed memory request')
                represented = max(observed, targets.get(key, 0))
                granted = min(desired_bytes, represented + available)
                if granted < minimum_bytes:
                    self.db.commit()
                    return {'decision': 'wait'}
                self.db.execute('INSERT INTO member_memory_claim '
                                '(operation,member,kind,resource_id,resource_name,object_name,'
                                'minimum_bytes,desired_bytes,granted_bytes) VALUES (?,?,?,?,?,?,?,?,?)',
                                (operation, *identity[:5], minimum_bytes, desired_bytes, granted))
                row = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?',
                                      (operation,)).fetchone()
                self.db.execute('DELETE FROM member_memory_wait WHERE operation=?', (operation,))
                self.db.commit()
                return {'decision': 'reserved', 'claim': dict(row)}
            except Exception:
                if self.db.in_transaction:
                    self.db.rollback()
                raise

    def cancel_memory_wait(self, operation, member):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            if operation.startswith('render:') and claim:
                if (claim['member'] != member or claim['kind'] != 'job'
                        or claim['state'] != 'reserved' or claim['sent']):
                    self.db.rollback()
                    return False
                self.db.execute("DELETE FROM member_memory_claim WHERE operation=? AND member=? "
                                "AND kind='job' AND state='reserved' AND sent=0", (operation, member))
                claim = None
            changed = self.db.execute('DELETE FROM member_memory_wait WHERE operation=? AND member=?',
                                      (operation, member)).rowcount
            if operation.startswith('render:') and not claim:
                self.db.execute('INSERT OR IGNORE INTO member_memory_cancel VALUES (?,?)', (operation, member))
                changed = 1
            self.db.commit()
        return changed == 1

    def memory_cancelled(self, operation, member):
        with self.lock:
            row = self.db.execute('SELECT 1 FROM member_memory_cancel WHERE operation=? AND member=?',
                                  (operation, member)).fetchone()
        return row is not None

    def memory_wait(self, operation, member):
        with self.lock:
            row = self.db.execute('SELECT * FROM member_memory_wait WHERE operation=? AND member=?',
                                  (operation, member)).fetchone()
        return dict(row) if row else None

    def queue_job_wait(self, operation, member, name, minimum, desired):
        identity = (member, 'job', name, '', name, minimum, desired)
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            if claim:
                if tuple(claim[key] for key in ('member', 'kind', 'resource_id', 'resource_name', 'object_name',
                                                'minimum_bytes', 'desired_bytes')) != identity:
                    self.db.rollback()
                    raise ValueError('Memory operation identity changed')
                self.db.commit()
                return {'decision': 'existing', 'claim': dict(claim)}
            if self.db.execute('SELECT 1 FROM member_memory_cancel WHERE operation=? AND member=?',
                               (operation, member)).fetchone():
                self.db.rollback()
                return {'decision': 'cancelled'}
            waiting = self.db.execute('SELECT * FROM member_memory_wait WHERE operation=?', (operation,)).fetchone()
            if waiting and tuple(waiting[key] for key in ('member', 'kind', 'resource_id', 'resource_name',
                                                          'object_name', 'minimum_bytes', 'desired_bytes')) != identity:
                self.db.rollback()
                raise ValueError('Memory operation identity changed')
            now = int(time.time())
            if waiting:
                self.db.execute('UPDATE member_memory_wait SET touched=? WHERE operation=?', (now, operation))
            else:
                self.db.execute('INSERT INTO member_memory_wait '
                                '(operation,member,kind,resource_id,resource_name,object_name,'
                                'minimum_bytes,desired_bytes,touched) VALUES (?,?,?,?,?,?,?,?,?)',
                                (operation, *identity, now))
            self.db.commit()
        return {'decision': 'wait'}

    def memory_claim(self, operation):
        with self.lock:
            row = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
        return dict(row) if row else None

    def memory_claims(self):
        with self.lock:
            rows = self.db.execute('SELECT * FROM member_memory_claim').fetchall()
        return [dict(row) for row in rows]

    def bind_memory_job(self, operation, uid):
        if not isinstance(uid, str) or not uid:
            return False
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("UPDATE member_memory_claim SET job_uid=? WHERE operation=? AND kind='job' "
                                      "AND (job_uid='' OR job_uid=?)", (uid, operation, uid)).rowcount
            self.db.commit()
        return changed == 1

    def memory_admissible(self, member, pod_uid=None, resource_name=None):
        with self.lock:
            row = self._row(member)
            entry = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
            locked = (self.db.execute('SELECT 1 FROM member_plugin_reclaim WHERE member=? '
                                      'AND resource_id=? AND resource_name=?',
                                      (member, pod_uid, resource_name)).fetchone()
                      if pod_uid is not None and resource_name is not None else None)
            return bool(row and row['state'] == READY and not row['scale'] and not row['wake']
                        and not row['reopen'] and not self._memory_reclaiming(member) and not locked
                        and entry and entry['state'] == 'active'
                        and (pod_uid is None or entry['pod_uid'] == pod_uid))

    def cancel_memory_reservation(self, operation):
        """An operation that never obtained the send right has no side effect."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("DELETE FROM member_memory_claim WHERE operation=? "
                                      "AND state='reserved' AND sent=0", (operation,)).rowcount
            self.db.commit()
        return changed == 1

    def account_memory_limit(self, operation, uid, limit_bytes):
        """Keep an already-sent claim charged for a larger observed limit."""
        if not isinstance(limit_bytes, int) or isinstance(limit_bytes, bool) or limit_bytes <= 0:
            raise ValueError('Invalid observed memory limit')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("UPDATE member_memory_claim SET granted_bytes=MAX(granted_bytes,?) "
                                      "WHERE operation=? AND kind='container' AND resource_id=? AND sent=1",
                                      (limit_bytes, operation, uid)).rowcount
            self.db.commit()
        return changed == 1

    def start_memory_operation(self, operation, request_bytes, limit_bytes):
        """Grant the one send right; an unknown send is never repeated."""
        if (not isinstance(request_bytes, int) or isinstance(request_bytes, bool) or request_bytes <= 0
                or not isinstance(limit_bytes, int) or isinstance(limit_bytes, bool) or limit_bytes < request_bytes):
            raise ValueError('Invalid memory operation target')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("UPDATE member_memory_claim SET sent=1,target_request=?,target_limit=? "
                                      "WHERE operation=? AND state='reserved' AND sent=0 "
                                      'AND granted_bytes<=?',
                                      (request_bytes, limit_bytes, operation, request_bytes)).rowcount
            self.db.commit()
        return changed == 1

    def record_memory_operation(self, operation, result, generation=0):
        """Keep uncertain sends charged; only explicit rejection frees them."""
        if result not in {APPLIED, NOT_APPLIED, UNKNOWN} or not isinstance(generation, int) or generation < 0:
            raise ValueError('Invalid memory operation result')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            if row is None or not row['sent'] or row['state'] not in {'reserved', 'unknown'}:
                self.db.rollback()
                return False
            if result == NOT_APPLIED:
                self.db.execute('DELETE FROM member_memory_claim WHERE operation=?', (operation,))
            else:
                self.db.execute('UPDATE member_memory_claim SET state=?,generation=? WHERE operation=?',
                                ('active' if result == APPLIED else 'unknown', generation, operation))
            self.db.commit()
        return True

    def begin_memory_reclaim(self, operation, member, epoch, confirmations, request_bytes, limit_bytes):
        """Commit an idle drain before allowing a member container to shrink."""
        if (not isinstance(request_bytes, int) or isinstance(request_bytes, bool) or request_bytes <= 0
                or not isinstance(limit_bytes, int) or isinstance(limit_bytes, bool) or limit_bytes < request_bytes):
            raise ValueError('Invalid memory reclaim target')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?',
                                        (operation,)).fetchone()
                row = self._row(member)
                if (claim is None or claim['member'] != member or claim['kind'] != 'container'
                        or claim['state'] != 'active' or row is None or row['state'] != DRAINING
                        or row['epoch'] != epoch or row['scale'] or row['wake']
                        or not self._confirmations_match(member, epoch, confirmations, 'closed')
                        or self.db.execute('SELECT 1 FROM member_work WHERE member=? LIMIT 1',
                                           (member,)).fetchone()
                        or self.db.execute("SELECT 1 FROM member_memory_claim WHERE operation!=? AND kind='container' "
                                           'AND resource_id=? AND resource_name=? LIMIT 1',
                                           (operation, claim['resource_id'], claim['resource_name'])).fetchone()
                        or self.db.execute("SELECT 1 FROM member_memory_claim WHERE member=? AND state='reclaiming'",
                                           (member,)).fetchone()):
                    self.db.rollback()
                    return False
                self.db.execute("UPDATE member_memory_claim SET state='reclaiming',sent=0,generation=0,"
                                'reclaim_request=?,reclaim_limit=?,reclaim_epoch=? WHERE operation=?',
                                (request_bytes, limit_bytes, epoch, operation))
                self.db.commit()
                return True
            except Exception:
                self.db.rollback()
                raise

    def begin_memory_migration(self, operation, member, uid, container, pod_name, epoch,
                               confirmations, old_request, old_limit, request_bytes, limit_bytes):
        """Charge an unclaimed legacy limit while an idle drain shrinks it."""
        if (not all(isinstance(value, str) and value for value in (operation, member, uid, container, pod_name))
                or any(not isinstance(value, int) or isinstance(value, bool) or value <= 0
                       for value in (old_request, old_limit, request_bytes, limit_bytes))
                or old_request > old_limit or request_bytes > limit_bytes or limit_bytes >= old_limit):
            raise ValueError('Invalid legacy memory migration')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                row = self._row(member)
                if (row is None or row['state'] != DRAINING or row['epoch'] != epoch or row['scale'] or row['wake']
                        or not self._confirmations_match(member, epoch, confirmations, 'closed')
                        or self.db.execute('SELECT 1 FROM member_work WHERE member=? LIMIT 1', (member,)).fetchone()
                        or self.db.execute("SELECT 1 FROM member_memory_claim WHERE operation=? OR "
                                           "(kind='container' AND resource_id=? AND resource_name=?) OR "
                                           "(member=? AND state='reclaiming') LIMIT 1",
                                           (operation, uid, container, member)).fetchone()):
                    self.db.rollback()
                    return False
                self.db.execute('INSERT INTO member_memory_claim '
                                '(operation,member,kind,resource_id,resource_name,object_name,minimum_bytes,'
                                'desired_bytes,granted_bytes,state,sent,target_request,target_limit,'
                                'reclaim_request,reclaim_limit,reclaim_epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                (operation, member, 'container', uid, container, pod_name, old_limit,
                                 old_limit, old_limit, 'reclaiming', 0, old_request, old_limit,
                                 request_bytes, limit_bytes, epoch))
                self.db.commit()
                return True
            except Exception:
                self.db.rollback()
                raise

    def start_memory_reclaim(self, operation, confirmations):
        """Take the send right only while the same instances still drain."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            row = self._row(claim['member']) if claim else None
            if (claim is None or claim['state'] != 'reclaiming' or claim['sent'] or row is None
                    or row['state'] != DRAINING or row['epoch'] != claim['reclaim_epoch']
                    or row['scale'] or row['wake']
                    or not self._confirmations_match(claim['member'], claim['reclaim_epoch'], confirmations, 'closed')
                    or self.db.execute('SELECT 1 FROM member_work WHERE member=? LIMIT 1',
                                       (claim['member'],)).fetchone()):
                self.db.rollback()
                return False
            self.db.execute('UPDATE member_memory_claim SET sent=1 WHERE operation=?', (operation,))
            self.db.commit()
        return True

    def cancel_memory_reclaim(self, operation):
        """An unsent reclaim retains the original loan and may reopen."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("UPDATE member_memory_claim SET state='active',sent=1,"
                                      'reclaim_request=0,reclaim_limit=0,reclaim_epoch=0 '
                                      "WHERE operation=? AND state='reclaiming' AND sent=0", (operation,)).rowcount
            self.db.commit()
        return changed == 1

    def record_memory_reclaim(self, operation, result):
        """Release a claim only after the caller confirms the actual resize."""
        if result not in {APPLIED, NOT_APPLIED, UNKNOWN}:
            raise ValueError('Invalid memory reclaim result')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            claim = self.db.execute('SELECT * FROM member_memory_claim WHERE operation=?', (operation,)).fetchone()
            if claim is None or claim['state'] != 'reclaiming' or not claim['sent']:
                self.db.rollback()
                return False
            if result == APPLIED:
                marker = self.db.execute('SELECT * FROM member_plugin_reclaim WHERE operation=?', (operation,)).fetchone()
                if marker:
                    reduced = max(0, marker['old_limit'] - claim['reclaim_limit'])
                    self.db.execute("UPDATE member_entry SET reserved_bytes=MAX(?,reserved_bytes-?) "
                                    "WHERE member=? AND state='active' AND pod_uid=?",
                                    (marker['base_bytes'], reduced, marker['member'], marker['resource_id']))
                self.db.execute('DELETE FROM member_memory_claim WHERE operation=?', (operation,))
            elif result == NOT_APPLIED:
                self.db.execute("UPDATE member_memory_claim SET state='active',sent=1,"
                                'reclaim_request=0,reclaim_limit=0,reclaim_epoch=0 WHERE operation=?', (operation,))
            self.db.commit()
        return True

    def complete_memory_job(self, operation):
        """Forget a render reservation after its caller confirms the Job ended."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("DELETE FROM member_memory_claim WHERE operation=? "
                                      "AND kind='job' AND state='active'", (operation,)).rowcount
            self.db.commit()
        return changed == 1

    def retire_memory_container(self, operation, uid):
        """Forget a claim only after the caller observed its original Pod gone."""
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            changed = self.db.execute("DELETE FROM member_memory_claim WHERE operation=? "
                                      "AND kind='container' AND resource_id=?", (operation, uid)).rowcount
            self.db.commit()
        return changed == 1

    def observe_runtime(self, member, replicas, activity):
        """Publish a confirmed replica count, which is what marks a member observed.

        Every branch writes observed=1, because reaching this method at all
        means a legal real replica count was read. It never overwrites a drain,
        a reopen, a wake, an unresolved scale or an unknown result: those are
        facts about an operation, not about the current replica count. A missing
        activity leaves the existing window untouched, so a passive sweep never
        renews it, and a replica count alone never reopens a closed member.
        """
        stamp = None if activity is None else int(activity)
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None:
                self.db.execute('INSERT INTO member_runtime (member,state,replicas,activity,observed) '
                                'VALUES (?,?,?,?,1)',
                                (member, SLEEPING if replicas == 0 else READY, replicas,
                                 stamp if stamp is not None else int(time.time())))
            elif row['scale'] or row['wake'] or row['reopen'] or row['state'] in {DRAINING, STARTING, FAILED}:
                self.db.execute('UPDATE member_runtime SET replicas=?,observed=1 WHERE member=?',
                                (replicas, member))
            else:
                self.db.execute('UPDATE member_runtime SET state=?,replicas=?,activity=?,observed=1 WHERE member=?',
                                (SLEEPING if replicas == 0 else READY, replicas,
                                 stamp if stamp is not None else row['activity'], member))
            self.db.commit()

    def record_activity(self, member, activity=None):
        """Record real foreground activity without touching the state.

        The idle clock is updated only for an existing runtime; foreground
        ranking is recorded independently and never creates a runtime row.
        Startup observations, wake completions and background work may update
        the idle clock, but must not be mistaken for user use.
        """
        stamp = int(activity if activity is not None else time.time())
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('UPDATE member_runtime SET activity=? WHERE member=?', (stamp, member))
            self.db.execute('INSERT INTO member_foreground_activity (member,last_seen) VALUES (?,?) '
                            'ON CONFLICT(member) DO UPDATE SET last_seen=excluded.last_seen', (member, stamp))
            self.db.commit()

    def record_unobserved(self, member):
        """Record that this member's real state could not be read.

        It marks the member unobserved without inventing a replica count or an
        idle window, and without clearing any operation another process owns.
        A member that is not observed is never eligible for an automatic
        scale-down.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None:
                self.db.execute('INSERT INTO member_runtime (member,state,observed) VALUES (?,?,0)',
                                (member, FAILED))
            else:
                self.db.execute('UPDATE member_runtime SET observed=0 WHERE member=?', (member,))
            self.db.commit()

    def observed(self, member):
        with self.lock:
            row = self._row(member)
        return bool(row['observed']) if row else False

    def admit_work(self, member, kind, origin='', idle_ms=0, instances=None, *, require_entry=False, expected_pod_uid=None, allow_reopen=True):
        """Decide whether one real operation may start, and register it if so.

        expected_pod_uid, when supplied, requires the active entry to match
        inside this transaction before any work insertion or reopen mutation.
        allow_reopen=False waits without reopening; default preserves real
        foreground callers. Any exception rolls back the open transaction.

        Returns a fixed-shape decision. Only 'admitted' lets the caller begin
        work; 'reopen' and 'wait' mean no request was accepted, so the caller
        must never resubmit a task it already sent.
        """
        if expected_pod_uid is not None and (not isinstance(expected_pod_uid, str) or not expected_pod_uid.strip()):
            raise ValueError('Expected nonempty Pod UID')
        if type(allow_reopen) is not bool:
            raise ValueError('Expected boolean allow_reopen')
        bound = instances if isinstance(instances, dict) else {}
        if sorted(bound) != sorted(COMPONENTS) or not all(isinstance(v, str) and v for v in bound.values()):
            bound = None
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                row = self._row(member)
                state = row['state'] if row else FAILED
                epoch = row['epoch'] if row else 0
                scale = row['scale'] if row else ''
                if require_entry or expected_pod_uid is not None:
                    entry = self.db.execute('SELECT state,pod_uid FROM member_entry WHERE member=?', (member,)).fetchone()
                    if (entry is None or entry['state'] != 'active'
                            or (expected_pod_uid is not None and entry['pod_uid'] != expected_pod_uid)):
                        self.db.rollback()
                        return {'decision': 'wait', 'operation_id': None, 'epoch': epoch}
                if self._memory_reclaiming(member):
                    self.db.rollback()
                    return {'decision': 'wait', 'operation_id': None, 'epoch': epoch}
                if state == DRAINING and not scale:
                    if not allow_reopen:
                        self.db.rollback()
                        return {'decision': 'wait', 'operation_id': None, 'epoch': epoch}
                    # Real activity during an open drain invalidates that epoch and
                    # records the reopen intent. The member stays closed as
                    # STARTING until the components confirm they reopened, and the
                    # new epoch gets its expected instances bound here so that
                    # confirmation has real identities to be checked against.
                    epoch += 1
                    self.db.execute('UPDATE member_runtime SET state=?,epoch=?,reopen=1,scale_result=? WHERE member=?',
                                    (STARTING, epoch, '', member))
                    self.db.execute('DELETE FROM member_component WHERE member=? AND epoch=?', (member, epoch))
                    if bound is not None:
                        for component, instance in bound.items():
                            self.db.execute('INSERT INTO member_component (member,epoch,component,instance) '
                                            'VALUES (?,?,?,?)', (member, epoch, component, instance))
                    self.db.commit()
                    return {'decision': 'reopen', 'operation_id': None, 'epoch': epoch}
                if state != READY or scale:
                    self.db.rollback()
                    return {'decision': 'wait', 'operation_id': None, 'epoch': epoch}
                operation = secrets.token_urlsafe(16)
                self.db.execute('INSERT INTO member_work (id,member,kind,origin,epoch,started) VALUES (?,?,?,?,?,?)',
                                (operation, member, kind, origin, epoch, int(time.time())))
                if idle_ms:
                    self.db.execute('UPDATE member_runtime SET idle_ms=? WHERE member=?', (int(idle_ms), member))
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
        return {'decision': 'admitted', 'operation_id': operation, 'epoch': epoch}

    def complete_reopen(self, member, epoch, confirmations):
        """Settle a reopen that the components have actually reopened.

        The three components must each report opened=true for this epoch and
        their bound instance; a closed/idle confirmation from the drain phase
        is a different answer and is refused here. Only while a reopen is
        genuinely pending does the flag clear: with a wake owner still in flight
        the member stays STARTING so that owner can finish its health check and
        its own wake-completion transaction, and with no wake and no unresolved
        scale the member returns to READY with a fresh idle window. An unknown
        scale is never removed by a reopen.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if not self._confirmations_match(member, epoch, confirmations, 'opened'):
                    self.db.rollback()
                    return False
                row = self._row(member)
                if (row is None or row['epoch'] != epoch or not row['reopen'] or row['scale']
                        or self._memory_reclaiming(member)):
                    self.db.rollback()
                    return False
                if row['wake']:
                    self.db.execute('UPDATE member_runtime SET reopen=0 WHERE member=?', (member,))
                else:
                    self.db.execute('UPDATE member_runtime SET state=?,activity=?,reopen=0 WHERE member=?',
                                    (READY, int(time.time()), member))
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
        return True

    def finish_work(self, operation):
        """Release exactly this operation and record the member's real activity.

        A repeated or unknown id releases nothing and refreshes nothing.
        """
        if not operation:
            return None
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT * FROM member_work WHERE id=?', (operation,)).fetchone()
            if row is None:
                self.db.rollback()
                return None
            now = int(time.time())
            self.db.execute('DELETE FROM member_work WHERE id=?', (operation,))
            self.db.execute('UPDATE member_runtime SET activity=? WHERE member=?', (now, row['member']))
            self.db.commit()
        return row['member']

    def work_count(self, member):
        with self.lock:
            return self.db.execute('SELECT COUNT(*) FROM member_work WHERE member=?', (member,)).fetchone()[0]

    def bind_component(self, member, epoch, component, instance):
        """Bind one component's real instance identity to a drain epoch.

        Only the three known components may be bound, and only idempotently: a
        second binding of the same instance for the same epoch succeeds without
        a second write, while a different instance is refused here so the caller
        can open a new epoch. The instance must come from the component itself
        when the epoch opens; C2 supplies it. Without a binding for every
        component the drain cannot be committed, so a self-reported field can
        never stand in for it.
        """
        if component not in COMPONENTS or not isinstance(instance, str) or not instance:
            return False
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None or row['epoch'] != epoch or self._memory_reclaiming(member):
                self.db.rollback()
                return False
            existing = self.db.execute(
                'SELECT instance FROM member_component WHERE member=? AND epoch=? AND component=?',
                (member, epoch, component)).fetchone()
            if existing is not None:
                if existing['instance'] != instance:
                    # The real instance changed: this epoch can no longer be
                    # confirmed, so the caller must coordinate a new one.
                    self.db.rollback()
                    return False
                self.db.commit()
                return True
            self.db.execute('INSERT INTO member_component (member,epoch,component,instance) VALUES (?,?,?,?)',
                            (member, epoch, component, instance))
            self.db.commit()
        return True

    def component_instances(self, member, epoch):
        with self.lock:
            rows = self.db.execute('SELECT component,instance FROM member_component WHERE member=? AND epoch=?',
                                   (member, epoch)).fetchall()
        return {row['component']: row['instance'] for row in rows}

    def invalidate_epoch(self, member, epoch, instances=None):
        """Retire an epoch whose component instances no longer match reality.

        The epoch advances so no confirmation collected for it can still match,
        the member is left closed as STARTING with its reopen intent set, and
        the new epoch gets its expected instances bound so the reopen
        confirmation has something real to be checked against. A pending wake
        keeps its immutable operation, claim epoch, target and slot; an already
        completed reopen or unresolved scale cannot be invalidated.
        """
        bound = instances if isinstance(instances, dict) else {}
        if sorted(bound) != sorted(COMPONENTS) or not all(isinstance(value, str) and value for value in bound.values()):
            return None
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if (row is None or row['epoch'] != epoch or not row['reopen'] or row['scale']
                    or self._memory_reclaiming(member)):
                self.db.rollback()
                return None
            following = epoch + 1
            self.db.execute('UPDATE member_runtime SET state=?,epoch=?,reopen=1 WHERE member=?',
                            (STARTING, following, member))
            self.db.execute('DELETE FROM member_component WHERE member=? AND epoch=?', (member, following))
            for component, instance in bound.items():
                self.db.execute('INSERT INTO member_component (member,epoch,component,instance) VALUES (?,?,?,?)',
                                (member, following, component, instance))
            self.db.commit()
        return following

    def begin_drain(self, member, idle_ms, instances=None, *, waiting_only=False):
        """Open a drain epoch, or refuse when the member cannot be drained.

        The idle window is confirmed from the shared activity column inside the
        transaction, and no member_work row may remain, so no process can open a
        drain against work another process still holds. The component instances
        must already be bound for this epoch: without them no confirmation can
        be checked later, so the drain refuses rather than proceed unverified.
        """
        bound = instances if isinstance(instances, dict) else {}
        if sorted(bound) != sorted(COMPONENTS) or not all(isinstance(value, str) and value for value in bound.values()):
            return None
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if waiting_only and not self._has_memory_waiters():
                self.db.rollback()
                return None
            if (row is None or row['state'] != READY or row['scale'] or row['wake'] or not row['observed']
                    or self._memory_reclaiming(member)
                    or self.db.execute('SELECT 1 FROM member_plugin_reclaim WHERE member=?', (member,)).fetchone()):
                self.db.rollback()
                return None
            if self.db.execute('SELECT 1 FROM member_work WHERE member=? LIMIT 1', (member,)).fetchone():
                self.db.rollback()
                return None
            self.db.execute("DELETE FROM member_memory_wait WHERE kind='container' AND touched<?", (int(time.time())-180,))
            if self.db.execute('SELECT 1 FROM member_memory_wait WHERE member=? LIMIT 1', (member,)).fetchone():
                self.db.commit()
                return None
            if time.time() - row['activity'] < idle_ms / 1000:
                self.db.rollback()
                return None
            epoch = row['epoch'] + 1
            self.db.execute('UPDATE member_runtime SET state=?,epoch=?,idle_ms=?,reopen=0 WHERE member=?',
                            (DRAINING, epoch, int(idle_ms), member))
            self.db.execute('DELETE FROM member_component WHERE member=? AND epoch=?', (member, epoch))
            for component, instance in bound.items():
                self.db.execute('INSERT INTO member_component (member,epoch,component,instance) VALUES (?,?,?,?)',
                                (member, epoch, component, instance))
            self.db.commit()
        return epoch

    def cancel_drain(self, member, epoch, instances=None):
        """Invalidate an uncommitted drain epoch and arm the reopen protocol.

        The epoch advances so a late confirmation for the old one can never
        match, and the member stays closed as STARTING with its reopen intent
        set: reopening is not the same as being open, so business waits for
        complete_reopen. The new epoch's expected instances are bound here, so
        the reopen confirmation has real identities to be checked against rather
        than an unmatchable empty protocol; the previous instances are the
        expectation, but the components must still report opened for the new
        epoch. A committed or unknown scale marker is never cleared here; the
        member stays closed until that scale is resolved.
        """
        bound = instances if isinstance(instances, dict) else {}
        if sorted(bound) != sorted(COMPONENTS) or not all(isinstance(value, str) and value for value in bound.values()):
            return None
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if (row is None or row['state'] != DRAINING or row['epoch'] != epoch or row['scale']
                    or self._memory_reclaiming(member)):
                self.db.rollback()
                return None
            following = epoch + 1
            self.db.execute('UPDATE member_runtime SET state=?,epoch=?,reopen=1,scale_result=? WHERE member=?',
                            (STARTING, following, '', member))
            self.db.execute('DELETE FROM member_component WHERE member=? AND epoch=?', (member, following))
            for component, instance in bound.items():
                self.db.execute('INSERT INTO member_component (member,epoch,component,instance) VALUES (?,?,?,?)',
                                (member, following, component, instance))
            self.db.commit()
        return following

    def commit_scale(self, member, epoch, replicas, confirmations, *, retiring_pod=None, waiting_only=False):
        """The single linearization point at which a scale-down begins.

        Reading the member row, reading the bound component instances and
        validating the confirmations all happen inside one BEGIN IMMEDIATE, so
        no confirmation collected against a different epoch or a changed
        instance can slip in between. It succeeds only while the matching epoch
        is still the open one, no operation is in flight, no wake is owned, and
        all three components reported a closed-and-idle confirmation for this
        epoch and their bound instance. Before this commit a new activity
        cancels the drain; after it a new activity waits for the scale to
        resolve. This commit is not atomic with the Kubernetes call that follows.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if waiting_only and not self._has_memory_waiters():
                    self.db.rollback()
                    return False
                if not self._confirmations_match(member, epoch, confirmations, 'closed'):
                    self.db.rollback()
                    return False
                row = self._row(member)
                if (row is None or row['state'] != DRAINING or row['epoch'] != epoch or row['scale'] or row['wake']
                        or self._memory_reclaiming(member)):
                    self.db.rollback()
                    return False
                if retiring_pod is not None and time.time() - row['activity'] < row['idle_ms'] / 1000:
                    self.db.rollback()
                    return False
                if self.db.execute('SELECT 1 FROM member_work WHERE member=? LIMIT 1', (member,)).fetchone():
                    self.db.rollback()
                    return False
                if self.db.execute('SELECT 1 FROM member_memory_wait WHERE member=? LIMIT 1', (member,)).fetchone():
                    self.db.rollback()
                    return False
                if self.db.execute('SELECT 1 FROM member_memory_claim WHERE member=? LIMIT 1', (member,)).fetchone():
                    self.db.rollback()
                    return False
                if retiring_pod is not None:
                    pod_uid, pod_name, pod_bytes = retiring_pod
                    entry = self.db.execute('SELECT * FROM member_entry WHERE member=?', (member,)).fetchone()
                    if (not pod_uid or not pod_name or not isinstance(pod_bytes, int) or pod_bytes <= 0
                            or (entry and (entry['state'] not in {'active', 'waiting'}
                                or (entry['pod_uid'] and entry['pod_uid'] != pod_uid)))):
                        self.db.rollback()
                        return False
                    if entry:
                        requested = 2 if entry['state'] == 'waiting' else 0
                        self.db.execute("UPDATE member_entry SET state='retiring',reserved_bytes=MAX(reserved_bytes,?),"
                                        'pod_uid=?,pod_name=?,requested=? WHERE member=?',
                                        (pod_bytes, pod_uid, pod_name, requested, member))
                    else:
                        self.db.execute("INSERT INTO member_entry (member,state,touched,reserved_bytes,pod_uid,pod_name) "
                                        "VALUES (?,'retiring',?,?,?,?)",
                                        (member, int(time.time()), pod_bytes, pod_uid, pod_name))
                    self.db.execute('INSERT OR REPLACE INTO member_idle_checkpoint VALUES (?)', (member,))
                operation = secrets.token_urlsafe(16)
                self.db.execute('UPDATE member_runtime SET scale=?,op_id=?,op_epoch=?,op_target=?,'
                                'op_started=0,scale_result=? WHERE member=?',
                                (str(replicas), operation, epoch, replicas, '', member))
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
        return True

    def _confirmations_match(self, member, epoch, confirmations, flag):
        """Validate a three-component confirmation inside the caller's transaction.

        The caller already holds the write lock and the transaction; this reads
        the bound instances on the same connection rather than taking the lock
        again or opening a second transaction. Every component must be present
        with exactly the fields this protocol defines, carrying the requested
        flag as literally True, and matching the member, the epoch and the
        instance bound for it. A missing entry, an extra component, a stale
        epoch, a blank or mismatched instance, a bare truthy value, or a
        closed/idle confirmation standing in for an opened one all fail, so a
        component cannot vouch for itself or reuse another phase's answer.
        """
        if flag == 'closed':
            fields = {'member_id', 'epoch', 'instance_id', 'closed', 'idle'}
        elif flag == 'opened':
            fields = {'member_id', 'epoch', 'instance_id', 'opened'}
        else:
            return False
        if not isinstance(confirmations, dict) or sorted(confirmations) != sorted(COMPONENTS):
            return False
        bound = self.db.execute(
            'SELECT component,instance FROM member_component WHERE member=? AND epoch=?',
            (member, epoch)).fetchall()
        bound = {row['component']: row['instance'] for row in bound}
        if sorted(bound) != sorted(COMPONENTS):
            return False
        for component in COMPONENTS:
            entry = confirmations[component]
            if not isinstance(entry, dict) or set(entry) != fields:
                return False
            if entry['member_id'] != member or entry['epoch'] != epoch:
                return False
            if entry['instance_id'] != bound[component]:
                return False
            if any(entry[name] is not True for name in fields - {'member_id', 'epoch', 'instance_id'}):
                return False
        return True

    def record_scale(self, member, operation, result, replicas=None):
        """Settle the scale operation this identity authorized.

        The result must name the operation, its claim epoch and the target it
        recorded; an older result cannot settle a newer operation. A provably
        NOT_APPLIED result ends the scale phase outright, because the PATCH was
        never sent or was explicitly refused: the member is left exactly as the
        caller's other gates left it, and only the wake owner that submitted
        that failure may finish its own operation. APPLIED with the confirmed
        replica count equal to the target ends the scale phase and, at target
        zero, leaves the member SLEEPING so a new wake may be claimed; at target
        one a wake or reopen that is still outstanding keeps the member STARTING
        with its operation and slot, because a resident replica count is not a
        health confirmation. A success without the confirmed target count, an
        UNKNOWN, and every other outcome keep the operation and its target
        exactly as recorded, so nothing is resent and no slot is freed.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None or not row['scale'] or row['op_id'] != operation or not row['op_started']:
                self.db.rollback()
                return False
            if result == NOT_APPLIED:
                # Provably never applied: the scale phase is over, and the
                # caller's own gates decide what the member is left as. Only
                # the operation that sent it settles it, so nothing here
                # touches a wake, an owner, a slot or a reopen.
                self.db.execute('UPDATE member_runtime SET scale=?,scale_result=?,op_started=? WHERE member=?',
                                ('', NOT_APPLIED, 0, member))
                if row['op_target'] == 0:
                    failure = self.db.execute('SELECT 1 FROM member_start_failure WHERE member=?', (member,)).fetchone()
                    if not failure:
                        self.db.execute('DELETE FROM member_idle_checkpoint WHERE member=?', (member,))
                    if not failure:
                        self.db.execute("UPDATE member_entry SET state=CASE WHEN requested=2 THEN 'waiting' ELSE 'active' END,"
                                    "reserved_bytes=CASE WHEN requested=2 THEN 0 ELSE reserved_bytes END,"
                                    "pod_uid=CASE WHEN requested=2 THEN '' ELSE pod_uid END,"
                                    "pod_name=CASE WHEN requested=2 THEN '' ELSE pod_name END,requested=0 "
                                    "WHERE member=? AND state='retiring'", (member,))
                self.db.commit()
                return True
            if result != APPLIED:
                self.db.execute('UPDATE member_runtime SET scale_result=? WHERE member=?', (result, member))
                self.db.commit()
                return True
            target = row['op_target']
            if not isinstance(replicas, int) or replicas != target:
                # A success without the confirmed target count is not settled.
                self.db.execute('UPDATE member_runtime SET scale_result=? WHERE member=?', (UNKNOWN, member))
                self.db.commit()
                return True
            if target == 0:
                self.db.execute('UPDATE member_runtime SET state=?,replicas=?,scale=?,scale_result=? WHERE member=?',
                                (SLEEPING, replicas, '', APPLIED, member))
            elif row['wake'] or row['reopen']:
                # Resident but not yet open: the wake owner or the reopen still
                # has to confirm health, so the slot stays occupied.
                self.db.execute('UPDATE member_runtime SET replicas=?,scale=?,scale_result=? WHERE member=?',
                                (replicas, '', APPLIED, member))
            else:
                self.db.execute('UPDATE member_runtime SET state=?,replicas=?,scale=?,scale_result=? WHERE member=?',
                                (READY, replicas, '', APPLIED, member))
            self.db.commit()
        return True

    def start_scale(self, member, operation):
        """Mark that this scale operation's PATCH is about to be sent.

        It is a compare-and-set on the operation identity and on the scale this
        member actually carries: a member with no registered scale, an
        operation that already started, or an operation whose result is already
        unknown is never granted permission to send again. The permission is
        granted exactly once per operation, and only the caller that holds it
        may settle that operation's result.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None or not row['scale'] or row['op_id'] != operation \
                    or row['op_started'] or row['scale_result'] == UNKNOWN:
                self.db.rollback()
                return False
            self.db.execute('UPDATE member_runtime SET op_started=1 WHERE member=?', (member,))
            self.db.commit()
        return True

    def scale_result(self, member):
        with self.lock:
            row = self._row(member)
        return (row['scale'], row['scale_result']) if row else ('', '')

    def scale_operation(self, member):
        """The operation id of the scale this member currently carries."""
        with self.lock:
            row = self._row(member)
        return row['op_id'] if row and row['scale'] else ''

    def pending_gate(self, member):
        """Whether a drain, reopen, wake or unresolved scale is still open."""
        with self.lock:
            row = self._row(member)
        return bool(row) and bool(row['scale'] or row['wake'] or row['reopen']
                                  or row['state'] in {DRAINING, STARTING})

    def confirm_resident(self, member, activity, gate_epoch=None, *, missing_only=False):
        """Re-confirm a healthy resident member and record its real activity.

        This is the fast path's transaction: it re-reads the epoch and the
        operation flags, and only a member with no open gate is confirmed and
        has its activity recorded. It never fabricates an observation or a
        replica count, and it cannot be used to bypass a drain, a reopen, a
        wake or an unresolved scale. A missing row may create a minimal healthy
        row: a confirmed probe on a member nobody ever recorded is a real
        observation of that member's health, and the row it creates stays
        unobserved and carries no replica claim. The caller's gate epoch, when
        given, must still be the member's current one, so a probe taken before a
        new drain cannot confirm the new phase. When missing_only is set, an
        existing row is never rewritten, including one created during the probe.
        """
        stamp = int(activity)
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None:
                self.db.execute('INSERT INTO member_runtime (member,state,replicas,activity,observed) '
                                'VALUES (?,?,?,?,0)', (member, READY, 1, stamp))
                self.db.commit()
                return True
            if missing_only:
                self.db.rollback()
                return False
            if gate_epoch is not None and row['epoch'] != gate_epoch:
                self.db.rollback()
                return False
            if row['scale'] or row['wake'] or row['reopen'] or row['state'] in {DRAINING, STARTING}:
                self.db.rollback()
                return False
            self.db.execute('UPDATE member_runtime SET state=?,activity=? WHERE member=?', (READY, stamp, member))
            self.db.commit()
        return True

    def claim_wake(self, member, limit=2):
        """Take ownership of this member's wake, or attach to the live one.

        The claim is one transaction: it merges same-member requests and counts
        the wake slots every process already occupies, so the whole-machine
        limit holds across processes rather than per Semaphore. Only the claim
        owner runs the scale and the health wait; every other process reads the
        same committed result instead of trusting its own local map. The claim
        itself registers the whole operation: its immutable identity, the gate
        epoch it was claimed under, its target, and the fact that its PATCH has
        not been sent yet. A member that is already waking shares that same
        identity, and a member carrying an unsettled scale, or one whose drain
        has not finished converting into a reopen, waits instead.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None:
                self.db.execute('INSERT INTO member_runtime (member,state,replicas,activity) VALUES (?,?,?,?)',
                                (member, FAILED, 1, int(time.time())))
                row = self._row(member)
            epoch = row['epoch']
            if row['wake']:
                # Another process owns this wake. Its immutable identity and the
                # claim epoch it registered under are what its result will be
                # settled against, so they are handed back as they were written
                # rather than re-derived from this row's current epoch.
                self.db.rollback()
                return {'decision': 'shared', 'operation_id': row['wake'], 'epoch': row['op_epoch'],
                        'owner': False, 'state': row['state']}
            if row['scale']:
                # A scale is already registered for this member; until it is
                # settled, another wake cannot be layered on top of it.
                self.db.rollback()
                return {'decision': 'wait', 'operation_id': None, 'epoch': epoch,
                        'owner': False, 'state': row['state']}
            if row['state'] == DRAINING or (row['reopen'] and row['state'] != READY):
                # The drain has not finished converting into a reopen yet, so
                # both its epoch and its intent are still moving: this member
                # waits rather than racing a scale against that conversion.
                self.db.rollback()
                return {'decision': 'wait', 'operation_id': None, 'epoch': epoch,
                        'owner': False, 'state': row['state']}
            # Every wake that is still unsettled holds a slot, whatever its
            # state label: an UNKNOWN or FAILED member whose owner never
            # released it keeps occupying the machine-wide budget.
            occupied = self.db.execute(
                "SELECT COUNT(*) FROM member_runtime WHERE wake!=''").fetchone()[0]
            if occupied >= limit:
                self.db.rollback()
                return {'decision': 'wait', 'operation_id': None, 'epoch': epoch,
                        'owner': False, 'state': row['state']}
            operation = secrets.token_urlsafe(16)
            needs_scale = None if not row['observed'] else row['replicas'] == 0
            self.db.execute('UPDATE member_runtime SET state=?,wake=?,owner=?,scale_result=?,'
                            'op_id=?,op_epoch=?,op_target=?,op_started=?,scale=? WHERE member=?',
                            (STARTING, operation, operation, '', operation, epoch, 1, 0,
                             '1' if needs_scale else '', member))
            self.db.commit()
        # Whether this wake needs a PATCH is decided inside the claim, from the
        # replica count this member's row carried in that same transaction: a
        # count of zero is the one case that scales, and any other confirmed
        # count only waits for its health. A row that was never observed carries
        # no confirmed count, so it leaves the decision to the caller's own read
        # rather than inventing one here.
        return {'decision': 'owned', 'operation_id': operation, 'epoch': epoch, 'owner': True,
                'state': STARTING, 'replicas': row['replicas'], 'needs_scale': needs_scale}

    def owns_wake(self, member, operation):
        """Whether this operation still owns the member's wake."""
        with self.lock:
            row = self._row(member)
        return bool(row) and row['wake'] == operation

    def wake_completion(self, member, operation, claim_epoch):
        """The committed completion of one wake operation, or None.

        A waiter uses this instead of inferring success from an empty wake
        column: the identity that finished and its result are stored together,
        so only the operation the caller is waiting for can be recognised. The
        operation's own identity — its id and the claim epoch it registered
        under — is what the caller must match, and the completion's gate epoch
        must still be the member's current one, so a member that entered
        another gate phase after this completion is never read as finished.
        """
        with self.lock:
            row = self._row(member)
        if not row or row['done_op'] != operation or row['op_epoch'] != claim_epoch:
            return None
        if row['done_epoch'] != row['epoch']:
            return None
        return {'operation_id': row['done_op'], 'epoch': row['op_epoch'], 'result': row['done_result'],
                'state': row['state'], 'scale': row['scale'], 'reopen': row['reopen']}

    def release_wake(self, member, operation, claim_epoch, gate_epoch, state, replicas, activity, result):
        """Finish a claimed wake, persisting the identity that completed it.

        The release is one compare-and-set on the operation's identity — its id
        and the claim epoch it registered under — on the member's current gate
        epoch still being the one the completing probe saw, and on the member
        still being STARTING, so an old probe's success can never overwrite a
        newer drain and a wake that finished while the member is closed keeps
        its operation. A success further requires that no scale and no reopen
        remain open, because a resident replica count is not a health
        confirmation. A failure that this owner already settled as never applied
        is released on the same identity and gate epoch but keeps a reopen that
        is still open, so the member stays STARTING and closed rather than being
        reported ready. The completed operation id, the gate epoch that was
        actually finished and its result are stored together, which is the only
        evidence a waiting process may rely on; the wake, its owner and its slot
        are cleared in the same transaction, so a released member can be woken
        again.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self._row(member)
            if row is None or row['wake'] != operation or row['op_id'] != operation \
                    or row['op_epoch'] != claim_epoch or row['epoch'] != gate_epoch \
                    or row['state'] != STARTING:
                self.db.rollback()
                return False
            if result == 'ready' and (row['scale'] or row['reopen']):
                self.db.rollback()
                return False
            if result == 'not_applied' and row['scale_result'] != NOT_APPLIED:
                # This owner's own settled failure is the only evidence the
                # wake may end without health: an unproven one keeps the slot.
                self.db.rollback()
                return False
            self.db.execute('UPDATE member_runtime SET state=?,replicas=?,activity=?,wake=?,owner=?,'
                            'done_op=?,done_epoch=?,done_result=? WHERE member=?',
                            (state, replicas, int(activity), '', '', operation, gate_epoch, result, member))
            self.db.commit()
        return True
