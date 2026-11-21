"""Final native output outbox. Uses the member connector's keyed upload contract."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import quote
import uuid

import requests
from greenroom_state import ROOT, connect

# Native custom voiceovers retain their uploaded format in the final outputs.
FORMATS = {'.mp4': ('video', 'video/mp4'), '.mp3': ('audio', 'audio/mpeg'),
           '.wav': ('audio', 'audio/wav'), '.m4a': ('audio', 'audio/mp4'),
           '.flac': ('audio', 'audio/flac'), '.ogg': ('audio', 'audio/ogg'),
           # AAC is download-only under the existing member media MIME policy.
           '.aac': ('audio', 'application/octet-stream'),
           '.srt': ('document', 'application/octet-stream')}
FIELDS = ('videos', 'combined_videos', 'audio_file', 'subtitle_path')

def asset_url(asset_id):
    # Only a canonical single path-segment identifier, never a supplied URL.
    if not isinstance(asset_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,199}', asset_id):
        raise ValueError('资产服务未返回有效的归档标识')
    return '/api/media/' + asset_id

def open_output(task_id, filename):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', task_id):
        raise ValueError('无效的原任务编号')
    base = ROOT / 'storage' / 'tasks' / task_id
    path = Path(filename)
    if not path.is_absolute() or '..' in path.parts or not path.is_relative_to(base):
        raise ValueError('产物不属于原任务目录')
    # Walk with no-follow directory descriptors, including member root ancestors.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        output = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    info = os.fstat(output)
    if not stat.S_ISREG(info.st_mode):
        os.close(output)
        raise ValueError('产物不是普通文件')
    return os.fdopen(output, 'rb')

def freeze(db, task_id, data):
    row = db.execute('SELECT data FROM deliveries WHERE id=?', (task_id,)).fetchone()
    if not row:
        return
    delivery = json.loads(row['data'])
    if delivery['status'] != 'generating':
        data.update(native_status='completed', delivery_status=delivery['status'])
        if delivery['status'] != 'ready':
            data.update(state=4, progress=95)
        return
    files = []
    for field in FIELDS:
        values = data.get(field) or []
        files.extend(values if isinstance(values, list) else [values])
    outputs = []
    for filename in dict.fromkeys(files):
        kind, mime = FORMATS.get(Path(filename).suffix.lower(), (None, None))
        if not kind:
            raise ValueError('不支持归档的 MoneyPrinter 产物格式')
        with open_output(task_id, filename) as source:
            size = os.fstat(source.fileno()).st_size
            if not 0 < size <= (50 if kind == 'document' else 512) * 1024 * 1024:
                raise ValueError('产物大小无效或超出上传限制')
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        outputs.append({'path': filename, 'archiveKey': 'moneyprinter:' + uuid.uuid4().hex,
                        'size': size, 'sha256': digest, 'assetType': kind, 'mimeType': mime})
    delivery.update(status='archive_pending' if outputs else 'ready', outputs=outputs)
    db.execute('UPDATE deliveries SET data=? WHERE id=?', (json.dumps(delivery), task_id))
    data.update(native_status='completed', delivery_status=delivery['status'])
    if not outputs:
        db.execute("UPDATE jobs SET state='done' WHERE id=?", (task_id,))
    if outputs:
        data.update(state=4, progress=95)
        db.execute("UPDATE jobs SET state='delivery' WHERE id=?", (task_id,))

def snapshot(task_id):
    with connect() as db:
        row = db.execute('SELECT data FROM deliveries WHERE id=?', (task_id,)).fetchone()
    return json.loads(row['data']) if row else None

def archive(task_id, *, explicit=False):
    # Serialize background completion and explicit exports across API processes.
    with os.fdopen(os.open(ROOT / "moneyprinter-delivery.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if explicit:
            adopt_completed(task_id)
        return _archive(task_id)

def adopt_completed(task_id):
    """Only the user's explicit export may enroll a historical completed task."""
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM deliveries WHERE id=?', (task_id,)).fetchone():
            return
        row = db.execute('SELECT data FROM task_state WHERE id=?', (task_id,)).fetchone()
        data = json.loads(row['data']) if row else {}
        if data.get('state') != 1 or not any(data.get(field) for field in FIELDS):
            raise ValueError('仅可显式归档原生已完成且有最终产物的任务')
        db.execute('INSERT INTO deliveries VALUES(?,?)', (task_id, json.dumps({'status': 'generating', 'outputs': []})))
        freeze(db, task_id, data)
        db.execute('UPDATE task_state SET data=? WHERE id=?', (json.dumps(data), task_id))

