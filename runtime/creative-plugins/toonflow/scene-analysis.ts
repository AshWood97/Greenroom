import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { createFfmpeg } from '@toonflow/ffmpeg/runtime';
import type { BrowserFfmpegFactory } from '@toonflow/ffmpeg/browser';
import { prepareWorkspaceFfmpeg } from '@/utils/ffmpeg';
import { analyzeSceneDescriptions } from './greenroom-aiAnalysis';
import type { AiAnalysisOptions } from './greenroom-aiAnalysis';
import { analysisPath } from './greenroom-videoAnalysis';
import type { AnalysisResult } from './greenroom-videoAnalysis';

export async function analyzeScenes({ directory, source, result, model, focus, signal, generate }: {
  directory: string; source: string; result: AnalysisResult; model: AiAnalysisOptions['model'];
  focus?: string; signal: AbortSignal; generate: AiAnalysisOptions['ai']['generate'];
}): Promise<AnalysisResult> {
  signal.throwIfAborted();
  const root = await realpath(directory);
  if (root !== resolve(directory)) throw new Error('拉片工程不能经过符号链接');
  const pathFor = (name: string) => {
    const path = resolve(root, analysisPath(name));
    if (!path.startsWith(root + sep)) throw new Error('拉片文件超出当前工程');
    return path;
  };
  const requireFile = async (name: string) => {
    const path = pathFor(name);
    if (await realpath(path) !== path) throw new Error('拉片文件不能经过符号链接');
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('拉片素材必须是普通文件');
    return path;
  };
  await requireFile(source);
  const originalManifest = await requireFile(result.manifest), outputDirectory = dirname(originalManifest);
  for (const scene of result.scenes) if (scene.image) await requireFile(scene.image);
  const tools = await prepareWorkspaceFfmpeg(signal);
  const native = createFfmpeg(root);
  native.setFfmpegPath(tools.ffmpeg); native.setFfprobePath(tools.ffprobe);
  let frames: string | undefined, operationId: string | undefined, manifest: string | undefined;
  const samples = new Set<string>();
  const samplePath = (name: string) => {
    const path = pathFor(name);
    if (!frames || dirname(path) !== frames || !/^scene\d+Frame\d+\.jpg$/.test(basename(path))) throw new Error('采样文件超出本次 AI 拉片目录');
    if (realpathSync(frames) !== frames) throw new Error('AI 拉片目录不能经过符号链接');
    return path;
  };
  const factory = (input: string) => {
    const command = native(input) as ReturnType<typeof native> & { _getArguments(): string[] };
    const output = command.output, argumentsFor = command._getArguments;
    command.output = ((name: string) => {
      const path = samplePath(name);
      if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('AI 采样文件已存在，不覆盖已有文件');
      samples.add(path);
      return output.call(command, path);
    }) as typeof command.output;
    // Keep the native sampling algorithm, but never let fluent's default -y overwrite a file.
    command._getArguments = () => argumentsFor.call(command).map(argument => argument === '-y' ? '-n' : argument);
    return command;
  };
  // Retain the real fluent factory statics, including probe/filter/codec methods.
  Object.setPrototypeOf(factory, native);
  const ffmpeg = factory as unknown as BrowserFfmpegFactory;
  const removeSample = async (path: string) => {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (info?.isSymbolicLink() || info && !info.isFile()) throw new Error('AI 采样文件类型已改变，保留现有内容');
    if (info) await unlink(path);
    samples.delete(path);
  };
  const workspace = {
    async mkdir(name: string) {
      const path = pathFor(name), match = /^aiFrames([a-f\d]{32})$/.exec(basename(path));
      if (frames || !match || dirname(path) !== outputDirectory) throw new Error('AI 采样目录无效');
      if (await realpath(outputDirectory) !== outputDirectory) throw new Error('拉片目录不能经过符号链接');
      await mkdir(path);
      frames = path; operationId = match[1];
    },
    async read(name: string) {
      const path = samplePath(name);
      if (!samples.has(path)) throw new Error('只能读取本次 AI 采样文件');
      await requireFile(name);
      const bytes = await readFile(path);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    async remove(name: string, recursive = false) {
      const path = pathFor(name);
      if (path === frames && recursive) {
        if (await realpath(path) !== path) throw new Error('AI 采样目录已改变，保留现有内容');
        for (const sample of samples) await removeSample(sample);
        await rmdir(path);
      } else if (samples.has(path) && !recursive) {
        samplePath(name); await removeSample(path);
      } else if (path === manifest && !recursive) {
        await requireFile(name); await unlink(path); manifest = undefined;
      } else throw new Error('只能清理本次 AI 拉片产生的文件');
    },
    async writeJson(name: string, data: unknown, exclusive = false) {
      const path = pathFor(name), match = /^aiAnalysis([a-f\d]{32})\.json$/.exec(basename(path));
      if (!exclusive || manifest || !match || dirname(path) !== outputDirectory || operationId && match[1] !== operationId) throw new Error('AI 拉片输出路径无效');
      if (await realpath(outputDirectory) !== outputDirectory) throw new Error('拉片目录不能经过符号链接');
      await writeFile(path, JSON.stringify(data, null, 2), { flag: 'wx' });
      manifest = path;
    },
  } as AiAnalysisOptions['workspace'];
  return analyzeSceneDescriptions({ ai: { generate }, model, ffmpeg, workspace, workspaceDirectory: root,
    source, result, focus, signal, onProgress() {} });
}
