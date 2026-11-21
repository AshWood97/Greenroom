const fs = require('node:fs');
const path = require('node:path');
const workers = new Map();
let restoration = null;

function seed(db) {
  require('./greenroom-final-cache.cjs').seed(db);
  db.exec(`CREATE TABLE IF NOT EXISTS greenroom_merge_delivery (
    merge_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, episode_id INTEGER NOT NULL,
    output_path TEXT NOT NULL, archive_key TEXT NOT NULL UNIQUE, duration INTEGER,
    status TEXT NOT NULL, asset_id TEXT, file_url TEXT, error TEXT
  )`);
}
function projection(db, row) {
  const delivery = db.prepare('SELECT * FROM greenroom_merge_delivery WHERE merge_id = ?').get(row.id);
  return delivery ? { ...row, delivery_status: delivery.status, asset_id: delivery.asset_id,
    archive_error: delivery.error, merged_url: delivery.status === 'ready' ? delivery.file_url : null } : row;
}
function safeOutput(db, row, missing = false) {
  const member = path.resolve(process.env.GREENROOM_PLUGIN_ROOT);
  const storage = path.join(member, 'storage');
  const sub = require('./src/services/storageLayout').getProjectStorageSubdir(db, row.drama_id);
  const directory = path.resolve(storage, sub || '', 'videos', 'merged');
  const filename = path.resolve(storage, row.output_path);
  if (!directory.startsWith(storage + path.sep) || path.dirname(filename) !== directory || !new RegExp('^merged_' + row.merge_id + '_[a-f0-9-]+(?:_post)?\\.mp4$').test(path.basename(filename))) throw new Error('成片路径不属于原项目');
  // Reject symlinks in every component, not only links escaping the member root.
  let current = member;
  for (const part of path.relative(member, filename).split(path.sep)) {
    current = path.join(current, part);
    if (missing && current === filename && !fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry: false })) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('成片路径不能包含符号链接');
  }
  if (missing && !fs.existsSync(filename)) {
    if (fs.realpathSync(member) !== member || fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)) throw new Error('成片恢复目录无效');
    return filename;
  }
  if (fs.realpathSync(member) !== member || fs.realpathSync(filename) !== filename || !fs.statSync(filename).isFile()) throw new Error('成片不是成员目录内普通文件');
  return filename;
}
function taskResult(db, row, url = null, assetId = null) {
  require('./src/services/taskService').updateTaskResult(db, row.task_id, {
    merge_id: row.merge_id, video_url: url, duration: row.duration,
    native_status: 'completed', delivery_status: row.status, asset_id: assetId,
    archive_error: row.error || null,
  });
  if (row.status !== 'ready') {
    const pending = row.status === 'archive_pending';
    const message = pending ? '本地合片已完成，正在归档原成片' : '本地合片已完成，资产归档失败；恢复原任务可重试归档：' + (row.error || '未知原因');
    db.prepare(`UPDATE async_tasks SET status=?, progress=?, message=?, error=?, completed_at=? WHERE id=?`)
      .run(pending ? 'processing' : 'failed', pending ? 95 : 100, message, pending ? null : message,
        pending ? null : new Date().toISOString(), row.task_id);
  } else db.prepare("UPDATE async_tasks SET error=NULL, message='' WHERE id=?").run(row.task_id);

}
async function archiveOnce(db, mergeId) {
  const row = db.prepare(`SELECT d.*, m.drama_id FROM greenroom_merge_delivery d
    JOIN video_merges m ON m.id = d.merge_id AND m.task_id = d.task_id
    WHERE d.merge_id = ? AND m.deleted_at IS NULL AND m.status = 'completed'`).get(mergeId);
  if (!row || row.status === 'ready') return;
  try {
    db.transaction(() => {
      db.prepare("UPDATE greenroom_merge_delivery SET status='archive_pending', error=NULL WHERE merge_id=?").run(mergeId);
      taskResult(db, { ...row, status: 'archive_pending', error: null });
    })();
    await require('./greenroom-final-cache.cjs').capture(db, mergeId);
    const filename = safeOutput(db, row);
    const { archiveFile } = await import('./greenroom-media-storage.mjs');
    const asset = await archiveFile(filename, { archiveKey: row.archive_key, assetType: 'video', mimeType: 'video/mp4', signal: AbortSignal.timeout(120_000) });
    await require('./greenroom-final-cache.cjs').capture(db, mergeId);
    if (!asset.assetId || asset.fileUrl !== '/api/media/' + encodeURIComponent(asset.assetId)) throw new Error('资产服务未返回可读取的成片引用');
    db.transaction(() => {
      db.prepare("UPDATE greenroom_merge_delivery SET status='ready', asset_id=?, file_url=?, error=NULL WHERE merge_id=?").run(asset.assetId, asset.fileUrl, mergeId);
      db.prepare('UPDATE video_merges SET merged_url=? WHERE id=?').run(asset.fileUrl, mergeId);
      // A late archive must not replace a newer successful merge's episode selection.
      const latest = db.prepare("SELECT id FROM video_merges WHERE episode_id=? AND status='completed' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(row.episode_id);
      if (latest?.id === mergeId) db.prepare("UPDATE episodes SET video_url=?, status='completed', updated_at=? WHERE id=?").run(asset.fileUrl, new Date().toISOString(), row.episode_id);
      taskResult(db, { ...row, status: 'ready', error: null }, asset.fileUrl, asset.assetId);
    })();
  } catch (error) {
    const reason = require('./greenroom-generation-error.ts').formatGenerationError(error.message);
    db.transaction(() => {
      db.prepare("UPDATE greenroom_merge_delivery SET status='archive_failed', error=? WHERE merge_id=?").run(reason, mergeId);
      taskResult(db, { ...row, status: 'archive_failed', error: reason });
    })();
  }
}
function archive(db, mergeId) {
  if (workers.has(mergeId)) return workers.get(mergeId);
  const cache = require('./greenroom-final-cache.cjs');
  const work = cache.locked(async () => {
    await archiveOnce(db, mergeId);
    if (db.prepare("SELECT 1 FROM greenroom_merge_delivery WHERE merge_id=? AND status='ready'").get(mergeId)) {
      try { await cache.prune(db); }
      catch { console.warn('[Greenroom] 成片缓存暂未回收；保留原件'); }
    }
  }).finally(() => workers.delete(mergeId));
  workers.set(mergeId, work);
  return work;
}
function complete(db, row, outputPath, duration, log = console) {
  const now = new Date().toISOString();
  const key = `localminidrama:merge:${row.id}:${path.basename(outputPath, '.mp4')}`;
  db.transaction(() => {
    db.prepare(`INSERT INTO greenroom_merge_delivery(merge_id,task_id,episode_id,output_path,archive_key,duration,status)
      VALUES(?,?,?,?,?,?,'archive_pending')`).run(row.id, row.task_id, row.episode_id, outputPath,
      key, duration);
    require('./greenroom-final-cache.cjs').enroll(db, row, outputPath, key);
    db.prepare("UPDATE video_merges SET status='completed', merged_url=NULL, duration=?, completed_at=?, error_msg=NULL WHERE id=?").run(duration, now, row.id);
    taskResult(db, { merge_id: row.id, task_id: row.task_id, duration, status: 'archive_pending' });
  })();
  return archive(db, row.id).catch(() => {
    // Native completion + the immutable journal already committed. A delivery
    // state-write failure must never escape to the native merge failure handler.
    log.error('[Greenroom] 成片已合成，归档状态暂未保存；恢复原任务继续归档');
  });
}
function restore(db, log) {
  if (restoration) return restoration;
  // Serialize this snapshot of original journal IDs; the member lock must not
  // turn the second accepted original into a silently abandoned recovery.
  const ids = db.prepare("SELECT merge_id FROM greenroom_merge_delivery WHERE status != 'ready'").all();
  restoration = (async () => {
    for (const row of ids) {
      try { await archive(db, row.merge_id); }
      catch { log.error('[Greenroom] 成片归档状态保存失败或媒体锁不可用'); }
    }
  })().finally(() => { restoration = null; });
  return restoration;
}

module.exports = { seed, projection, complete, restore, safeOutput, archive, busy: () => workers.size > 0 || restoration !== null };
