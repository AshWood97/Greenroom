import { readFile } from 'node:fs/promises';
import { createPendingTaskRecovery } from '../aigc-shared/pending-tasks.mjs';

const definitions = JSON.parse(await readFile(new URL('./tools.json', import.meta.url), 'utf8'));

export async function createAdapter(ctx) {
  const request = (path, body, signal) => ctx.request(path, { ...(body === undefined ? {} : { method: 'POST', body }), signal });
  const recovery = createPendingTaskRecovery({ request, getTask: ctx.getTask, archiveFile: ctx.archiveFile,
    formatGenerationError: ctx.formatGenerationError, canRestore: ctx.canRestore });
  const { synchronize, restore, update } = recovery;
  return {
    listTools: () => definitions,
    async callTool(name, args, extra = {}) {
      if (!definitions.some((tool) => tool.name === name)) throw new Error('未知 OpenSlop 业务工具');
      if (name === 'openslop_get_project' || name === 'openslop_get_tasks') await synchronize(extra.signal);
      const result = await request('/greenroom/call', { name, arguments: args, settings: await ctx.getSettings(extra.signal), callId: extra.callId }, extra.signal);
      for (const job of result.submissions || []) {
        try {
          const task = await ctx.submit(job.kind, job.body, job.submissionId, extra.signal);
          if (task.error) task.error = ctx.formatGenerationError(task.error);
          await update(job.jobId, { task }, extra.signal);
        } catch (error) { await update(job.jobId, { submissionError: ctx.formatGenerationError(error) }, extra.signal); }
      }
      if (result.localFile && !result.archived) {
        Object.assign(result, await recovery.archive(result, extra.signal));
      }
      const value = result.submissions ? await request('/greenroom/job/' + encodeURIComponent(result.jobId), undefined, extra.signal) : result;
      return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: value.status === 'failed' };
    },
    getUiTarget: () => ctx.endpoint,
    restore,
    async close() { recovery.close(); },
  };
}
