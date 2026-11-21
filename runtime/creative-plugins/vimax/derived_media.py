"""Completed native render intermediates, archived without new hash/idempotency contracts.

Ordinary member uploads have no retry identity. Persist unknown before sending;
response loss stops the original task rather than creating a duplicate Asset.
Local originals are never evicted or overwritten by this module.
"""
import os
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from aiohttp import ClientSession, ClientTimeout
from greenroom.final_media import FinalMedia, MEDIA_MAX_BYTES, BROKER, asset_url, guard_write


def archive_unknown(record):
    return any(item.get('state') == 'unknown' for item in record.get('derivedMedia', []))


class DerivedMedia(FinalMedia):
    # Reuse only the member-scoped record reader and no-follow file opener.
    # FinalMedia's keyed/hash, eviction and replacement methods are not used.
    def path(self, record, relative):
        directory = Path(record['mediaSessionPath'])
        mode = record['result']['metadata'].get('render_mode')
        if (mode not in ('idea2video', 'script2video', 'novel2video')
                or not directory.is_absolute() or directory.parent != self.root / '.working_dir'):
            raise ValueError('派生媒体缺少原生模式或成员工程目录')
        path = self.root / relative
        if (Path(relative).is_absolute() or '..' in Path(relative).parts
                or not path.is_relative_to(directory / mode) or path.suffix not in ('.png', '.mp4')):
            raise ValueError('派生媒体必须是原生成模式目录内的 PNG/MP4')
        return path

    def freeze(self, record):
        if 'derivedMedia' in record:
            return
        if record.get('nativeStatus') != 'succeeded':
            raise ValueError('仅归档原生已完成渲染的派生媒体，未完成文件仍保留本地')
        metadata = record['result']['metadata']
        mode = metadata.get('render_mode')
        if mode not in ('idea2video', 'script2video', 'novel2video'):
            raise ValueError('原生结果缺少明确渲染模式')
        finals = {metadata['final_video_path']} if metadata.get('final_video_path') else set()
        finals.update(str(Path(directory) / 'final_video.mp4') for directory in metadata.get('scene_video_dirs', []))
        directory = Path(record['mediaSessionPath']) / mode
        entries = []
        # The pinned native writers produce PNG and MP4, including selected and
        # copied frames, candidate images, portraits and Scene-NNN split clips.
        for path in sorted(directory.rglob('*')):
            if path.suffix not in ('.png', '.mp4') or path.is_dir():
                continue
            relative = str(path.relative_to(self.root))
            if relative in finals:
                continue  # Existing final delivery owns these exact paths.
            with self.open_file(record, relative) as source:
                size = os.fstat(source.fileno()).st_size
            if size == 0:
                # Native render directories can retain incomplete files from an
                # earlier attempt. Record the path so it cannot expose an older
                # Asset when the local file is later missing.
                entries.append({'path': relative, 'state': 'incomplete'})
                continue
            if size > MEDIA_MAX_BYTES:
                raise ValueError('派生媒体超出已有 512 MiB 上传限制')
            entries.append({'path': relative, 'size': size, 'state': 'pending',
                            'kind': 'image' if path.suffix == '.png' else 'video',
                            'mimeType': 'image/png' if path.suffix == '.png' else 'video/mp4'})
        record.update(derivedMedia=entries, derivedDeliveryStatus='pending')

    async def deliver(self, record, persist):
        self.freeze(record)
        persist(record)
        if archive_unknown(record):
            raise RuntimeError('派生媒体上传受理未知，保留原任务和本地文件；禁止自动重传，需核对成员 Asset')
        for item in record['derivedMedia']:
            if item.get('state') in ('ready', 'incomplete'):
                continue
            with self.open_file(record, item['path']) as source:
                if os.fstat(source.fileno()).st_size != item['size']:
                    raise ValueError('待归档派生文件大小已改变，保留本地原件，不自动上传')
                # Persist before a non-idempotent upload. Never mark this pending
                # again when HTTP completion or business persistence is uncertain.
                item['state'] = 'unknown'
                record['derivedDeliveryStatus'] = 'unknown'
                persist(record)
                async def content():
                    while chunk := source.read(1024 * 1024):
                        yield chunk
                async with ClientSession(timeout=ClientTimeout(total=120)) as client:
                    async with client.post(BROKER + '/api/media/uploads', data=content(), headers={
                        'X-File-Name': quote(Path(item['path']).name, safe=''),
                        'X-Asset-Type': item['kind'], 'Content-Type': item['mimeType'],
                        'Content-Length': str(item['size']),
                    }, allow_redirects=False) as response:
                        value = await response.json(content_type=None)
                        if response.status >= 300:
                            raise RuntimeError('派生媒体上传未确认，保留原任务与本地文件')
                        url = asset_url(value.get('assetId'))
                        if (value.get('fileUrl') != url or value.get('fileSize') != item['size']
                                or value.get('mimeType') != item['mimeType'] or value.get('assetType') != item['kind']):
                            raise ValueError('派生媒体上传未返回一致的成员 Asset 绑定')
                item['asset'] = {key: value[key] for key in ('assetId', 'fileUrl', 'fileSize', 'mimeType', 'assetType')}
                item['asset']['fileName'] = Path(item['path']).name
                item['state'] = 'ready'
                try:
                    persist(record)
                except BaseException:
                    # Do not let the host's final persistence accidentally turn
                    # a failed binding commit into permission for another POST.
                    item['state'] = 'unknown'
                    raise
        record['derivedDeliveryStatus'] = 'ready'
        persist(record)

    def entries(self, session_id=None):
        latest = {}
        for record in sorted(self.records(), key=lambda item: (item.get('createdAt', ''), item['taskId'])):
            if record.get('derivedMediaVersion') != 1 or record.get('nativeStatus') != 'succeeded':
                continue
            if session_id and record.get('sessionId') != session_id:
                continue
            for item in record.get('derivedMedia', []):
                if item.get('state') != 'ready':
                    # A newer pending/unknown/incomplete path must not expose a stale Asset.
                    latest.pop(item['path'], None)
                    continue
                self.path(record, item['path'])
                if item['asset']['fileUrl'] != asset_url(item['asset']['assetId']):
                    raise ValueError('派生媒体的成员 Asset 引用无效')
                latest[item['path']] = (record, item)
        return latest

    def reference(self, session_id, relative):
        for record, item in self.entries(session_id).values():
            path = self.path(record, item['path'])
            if str(path.relative_to(Path(record['mediaSessionPath']))) == relative:
                if path.exists() or path.is_symlink():
                    return None  # A present local original always wins; never compare/overwrite it.
                return item['asset']
        return None

    async def restore(self, session_id):
        for record, item in self.entries(session_id).values():
            path = self.path(record, item['path'])
            if path.exists() or path.is_symlink():
                with self.open_file(record, item['path']):
                    pass
                continue
            # Restore missing files only. Retain directories and all local originals;
            # this is not a sweeping cache or an implicit regenerate operation.
            if path.parent.resolve() != path.parent or self.root.resolve() != self.root:
                raise ValueError('派生媒体恢复目录不能经过符号链接')
            guard_write(item['size'])
            temporary = path.with_name('.' + path.name + '.' + uuid4().hex + '.part')
            count = 0
            try:
                with temporary.open('xb') as output:
                    async with ClientSession(timeout=ClientTimeout(total=120)) as client:
                        async with client.get(BROKER + item['asset']['fileUrl'], allow_redirects=False) as response:
                            if response.status != 200 or response.headers.get('Content-Type', '').split(';')[0] != item['mimeType']:
                                raise RuntimeError('原派生 Asset 不可读取，不重新生成')
                            async for chunk in response.content.iter_chunked(1024 * 1024):
                                count += len(chunk)
                                if count > item['size']:
                                    raise ValueError('派生 Asset 超出原声明大小')
                                guard_write(len(chunk))
                                output.write(chunk)
                if count != item['size']:
                    raise ValueError('派生 Asset 未完整读回')
                os.link(temporary, path, follow_symlinks=False)
            finally:
                temporary.unlink(missing_ok=True)