def upload_asset(item, source):
    """One member keyed-upload contract for native finals and new raw uploads."""
    if os.fstat(source.fileno()).st_size != item['size'] or hashlib.file_digest(source, 'sha256').hexdigest() != item['sha256']:
        raise ValueError('原文件已改变，拒绝替换原归档版本')
    source.seek(0)
    response = requests.post('http://127.0.0.1:3081/api/media/uploads', data=source,
        headers={'Content-Length': str(item['size']), 'Content-Type': item['mimeType'],
                 'X-File-Name': quote(Path(item['path']).name, safe=''), 'X-Asset-Type': item['assetType'],
                 'X-Greenroom-Archive-Key': item['archiveKey'], 'X-Greenroom-Archive-SHA256': item['sha256']}, timeout=120)
    response.raise_for_status()
    asset_id = response.json().get('assetId')
    return {'assetId': asset_id, 'fileUrl': asset_url(asset_id),
            'fileName': Path(item['path']).name, 'fileSize': item['size'],
            'assetType': item['assetType'], 'mimeType': item['mimeType']}

def _archive(task_id):
    delivery = snapshot(task_id)
    if not delivery or delivery['status'] == 'generating':
        raise ValueError('原任务没有可恢复的交付记录；不会迁移历史任务')
    if delivery['status'] == 'ready':
        return delivery
    try:
        for item in delivery['outputs']:
            if item.get('asset'):
                continue
            with open_output(task_id, item['path']) as source:
                item['asset'] = upload_asset(item, source)
            with connect() as db:
                db.execute('UPDATE deliveries SET data=? WHERE id=?', (json.dumps(delivery), task_id))
        delivery.update(status='ready', error=None)
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT data FROM task_state WHERE id=?', (task_id,)).fetchone()
            if not row:
                raise ValueError('原任务引用已不存在')
            data = json.loads(row['data'])
            data.update(state=1, progress=100, native_status='completed', delivery_status='ready',
                        delivery_outputs=[item['asset'] for item in delivery['outputs']], delivery_error=None)
            db.execute('UPDATE task_state SET data=? WHERE id=?', (json.dumps(data), task_id))
            db.execute('UPDATE deliveries SET data=? WHERE id=?', (json.dumps(delivery), task_id))
            db.execute("UPDATE jobs SET state='done' WHERE id=?", (task_id,))
    except Exception:
        # No native failure or resubmission: preserve every original key/Asset.
        with connect() as db:
            row = db.execute('SELECT data FROM deliveries WHERE id=?', (task_id,)).fetchone()
            failed = json.loads(row['data'])
            failed.update(status='archive_failed', error='原生生成已完成，资产交付待恢复；不会重新生成')
            db.execute('UPDATE deliveries SET data=? WHERE id=?', (json.dumps(failed), task_id))
            row = db.execute('SELECT data FROM task_state WHERE id=?', (task_id,)).fetchone()
            if row:
                data = json.loads(row['data'])
                data.update(state=4, progress=95, native_status='completed', delivery_status='archive_failed', delivery_error=failed['error'])
                db.execute('UPDATE task_state SET data=? WHERE id=?', (json.dumps(data), task_id))
        raise
    return delivery

def ready_url(filename):
    # Read only committed task+delivery references. No filesystem access is
    # required for an archived original whose disposable local copy is absent.
    if not isinstance(filename, str):
        return None
    path = Path(filename)
    tasks_root = ROOT / 'storage' / 'tasks'
    if not path.is_absolute() or '..' in path.parts or not path.is_relative_to(tasks_root):
        return None
    parts = path.relative_to(tasks_root).parts
    if len(parts) < 2 or not re.fullmatch(r'[A-Za-z0-9_-]+', parts[0]):
        return None
    with connect() as db:
        row = db.execute('SELECT d.data, t.data AS task_data FROM deliveries d JOIN task_state t ON t.id=d.id WHERE d.id=?', (parts[0],)).fetchone()
    if not row:
        return None
    delivery, task = json.loads(row['data']), json.loads(row['task_data'])
    if delivery['status'] != 'ready' or task.get('delivery_status') != 'ready' or task.get('task_id') != parts[0] or task.get('native_status') != 'completed':
        return None
    for item in delivery['outputs']:
        if item['path'] == filename and item.get('asset') in task.get('delivery_outputs', []):
            try:
                return asset_url(item['asset']['assetId'])
            except (ValueError, KeyError):
                return None
    return None
