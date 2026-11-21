import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { objectSchema, projectIdSchema, projectFile } from './render-input.mjs';

export function audioTools() {
  return {
    scripts: {
      process_audio: {
        description: '用固定音频工具处理工程素材（trim/mix/concat），或从已接受的 audio_score JSON 合成代码音乐；不执行成员脚本。',
        runtime: 'node', file: 'greenroom/audio.mjs',
        inputSchema: objectSchema({ projectId: projectIdSchema, operation: { type: 'string', enum: ['synthesize', 'trim', 'mix', 'concat'] },
          assetIds: { type: 'array', maxItems: 16, items: projectIdSchema }, duration: { type: 'number', minimum: 0.05, maximum: 600 },
          offset: { type: 'number', minimum: 0, maximum: 600 }, fadeIn: { type: 'number', minimum: 0, maximum: 30 }, fadeOut: { type: 'number', minimum: 0, maximum: 30 },
          gains: { type: 'array', maxItems: 16, items: { type: 'number', minimum: 0, maximum: 4 } } }, ['projectId', 'operation']),
        async args(args, api) {
          if (!/^[0-9a-f-]{36}$/.test(args.outputId)) throw new Error('音频任务编号无效');
          const option = { operation: args.operation, output: 'media/' + args.outputId + '.wav' };
          if (args.operation === 'synthesize') {
            const document = await api.readDocument({ projectId: args.projectId, document: 'audio_score' });
            if (!document.accepted || !document.content) throw new Error('请先接受当前 audio_score 文档');
            option.score = JSON.parse(document.content);
          } else {
            if (!Array.isArray(args.assetIds) || !args.assetIds.length || args.assetIds.length > 16) throw new Error('请选择 1–16 项工程音频素材');
            option.inputs = [];
            for (const assetId of args.assetIds) {
              const asset = await api.importAsset({ projectId: args.projectId, assetId });
              await projectFile(api, args.projectId, asset.path);
              option.inputs.push(asset.path);
            }
            for (const name of ['duration', 'offset', 'fadeIn', 'fadeOut', 'gains']) if (args[name] !== undefined) option[name] = args[name];
          }
          return [JSON.stringify(option)];
        },
      },
    },
    handlers: {
      async process_audio(args, api) {
        const outputId = randomUUID();
        const name = 'media/' + outputId + '.wav';
        let project = await api.loadProject(args.projectId);
        project.audio ||= [];
        project.audio.push({ jobId: outputId, operation: args.operation, path: name, status: 'processing',
          outputProtocol: 'atomic-v1', archiveOperation: 'aigc-audio.' + outputId, createdAt: new Date().toISOString() });
        await api.saveProject(project);
        let result;
        try { result = await api.runScript('process_audio', { ...args, outputId }); }
        catch (error) {
          project = await api.loadProject(args.projectId);
          const job = project.audio.find((item) => item.jobId === outputId);
          job.status = 'unknown';
          job.archiveError = api.ctx.formatGenerationError({ message: error.message || String(error) });
          await api.saveProject(project);
          return { jobId: outputId, status: 'unknown', error: job.archiveError };
        }
        project = await api.loadProject(args.projectId);
        const job = project.audio.find((item) => item.jobId === outputId);
        let path;
        try { path = await projectFile(api, args.projectId, name); }
        catch (error) {
          if (!result.isError || error.code !== 'ENOENT') throw error;
          job.status = 'failed';
          job.error = result.error;
          await api.saveProject(project);
          return { ...result, jobId: outputId };
        }
        const info = await stat(path);
        Object.assign(job, { status: 'archiving', fileSize: info.size, ino: info.ino, mtimeMs: info.mtimeMs });
        await api.saveProject(project);
        const delivery = result.isError ? { warning: result.error } : result;
        let asset;
        try {
          asset = await api.archiveAudio(project, job);
        } catch (error) {
          job.archiveError = api.ctx.formatGenerationError({ message: error.message || String(error) });
          await api.saveProject(project);
          return { ...delivery, jobId: outputId, status: 'archiving', archiveError: job.archiveError };
        }
        await api.saveProject(project);
        return { ...delivery, jobId: outputId, status: 'completed', asset };
      },
    },
  };
}
