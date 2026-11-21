"""New native image/video uploads only. Original basename remains their identity."""
import hashlib
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import stat
import uuid

import requests
from greenroom_state import ROOT, connect
from greenroom_delivery import asset_url, upload_asset
from greenroom_final_cache import admit, native_lease, _parent_fd, _evict, verify_remote_asset

DIRECTORY = ROOT / 'storage' / 'local_videos'
NAME = re.compile(r'[a-f0-9]{32}\.(?:mp4|mov|avi|flv|mkv|webm|jpg|jpeg|png|bmp)')


def _name(value):
    path = Path(value)
    if path.is_absolute():
        if path.parent != DIRECTORY:
            raise ValueError('素材不属于成员上传目录')
        value = path.name
    if not NAME.fullmatch(value):
        raise ValueError('无效的原上传编号')
    return value


def snapshot(name):
    name = _name(name)
    with connect() as db:
        row = db.execute('SELECT data FROM raw_materials WHERE name=?', (name,)).fetchone()
    return json.loads(row['data']) if row else None


def _save(item):
    with connect() as db:
        db.execute('UPDATE raw_materials SET data=? WHERE name=?', (json.dumps(item), item['name']))


def _open(unused, filename):
    path = Path(filename)
    if path.parent != DIRECTORY or (not NAME.fullmatch(path.name) and not re.fullmatch(r'\.greenroom-final-cache-[a-f0-9]{32}', path.name)):
        raise ValueError('无效的原上传缓存路径')
    parent = _parent_fd(path)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError('原上传不是普通文件')
    return os.fdopen(fd, 'rb')


def _archive(item):
    if item.get('asset'):
        return
    try:
        with _open(None, item['path']) as source:
            item['asset'] = upload_asset(item, source)
        item.update(status='ready', error=None)
        _save(item)  # Cache never becomes disposable until this commit succeeds.
    except Exception:
        # No fresh key, no deletion, no retry of the user's upload operation.
        item.pop('asset', None)
        item.update(status='archive_pending', error='素材已保存，原资产归档待恢复')
        _save(item)
        raise


def _evict_ready(item):
    current = snapshot(item['name'])
    if not current or current.get('status') != 'ready' or current.get('asset') != item.get('asset') or current.get('pins'):
        return
    if current.get('cache_status') in ('preserved_changed', 'preserved_unsafe'):
        return
    if current['asset']['fileUrl'] != asset_url(current['asset']['assetId']):
        raise ValueError('原素材 Asset 引用无效')
    if not verify_remote_asset(current['asset']['assetId'], current['size']):
        return
    # The asset read awaits the connector; ensure the reference and pin state
    # are still the same before reclaiming the native file.
    latest = snapshot(current['name'])
    if not latest or latest.get('status') != 'ready' or latest.get('asset') != current['asset'] or latest.get('pins'):
        return
    current['cache_status'] = _evict(None, current, _open)
    _save(current)


class RegistrationError(RuntimeError):
    def __init__(self, name):
        self.name = name
        super().__init__('原上传已保留为 ' + name + '，资产登记失败；可在素材列表选择该原文件，不要重新上传。此文件尚未资产化。')

def save_upload(native_save, filename, source):
    """Preserve native UUID return and validation; never adopt old directory files."""
    with native_lease():
        source.seek(0, os.SEEK_END)
        size = source.tell()
        source.seek(0)
        admit(size)
        name = _name(native_save(filename, source))
        path = str(DIRECTORY / name)
        try:
            with _open(None, path) as original:
                size = os.fstat(original.fileno()).st_size
                digest = hashlib.file_digest(original, 'sha256').hexdigest()
            item = {'name': name, 'path': path, 'size': size, 'sha256': digest,
                    'archiveKey': 'moneyprinter:' + uuid.uuid4().hex,
                    'assetType': 'image' if Path(name).suffix in ('.jpg', '.jpeg', '.png', '.bmp') else 'video',
                    'mimeType': mimetypes.guess_type(name)[0] or 'application/octet-stream',
                    'status': 'archive_pending', 'pins': []}
            with connect() as db:
                db.execute('INSERT INTO raw_materials VALUES(?,?)', (name, json.dumps(item)))
        except Exception as error:
            # No Asset request occurred. Keep the native file visible as legacy,
            # disclose its original basename, and never silently auto-adopt it.
            raise RegistrationError(name) from error
        try:
            _archive(item)
            _evict_ready(item)
        except Exception:
            # Native upload succeeded; return the SAME basename. Its pending
            # journal is continued at native consumption/startup, never re-uploaded
            # as a new original identity. Archive failures retain original bytes;
            # a post-eviction journal failure is recovered from the same Asset.
            logging.getLogger(__name__).warning('原素材 %s 已保存，资产/缓存交付待恢复', name)
        return name


