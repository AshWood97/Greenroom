"""Opt-in final output cache, not raw uploads or historical task cleanup."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import re

import requests
from greenroom_state import ROOT, connect
from greenroom_delivery import asset_url, open_output, ready_url, snapshot

POLICY = 'final-assets-v1'
HEADROOM = 5 * 1024 ** 3

class StoragePressure(ValueError):
    pass

def admit(reserve_bytes=0):
    if not isinstance(reserve_bytes, int) or isinstance(reserve_bytes, bool) or reserve_bytes < 0:
        raise ValueError('无效的媒体空间预留')
    info = os.statvfs(ROOT)
    if info.f_bavail * info.f_frsize - reserve_bytes < HEADROOM:
        raise StoragePressure('磁盘可用空间不足，需保留 5 GiB 运行余量；已有作品仍可读取和归档')

@contextmanager
def native_lease():
    # The managed worker is already single-threaded. This also serializes its
    # native file consumers across API restarts/processes before cache eviction.
    with os.fdopen(os.open(ROOT / 'moneyprinter-native.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield

def _parent_fd(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def _tomb_name(item):
    key = item.get('archiveKey', '')
    if not re.fullmatch(r'moneyprinter:[a-f0-9]{32}', key):
        raise ValueError('无效的原归档缓存键')
    return '.greenroom-final-cache-' + key.split(':', 1)[1]

def _reap_tomb(task_id, item, opener=open_output):
    # Crash after rename but before unlink: only this original key's exact bytes
    # may be reclaimed, never scan or adopt arbitrary temporary files.
    path = Path(item['path']).with_name(_tomb_name(item))
    try:
        with opener(task_id, str(path)) as source:
            before = os.fstat(source.fileno())
            if before.st_size != item['size'] or hashlib.file_digest(source, 'sha256').hexdigest() != item['sha256']:
                return 'preserved_changed'
            parent = _parent_fd(path)
            try:
                if _identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) != _identity(before) or _identity(os.fstat(source.fileno())) != _identity(before):
                    return 'preserved_changed'
                os.unlink(path.name, dir_fd=parent)
                return 'evicted'
            finally:
                os.close(parent)
    except FileNotFoundError:
        return 'absent'
    except (OSError, ValueError):
        return 'preserved_unsafe'

def _evict(task_id, item, opener=open_output):
    # Validate the original member/task path and no-follow all path components.
    try:
        with opener(task_id, item['path']) as source:
            before = os.fstat(source.fileno())
            if before.st_size != item['size'] or hashlib.file_digest(source, 'sha256').hexdigest() != item['sha256']:
                return 'preserved_changed'
            if _identity(os.fstat(source.fileno())) != _identity(before):
                return 'preserved_changed'
            path = Path(item['path'])
            parent = _parent_fd(path)
            try:
                actual = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                if _identity(actual) != _identity(before):
                    return 'preserved_changed'
                # Rename to a private same-directory tomb before deleting: a
                # replaced unknown pathname is rechecked, never blindly unlinked.
                tomb = _tomb_name(item)
                fd = os.open(tomb, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                os.close(fd)
                try:
                    os.rename(path.name, tomb, src_dir_fd=parent, dst_dir_fd=parent)
                except BaseException:
                    os.unlink(tomb, dir_fd=parent)  # only our still-empty reserved tomb
                    raise
                removed = False
                try:
                    fd = os.open(tomb, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    with os.fdopen(fd, 'rb') as moved:
                        current = os.fstat(moved.fileno())
                        # rename changes ctime, but never inode/size/mtime.
                        same = (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                        if not stat.S_ISREG(current.st_mode) or not same or hashlib.file_digest(moved, 'sha256').hexdigest() != item['sha256']:
                            return 'preserved_changed'
                        if _identity(os.fstat(moved.fileno())) != _identity(current):
                            return 'preserved_changed'
                    os.unlink(tomb, dir_fd=parent)
                    removed = True
                    return 'evicted'
                finally:
                    if not removed:
                        # Do not overwrite a concurrently-created new version.
                        try:
                            os.link(tomb, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                            os.unlink(tomb, dir_fd=parent)
                        except FileExistsError:
                            pass  # retained tomb is unknown data, never delete it
            finally:
                os.close(parent)
    except FileNotFoundError:
        return _reap_tomb(task_id, item, opener)
    except (OSError, ValueError):
        return 'preserved_unsafe'

def _input_paths(task_id):
    # Native custom audio is returned unchanged as audio_file. Output membership
    # alone therefore does NOT establish that a file is a disposable product.
    with connect() as db:
        row = db.execute('SELECT params FROM jobs WHERE id=?', (task_id,)).fetchone()
    if row is None:
        raise ValueError('缺少原任务输入身份，不能回收')
    params = json.loads(row['params'])
    values = [params.get('custom_audio_file'), params.get('bgm_file')]
    values.extend(item.get('url') for item in (params.get('video_materials') or []) if isinstance(item, dict))
    paths = []
    for value in values:
        if not isinstance(value, str) or not value.strip() or '://' in value:
            continue
        path = Path(value.strip())
        if path.is_absolute():
            paths.append(path)
        else:
            # Custom audio resolves against task_dir; other native local inputs
            # may be source-root relative. Preserve either identity conservatively.
            paths.extend([ROOT / 'storage' / 'tasks' / task_id / path, Path.cwd() / path])
    return paths

def _is_input(path, inputs):
    for original in inputs:
        if os.path.realpath(path) == os.path.realpath(original):
            return True
        try:
            if os.path.samefile(path, original):
                return True  # include hard-link aliases of an original upload
        except OSError:
            pass
    return False

def verify_remote_asset(asset_id, expected_size):
    """Read the committed member asset before discarding its local copy."""
    try:
        url = asset_url(asset_id)
        with requests.get('http://127.0.0.1:3081' + url, stream=True, timeout=120,
                          allow_redirects=False) as response:
            if response.status_code != 200:
                return False
            count = 0
            for chunk in response.iter_content(1024 * 1024):
                count += len(chunk)
                if count > expected_size:
                    return False
            return count == expected_size
    except (requests.RequestException, OSError, ValueError):
        return False

def evict_final(task_id):
    """Call only after native task.start returns, under native_lease."""
    delivery = snapshot(task_id)
    if not delivery or delivery.get('cache_policy') != POLICY or delivery.get('status') != 'ready':
        return
    if delivery.get('cache_status') == 'done':
        return
    inputs = _input_paths(task_id)
    for item in delivery['outputs']:
        if item.get('cache_status') in ('evicted', 'absent', 'preserved_changed', 'preserved_unsafe', 'preserved_input'):
            continue
        # The final reference transaction must be committed, not just remote ready.
        if ready_url(item['path']) != item['asset']['fileUrl']:
            return
        is_input = _is_input(item['path'], inputs)
        if not is_input:
            if not verify_remote_asset(item['asset']['assetId'], item['size']) or ready_url(item['path']) != item['asset']['fileUrl']:
                return
        item['cache_status'] = 'preserved_input' if is_input else _evict(task_id, item)
        with connect() as db:
            db.execute('UPDATE deliveries SET data=? WHERE id=?', (json.dumps(delivery), task_id))
    delivery['cache_status'] = 'done'
    with connect() as db:
        db.execute('UPDATE deliveries SET data=? WHERE id=?', (json.dumps(delivery), task_id))

def pending_evictions():
    with connect() as db:
        rows = db.execute('SELECT id,data FROM deliveries').fetchall()
    pending = []
    for row in rows:
        delivery = json.loads(row['data'])
        if delivery.get('cache_policy') == POLICY and delivery.get('status') == 'ready' and delivery.get('cache_status') != 'done':
            pending.append(row['id'])
    return pending
