// OpenMontage and OpenSlop use this same pending/task-update handoff. It only
// queries accepted platform IDs and archives existing files; it never submits.
export function createPendingTaskRecovery({ request, getTask, archiveFile, formatGenerationError, defaultAssetType, canRestore }) {
  let restoring, synchronizing;
  let closed = false;
  const archiving = new Map();
  const update = (jobId, fields, signal) => request('/greenroom/task-update', { jobId, ...fields }, signal);
  // Inline OpenSlop exports and background/explicit recovery share one handoff.
  // The native job saves archiveKey before its first upload. The existing media
  // journal binds that key to bytes and keeps original upload IDs across restart.
  const archive = (job, signal) => {
    if (archiving.has(job.jobId)) return archiving.get(job.jobId);
    const pending = (async () => {
      try {
        if (!job.archiveKey) throw new Error('历史归档结果未知；保留原任务及文件，须核对原上传，不可自动新建归档');
        const assetType = defaultAssetType === undefined ? job.assetType : job.assetType || defaultAssetType;
        const asset = await archiveFile(job.localFile, { assetType, archiveKey: job.archiveKey, signal });
        return await update(job.jobId, { archive: asset }, signal);
      } catch (error) {
        const archiveError = formatGenerationError(error);
        return await update(job.jobId, { archiveError }, signal);
      }
    })().finally(() => { archiving.delete(job.jobId); });
    archiving.set(job.jobId, pending);
    return pending;
  };
  const synchronize = (signal) => synchronizing ||= (async () => {
    for (const job of (await request('/greenroom/pending', undefined, signal)).tasks) {
      if (job.platformTaskId) {
        try {
          const task = await getTask(job.platformTaskId, signal);
          if (task.error) task.error = formatGenerationError(task.error);
          await update(job.jobId, { task }, signal);
        } catch (error) { await update(job.jobId, { queryError: formatGenerationError(error) }, signal); }
      } else if (job.localFile && !job.archived) {
        await archive(job, signal);
      }
    }
  })().finally(() => { synchronizing = undefined; });
  const restore = () => restoring ||= (async () => {
    if (canRestore && !await canRestore()) return;
    await synchronize();
  })().finally(() => { restoring = undefined; });
  const timer = setInterval(() => { if (!closed) restore().catch(() => {}); }, 10_000);
  timer.unref?.();
  return {
    synchronize,
    restore,
    archive,
    update,
    close() { closed = true; clearInterval(timer); },
  };
}
