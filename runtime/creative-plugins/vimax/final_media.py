"""ViMax final-output delivery and disposable final cache; never sweeps intermediates."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import quote
from uuid import uuid4

from aiohttp import ClientSession, ClientTimeout

# Same existing member-media limits/headroom as runtime/shared/media-storage.mjs.
MEDIA_MAX_BYTES = 512 * 1024 * 1024
CACHE_MAX_BYTES = 64 * 1024 * 1024
DISK_HEADROOM_BYTES = 5 * 1024 ** 3
BROKER = os.environ.get('GREENROOM_BROKER_URL', 'http://127.0.0.1:3081').rstrip('/')


def guard_write(reserve_bytes=0):
    root = Path(os.environ['GREENROOM_PLUGIN_ROOT'])
    available = os.statvfs(root)
    if available.f_bavail * available.f_frsize - reserve_bytes < DISK_HEADROOM_BYTES:
        raise RuntimeError('磁盘可用空间不足，需保留 5 GiB；原任务与已归档成片仍可读取')


def asset_url(asset_id):
    if not isinstance(asset_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,199}', asset_id):
        raise ValueError('成片缺少有效的成员资产编号')
    return '/api/media/' + asset_id


class FinalMedia:
    def __init__(self, root, task_dir):
        self.root = Path(root).absolute()
        self.task_dir = Path(task_dir)

    @contextmanager
    def locked(self):
        # One member process may consume, restore or evict native paths at a time.
        fd = os.open(self.root / 'vimax-final-media.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError('另一 ViMax 进程正在使用成员媒体；保留原任务，稍后恢复') from error
            yield
        finally:
            os.close(fd)

    def path(self, record, relative):
        directory = Path(record['mediaSessionPath'])
        if not directory.is_absolute() or directory.parent != self.root / '.working_dir':
            raise ValueError('成片工程目录不属于当前成员')
        path = self.root / relative
        if Path(relative).is_absolute() or '..' in Path(relative).parts or not path.is_relative_to(directory) or path.name != 'final_video.mp4':
            raise ValueError('只允许原工程固定 final_video.mp4 产物')
        if path.relative_to(directory).parts[0] not in ('idea2video', 'script2video', 'novel2video'):
            raise ValueError('不支持的原生成片目录')
        return path

    @contextmanager
    def open_file(self, record, relative):
        path = self.path(record, relative)
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.parts[1:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            output = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        finally:
            os.close(fd)
        if not stat.S_ISREG(os.fstat(output).st_mode):
            os.close(output)
            raise ValueError('成片不是普通文件')
        with os.fdopen(output, 'rb') as source:
            yield source

    def records(self):
        records = []
        for file in sorted(self.task_dir.glob('*.json')):
            record = json.loads(file.read_text())
            if record.get('taskId') != file.stem:
                raise ValueError('原任务媒体索引无效，停止缓存操作')
            records.append(record)
        return records

    def pinned(self, record):
        return record.get('mediaLease') or record.get('status') in ('pending', 'processing', 'unknown')

    def unresolved(self, session_id, task_id):
        return any(item['taskId'] != task_id and self.pinned(item)
                   and item.get('arguments', {}).get('session_id') == session_id for item in self.records())

    def entries(self, session_id=None):
        latest = {}
        for record in sorted(self.records(), key=lambda item: (item.get('createdAt', ''), item['taskId'])):
            if record.get('mediaStorageVersion') != 1 or record.get('deliveryStatus') != 'ready' or record.get('status') != 'succeeded':
                continue
            if session_id and record.get('sessionId') != session_id:
                continue
            for item in record.get('finalMedia', []):
                if item.get('asset') not in record.get('outputs', []):
                    raise ValueError('成片资产尚无持久业务引用')
                self.path(record, item['path'])
                asset_url(item['asset']['assetId'])
                latest[item['path']] = (record, item)
        return latest

    def matching(self, record, item):
        try:
            with self.open_file(record, item['path']) as source:
                info = os.fstat(source.fileno())
                return info if info.st_size == item['size'] and hashlib.file_digest(source, 'sha256').hexdigest() == item['sha256'] else None
        except FileNotFoundError:
            return None

    def begin(self, record, directory):
        if self.unresolved(record['arguments']['session_id'], record['taskId']):
            raise RuntimeError('本工程有活动或未知的原任务，禁止覆盖或回收其媒体')
        directory = Path(directory).absolute()
        if directory.parent != self.root / '.working_dir' or directory.resolve() != directory or self.root.resolve() != self.root:
            raise ValueError('工程目录不能越过成员目录或经过符号链接')
        record['mediaSessionPath'] = str(directory)
        if 'mediaExistingFinals' not in record:
            record['mediaExistingFinals'] = []
            for path in Path(directory).rglob('final_video.mp4'):
                relative = str(path.relative_to(self.root))
                with self.open_file(record, relative):
                    record['mediaExistingFinals'].append(relative)
        record['mediaLease'] = True

    def freeze(self, record):
        if 'finalMedia' in record:
            return
        metadata = record['result']['metadata']
        paths = [metadata['final_video_path']] if metadata.get('final_video_path') else []
        paths += [str(Path(directory) / 'final_video.mp4') for directory in metadata.get('scene_video_dirs', [])]
        if not paths:
            raise ValueError('原生渲染没有提供实际成片，不能标记资产交付成功')
        known = self.entries(record['sessionId'])
        items = []
        for relative in dict.fromkeys(paths):
            with self.open_file(record, relative) as source:
                size = os.fstat(source.fileno()).st_size
                if not 0 < size <= MEDIA_MAX_BYTES:
                    raise ValueError('原成片大小无效或超出已有 512 MiB 资产上传限制')
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            previous = known.get(relative)
            if previous and previous[1]['size'] == size and previous[1]['sha256'] == digest:
                items.append(dict(previous[1]))
            else:
                items.append({'path': relative, 'size': size, 'sha256': digest,
                              'archiveKey': 'vimax:' + record['taskId'] + ':' + uuid4().hex,
                              'cacheOwned': relative not in record['mediaExistingFinals']})
        record.update(finalMedia=items, deliveryStatus='archive_pending', outputs=[])

    async def deliver(self, record, persist):
        self.freeze(record)
        persist(record)  # Key and actual byte identity before any remote write.
        for item in record['finalMedia']:
            if item.get('asset'):
                continue
            with self.open_file(record, item['path']) as source:
                if os.fstat(source.fileno()).st_size != item['size'] or hashlib.file_digest(source, 'sha256').hexdigest() != item['sha256']:
                    raise ValueError('原成片字节已改变，保留原件，拒绝改写原归档版本')
                source.seek(0)
                async def content():
                    while chunk := source.read(1024 * 1024):
                        yield chunk
                async with ClientSession(timeout=ClientTimeout(total=120)) as client:
                    async with client.post(BROKER + '/api/media/uploads', data=content(), headers={
                        'X-File-Name': quote(Path(item['path']).name, safe=''), 'X-Asset-Type': 'video',
                        'Content-Type': 'video/mp4', 'Content-Length': str(item['size']),
                        'X-Greenroom-Archive-Key': item['archiveKey'], 'X-Greenroom-Archive-SHA256': item['sha256'],
                    }) as response:
                        value = await response.json(content_type=None)
                        if response.status >= 400:
                            raise RuntimeError('原成片资产归档未完成，保留原任务等待恢复')
                        url = asset_url(value.get('assetId'))
                        if value.get('fileUrl') != url:
                            raise ValueError('资产服务未返回原成片稳定地址')
                item['asset'] = {'assetId': value['assetId'], 'fileUrl': url, 'fileName': Path(item['path']).name,
                                 'fileSize': item['size'], 'assetType': 'video', 'mimeType': 'video/mp4'}
                persist(record)
        record.update(outputs=[item['asset'] for item in record['finalMedia']], deliveryStatus='ready', status='succeeded', mediaLease=False)
        record.pop('error', None)
        persist(record)  # Only this committed business binding authorizes pruning.

    async def restore(self, session_id):
        for record, item in self.entries(session_id).values():
            path = self.path(record, item['path'])
            try:
                with self.open_file(record, item['path']):
                    pass
            except FileNotFoundError:
                if not item['cacheOwned']:
                    raise RuntimeError('历史本地原件缺失，不自动恢复或重新生成')
            else:
                if self.matching(record, item) is None:
                    raise RuntimeError('本地成片已修改，原件保留，禁止旧资产覆盖')
                continue
            # Directories remain after exact-file eviction; never rebuild through links.
            if path.parent.resolve() != path.parent or self.root.resolve() != self.root:
                raise ValueError('缓存恢复目录不能为符号链接')
            guard_write(item['size'])
            temporary = path.with_name('.' + path.name + '.' + uuid4().hex + '.part')
            try:
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                count = 0
                digest = hashlib.sha256()
                with os.fdopen(fd, 'wb') as output:
                    async with ClientSession(timeout=ClientTimeout(total=120)) as client:
                        async with client.get(BROKER + asset_url(item['asset']['assetId']), allow_redirects=False) as response:
                            if response.status != 200 or response.headers.get('Content-Type', '').split(';')[0] != 'video/mp4':
                                raise RuntimeError('原成片资产暂不可读，不重新生成')
                            async for chunk in response.content.iter_chunked(1024 * 1024):
                                count += len(chunk)
                                if count > item['size']:
                                    raise ValueError('资产恢复大小与原成片不符')
                                guard_write(len(chunk))
                                digest.update(chunk)
                                output.write(chunk)
                if count != item['size'] or digest.hexdigest() != item['sha256']:
                    raise ValueError('资产恢复内容与原成片不符')
                # No overwrite of a concurrently appeared original file.
                os.link(temporary, path, follow_symlinks=False)
            finally:
                temporary.unlink(missing_ok=True)

    def prune(self, target=CACHE_MAX_BYTES):
        records = self.records()
        pinned = {record.get('arguments', {}).get('session_id') for record in records if self.pinned(record)}
        rows = []
        for record, item in self.entries().values():
            if not item['cacheOwned']:
                continue
            info = self.matching(record, item)
            if info:
                rows.append((info.st_mtime_ns, record, item, info))
        total = sum(row[2]['size'] for row in rows)
        for _, record, item, info in sorted(rows, key=lambda row: row[0]):
            if total <= target:
                break
            if record['sessionId'] in pinned:
                continue
            path = self.path(record, item['path'])
            current = path.stat(follow_symlinks=False)
            if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
                continue
            path.unlink()
            total -= item['size']
        return total

    def reference(self, session_id, relative):
        for record, item in self.entries(session_id).values():
            if str(self.path(record, item['path']).relative_to(Path(record['mediaSessionPath']))) != relative:
                continue
            path = self.path(record, item['path'])
            if (path.exists() or path.is_symlink()) and self.matching(record, item) is None:
                return None  # Changed local bytes remain an unarchived original.
            return item['asset']
        return None
