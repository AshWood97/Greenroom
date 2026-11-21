import { readFile } from 'node:fs/promises';

const definitions = JSON.parse(await readFile(new URL('./tools.json', import.meta.url), 'utf8'));

export async function createAdapter(ctx) {
  let closed = false;
  let restoring;
  const request = (path, body, signal) => ctx.request(path, {
    ...(body === undefined ? {} : { method: 'POST', body }), signal,
  });
  const update = (jobId, update, signal) => request('/greenroom/task-update', { jobId, ...update }, signal);
  const message = (error) => ctx.formatGenerationError(error);

  async function synchronize(signal) {
    const pending = await request('/greenroom/pending', undefined, signal);
    for (const job of pending.tasks) {
      if (job.platformTaskId) {
        try {
          const task = await ctx.getTask(job.platformTaskId, signal);
          if (task.error) task.error = message(task.error);
          await update(job.jobId, { task }, signal);
        }
        catch (error) { await update(job.jobId, { queryError: message(error) }, signal); }
      } else if (job.localFile && !job.archived) {
        try {
          const asset = await ctx.archiveFile(job.localFile, { assetType: job.assetType || 'video', signal });
          await update(job.jobId, { archive: asset }, signal);
        } catch (error) { await update(job.jobId, { archiveError: message(error) }, signal); }
      }
    }
  }

  const restore = () => restoring ||= (async () => {
    if (ctx.canRestore && !await ctx.canRestore()) return;
    await synchronize();
  })().finally(() => { restoring = undefined; });
  const timer = setInterval(() => { if (!closed) restore().catch(() => {}); }, 10_000);
  timer.unref?.();

  return {
    listTools: () => definitions,
    async callTool(name, args, extra = {}) {
      if (!definitions.some((entry) => entry.name === name)) throw new Error('未知 drama-skills 业务工具');
      if (name === 'drama_skills_get_production' || name === 'drama_skills_get_project') await synchronize(extra.signal);
      const result = await request('/greenroom/call', { name, arguments: args, settings: await ctx.getSettings(extra.signal) }, extra.signal);
      if (result.submissions) {
        for (const job of result.submissions) {
          try {
            const task = await ctx.submit(job.kind, job.body, job.submissionId, extra.signal);
            if (task.error) task.error = message(task.error);
            await update(job.jobId, { task }, extra.signal);
          } catch (error) {
            // A failed response never causes an automatic second submission.
            await update(job.jobId, { submissionError: message(error) }, extra.signal);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(await request('/greenroom/call', {
          name: 'drama_skills_get_production', arguments: args,
        }, extra.signal)) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status === 'failed' };
    },
    getUiTarget: () => ctx.endpoint,
    restore,
    async close() { closed = true; clearInterval(timer); },
  };
}
