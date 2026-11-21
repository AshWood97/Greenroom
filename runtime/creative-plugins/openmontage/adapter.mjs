import { readFile } from 'node:fs/promises';
import { createPendingTaskRecovery } from '../aigc-shared/pending-tasks.mjs';

const definitions = JSON.parse(await readFile(new URL('./tools.json', import.meta.url), 'utf8'));

export async function createAdapter(ctx) {
  const request = (path, body, signal) => ctx.request(path, {
    ...(body === undefined ? {} : { method: 'POST', body }), signal,
  });
  const message = (error) => ctx.formatGenerationError(error);
  const recovery = createPendingTaskRecovery({ request, getTask: ctx.getTask, archiveFile: ctx.archiveFile,
    formatGenerationError: ctx.formatGenerationError, defaultAssetType: 'video', canRestore: ctx.canRestore });
  const { synchronize, restore, update } = recovery;
  return {
    listTools: () => definitions,
    async callTool(name, args, extra = {}) {
      if (!definitions.some((entry) => entry.name === name)) throw new Error('未知 OpenMontage 业务工具');
      if (name === 'openmontage_get_project' || name === 'openmontage_get_tasks') await synchronize(extra.signal);
      const result = await request('/greenroom/call', { name, arguments: args, settings: await ctx.getSettings(extra.signal) }, extra.signal);
      if (result.submissions) {
        for (const job of result.submissions) {
          try {
            const task = await ctx.submit(job.kind, job.body, job.submissionId, extra.signal);
            if (task.error) task.error = message(task.error);
            await update(job.jobId, { task }, extra.signal);
          } catch (error) {
            await update(job.jobId, { submissionError: message(error) }, extra.signal);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(await request('/greenroom/call', {
          name: 'openmontage_get_tasks', arguments: { projectId: args.projectId },
        }, extra.signal)) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status === 'failed' };
    },
    getUiTarget: () => ctx.endpoint,
    restore,
    async close() { recovery.close(); },
  };
}
