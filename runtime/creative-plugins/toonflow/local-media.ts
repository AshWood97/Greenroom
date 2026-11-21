import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createFfmpeg } from '@toonflow/ffmpeg/runtime';
import type { BrowserFfmpegFactory, FfprobeData } from '@toonflow/ffmpeg/browser';
import { prepareWorkspaceFfmpeg } from '@/utils/ffmpeg';
import { processVideo } from '../../../packages/nodes/videoNode/src/videoProcessing';
import { analysisPath, analyzeVideo, runFfmpeg } from './greenroom-videoAnalysis';
import type { AnalysisOptions, AnalysisResult } from './greenroom-videoAnalysis';

type Source = { source: string; outputDirectory: string };
export type LocalMediaRequest = Source & (
  | { kind: 'frames'; method?: 'adaptive' | 'content'; threshold?: number; minSceneSeconds?: number; frames?: boolean; clips?: boolean; audio?: boolean }
  | { kind: 'video'; action: 'extractAudio' | 'separate' | 'trim'; start?: number; end?: number }
  | { kind: 'image-grid'; rows: number; columns: number }
);
export type LocalMedia = {
  path: string; mimeType: string; mediaType: 'image' | 'video' | 'audio'; label: string;
  width?: number; height?: number; duration?: number; row?: number; column?: number; sceneIndex?: number;
};
export type LocalMediaResult = {
  media: LocalMedia[];
  details: AnalysisResult | { action: string; duration: number; width?: number; height?: number }
    | { rows: number; columns: number; width: number; height: number; implementation: 'ffmpeg-grid-equivalent' };
};

function probe(ffmpeg: BrowserFfmpegFactory, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const command = ffmpeg(path);
  const cancel = () => command.kill();
  signal.addEventListener('abort', cancel, { once: true });
  return new Promise<FfprobeData>((accept, reject) => {
    command.ffprobe((error, data) => signal.aborted ? reject(signal.reason) : error ? reject(error) : accept(data));
  }).finally(() => signal.removeEventListener('abort', cancel));
}

/** Parent owns source membership, media leases, Asset registration and the canvas commit.
 * outputDirectory must be new and its parent must already exist. No model or tool download runs here.
 */