def list_materials(native_files):
    """Read-only projection: old files stay native; enrolled missing caches stay listed."""
    result = {item['name']: item for item in native_files}
    with connect() as db:
        rows = db.execute('SELECT name,data FROM raw_materials').fetchall()
    for row in rows:
        item = json.loads(row['data'])
        name = _name(row['name'])
        result[name] = {'name': name, 'file': name, 'size': item['size']}
    return sorted(result.values(), key=lambda item: (item['name'].casefold(), item['name']))


def retain_registered(path):
    """UI batch rollback must not delete enrolled originals after another file fails."""
    try:
        return snapshot(path) is not None
    except ValueError:
        return False


def _hydrate(item):
    try:
        with _open(None, item['path']) as source:
            if os.fstat(source.fileno()).st_size != item['size'] or hashlib.file_digest(source, 'sha256').hexdigest() != item['sha256']:
                raise ValueError('原素材缓存已改变，不覆盖未知版本')
            return
    except FileNotFoundError:
        pass
    admit(item['size'])
    url = asset_url(item['asset']['assetId'])
    if item['asset']['fileUrl'] != url:
        raise ValueError('原素材 Asset 引用无效')
    path = Path(item['path'])
    parent = _parent_fd(path)
    temp = '.material-restore-' + uuid.uuid4().hex
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                with requests.get('http://127.0.0.1:3081' + url, stream=True, timeout=120, allow_redirects=False) as response:
                    response.raise_for_status()
                    if response.status_code != 200:
                        raise ValueError('成员 Asset 未返回完整原文件')
                    digest = hashlib.sha256()
                    count = 0
                    for chunk in response.iter_content(1024 * 1024):
                        count += len(chunk)
                        if count > item['size']:
                            raise ValueError('原 Asset 返回超出冻结大小')
                        digest.update(chunk)
                        output.write(chunk)
                    if count != item['size'] or digest.hexdigest() != item['sha256']:
                        raise ValueError('原 Asset 字节不匹配，不交给原生处理')
                output.flush()
                os.fsync(output.fileno())
            # No overwrite of an unknown concurrent pathname.
            os.link(temp, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        finally:
            os.unlink(temp, dir_fd=parent)
    finally:
        os.close(parent)


class InputPending(ValueError):
    pass

def prepare_inputs(task_id, params):
    """Caller holds native_lease for the WHOLE original native producer lifetime."""
    if params.get('video_source') != 'local':
        return
    for material in params.get('video_materials') or []:
        value = material.get('url')
        if not value:
            continue
        try:
            item = snapshot(value)
        except ValueError:
            continue  # Native path validation still rejects unsafe legacy inputs.
        if not item:
            continue  # Old unmarked files are never enrolled or reclaimed.
        if task_id not in item['pins']:
            item['pins'].append(task_id)
            _save(item)  # Persist before any cache fetch/native file consumer.
        try:
            _archive(item)
            _hydrate(item)
        except Exception as error:
            raise InputPending('原素材资产读取待恢复；不会重新上传或启动生成') from error


def finish_inputs(task_id):
    """Only definite native completion releases the original task's pins."""
    with connect() as db:
        rows = db.execute('SELECT data FROM raw_materials').fetchall()
    for row in rows:
        item = json.loads(row['data'])
        if task_id in item['pins']:
            item['pins'].remove(task_id)
            _save(item)
            _evict_ready(item)


def restore_uploads():
    with native_lease():
        with connect() as db:
            rows = db.execute('SELECT data FROM raw_materials').fetchall()
        for row in rows:
            item = json.loads(row['data'])
            try:
                _archive(item)
                _evict_ready(item)
            except Exception:
                logging.getLogger(__name__).warning('原素材 %s 继续等待资产恢复', item['name'])