export async function processLocalMedia(directory: string, request: LocalMediaRequest, signal = new AbortController().signal): Promise<LocalMediaResult> {
  signal.throwIfAborted();
  const source = analysisPath(request.source), outputDirectory = analysisPath(request.outputDirectory);
  if (!source || !outputDirectory) throw new Error('媒体输入与输出目录不能为空');
  if (!['frames', 'video', 'image-grid'].includes(request.kind)) throw new Error('不支持的本地媒体操作');
  const root = await realpath(directory), destination = resolve(root, outputDirectory);
  const parent = await realpath(dirname(destination));
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error('输出目录超出当前工作区');
  // A symlink alias could otherwise let FFmpeg overwrite an existing file outside this new directory.
  if (parent !== dirname(destination)) throw new Error('输出目录不能经过符号链接');
  const paths = await prepareWorkspaceFfmpeg(signal);
  const native = createFfmpeg(root);
  native.setFfmpegPath(paths.ffmpeg);
  native.setFfprobePath(paths.ffprobe);
  const ffmpeg = native as unknown as BrowserFfmpegFactory;
  signal.throwIfAborted();
  await mkdir(destination);
  try {
    if (request.kind === 'video') {
      const audioPath = `${outputDirectory}/audio.m4a`, videoPath = `${outputDirectory}/video.mp4`;
      const result = await processVideo(ffmpeg, source, { ...request, audioPath, videoPath }, signal);
      const media: LocalMedia[] = [];
      if (request.action !== 'trim') {
        const audio = await probe(ffmpeg, audioPath, signal);
        const duration = Number(audio.format.duration);
        if (!audio.streams.some(stream => stream.codec_type === 'audio') || !(duration > 0)) throw new Error('提取的音轨无效');
        media.push({ path: audioPath, mimeType: 'audio/mp4', mediaType: 'audio', label: '提取音轨', duration });
      }
      if (request.action !== 'extractAudio') media.push({ path: videoPath, mimeType: 'video/mp4', mediaType: 'video',
        label: request.action === 'trim' ? '截取视频' : '无声视频', ...result });
      return { media, details: { action: request.action, ...result } };
    }
    if (request.kind === 'frames') {
      const method = request.method ?? 'adaptive', threshold = request.threshold ?? (method === 'content' ? 27 : 3);
      const minSceneSeconds = request.minSceneSeconds ?? 0.6;
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 255 || !Number.isFinite(minSceneSeconds) || minSceneSeconds < 0 || minSceneSeconds > 60) {
        throw new Error('请填写有效的切镜阈值和最短镜头时长');
      }
      // Native analysis consumes only these workspace methods, all within the fresh output directory.
      const outputPath = (path: string) => {
        const target = resolve(root, analysisPath(path));
        if (!target.startsWith(destination + sep)) throw new Error('拉片文件超出本次输出目录');
        return target;
      };
      const workspace = {
        async mkdir(path: string) { await mkdir(outputPath(path)); },
        async read(path: string) {
          const bytes = await readFile(outputPath(path));
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        },
        async list(path: string) {
          return { directory: path, entries: (await readdir(outputPath(path), { withFileTypes: true })).map(entry => ({
            name: entry.name, path: `${path}/${entry.name}`, type: entry.isDirectory() ? 'directory' as const : 'file' as const,
          })) };
        },
        async remove(path: string, recursive = false) { await rm(outputPath(path), { recursive }); },
        async writeJson(path: string, data: unknown, exclusive = false) {
          await writeFile(outputPath(path), JSON.stringify(data, null, 2), { flag: exclusive ? 'wx' : 'w' });
        },
      } as AnalysisOptions['workspace'];
      const result = await analyzeVideo({ ffmpeg, workspace, source, directory: outputDirectory, method, threshold, minSceneSeconds,
        frames: request.frames ?? true, clips: request.clips ?? true, audio: request.audio ?? true, signal, onProgress() {} });
      const media: LocalMedia[] = [];
      for (const scene of result.scenes) {
        if (scene.image) media.push({ path: scene.image, sceneIndex: scene.index, mimeType: 'image/jpeg', mediaType: 'image', label: `镜头 ${scene.index} 关键帧`, width: result.width, height: result.height });
        if (scene.video) {
          const clip = await probe(ffmpeg, scene.video, signal), video = clip.streams.find(stream => stream.codec_type === 'video')!;
          media.push({ path: scene.video, sceneIndex: scene.index, mimeType: 'video/mp4', mediaType: 'video', label: `镜头 ${scene.index} 片段`,
            width: video.width, height: video.height, duration: Number(clip.format.duration) });
        }
      }
      if (result.audio) {
        const audio = await probe(ffmpeg, result.audio, signal);
        media.push({ path: result.audio, sceneIndex: 0, mimeType: 'audio/mp4', mediaType: 'audio', label: '原音轨', duration: Number(audio.format.duration) });
      }
      // sceneManifest.json is the upstream editable analysis result, not an extra evidence record.
      return { media, details: result };
    }
    const { rows, columns } = request;
    if (![rows, columns].every(value => Number.isInteger(value) && value >= 1 && value <= 10) || rows * columns <= 1) throw new Error('宫格行列须为 1 到 10 的整数，且至少切分两张图片');
    const info = await probe(ffmpeg, source, signal), image = info.streams.find(stream => stream.codec_type === 'video');
    if (!image?.width || !image.height || !String(info.format.format_name).split(',').some(name => ['image2', 'image2pipe', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe'].includes(name))) {
      throw new Error('宫格切分仅支持 FFmpeg 可读取的 PNG、JPEG、WebP、BMP、TIFF 静态图片');
    }
    const { width, height } = image;
    if (width < columns || height < rows) throw new Error('图片尺寸小于切分行列数');
    const media: LocalMedia[] = [];
    // Same integer boundaries and row-major order as imageGridSplit.vue; this is not its browser canvas/editor.
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      signal.throwIfAborted();
      const left = Math.floor(column * width / columns), top = Math.floor(row * height / rows);
      const tileWidth = Math.floor((column + 1) * width / columns) - left, tileHeight = Math.floor((row + 1) * height / rows) - top;
      const path = `${outputDirectory}/tile-${row + 1}-${column + 1}.png`;
      await runFfmpeg(ffmpeg(source).noAudio().videoFilters(`format=rgba,crop=${tileWidth}:${tileHeight}:${left}:${top}:exact=1`)
        .frames(1).outputOptions('-update', '1').output(path), signal);
      const tile = (await probe(ffmpeg, path, signal)).streams.find(stream => stream.codec_type === 'video');
      if (tile?.width !== tileWidth || tile?.height !== tileHeight) throw new Error('宫格图片尺寸与切分边界不符');
      media.push({ path, mimeType: 'image/png', mediaType: 'image', label: `图片 ${row + 1}-${column + 1}`,
        width: tileWidth, height: tileHeight, row: row + 1, column: column + 1 });
    }
    return { media, details: { rows, columns, width, height, implementation: 'ffmpeg-grid-equivalent' } };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
