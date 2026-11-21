'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const MAX_BYTES = 512 * 1024 * 1024;

// FramePairNode v3.4.5 uses video/canvas at 0.001s and duration - 0.05s.
// This member-local equivalent reads only the existing owner Asset endpoint,
// extracts PNGs with FFmpeg, and uploads through the existing Asset service.
async function extractFramePair({ sourceUrl, directory, signal, checkpoint }) {
  const asset = String(sourceUrl || '').replace(/^\/canvas(?=\/api\/media\/)/, '');
  if (!/^\/api\/media\/[^/?#]+$/.test(asset)) throw new Error('FramePair 输入须为当前成员资产服务中的视频');
  const storage = await import('./greenroom-media-storage.mjs');
  storage.assertStorageAvailable(directory, { reserveBytes: MAX_BYTES });
  fs.mkdirSync(directory, { recursive: true });
  const work = fs.mkdtempSync(path.join(directory, 'frame-pair-'));
  const input = path.join(work, 'input-video');
  await checkpoint({ stage: 'downloading', sourceUrl: asset });
  const response = await fetch('http://127.0.0.1:3081' + asset, { signal, redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('video/')) {
    await response.body?.cancel();
    throw new Error(`FramePair 读取成员视频失败（HTTP ${response.status}）`);
  }
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    done(bytes > MAX_BYTES ? new Error('FramePair 视频超过 512 MiB 上限') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal });
  const { resolveBundledFfmpeg, resolveBundledFfprobe } = require('./providers/llmMedia');
  const { withFfmpegProcessSlot } = require('./utils/ffmpegProcessQueue');
  const run = (program, args) => execute(program, args, { signal, timeout: 120000, maxBuffer: 1024 * 1024 });
  const probe = JSON.parse((await run(resolveBundledFfprobe(), ['-v', 'error', '-show_entries', 'format=duration,start_time', '-of', 'json', input])).stdout);
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('FramePair 无法读取视频时长');
  const start = Number(probe.format?.start_time) || 0;
  const result = {};
  for (const [name, time] of [['first', 0.001], ['last', Math.max(0, duration - 0.05)]]) {
    const file = path.join(work, name + '.png');
    await checkpoint({ stage: 'extracting-' + name, sourceUrl: asset, ...result });
    // Browser currentTime displays the frame spanning the target, not the next
    // frame. Resolve its PTS so sub-frame seeks do not skip frame zero or lose
    // the tail on low-FPS videos. Read only the target's nearby keyframe interval.
    const frames = JSON.parse((await run(resolveBundledFfprobe(), ['-v', 'error', '-select_streams', 'v:0',
      '-read_intervals', `${start + Math.max(0, time - 1)}%${start + time + 1}`,
      '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input])).stdout).frames || [];
    const times = frames.map((frame) => Number(frame.best_effort_timestamp_time) - start).filter(Number.isFinite);
    const selected = times.filter((value) => value <= time + 0.000001).at(-1) ?? times[0];
    if (selected === undefined) throw new Error(`FramePair ${name} 帧时间不可读取`);
    await withFfmpegProcessSlot(() => run(resolveBundledFfmpeg(), ['-nostdin', '-v', 'error', '-n', '-ss', String(Math.max(0, selected - 0.000001)),
      '-i', input, '-frames:v', '1', '-threads', '1', file]), { isCancelled: () => signal.aborted });
    if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error(`FramePair ${name} 帧未产出`);
    await checkpoint({ stage: 'uploading-' + name, sourceUrl: asset, ...result });
    const media = await storage.archiveFile(file, { filename: `frame-pair-${name}.png`, assetType: 'image', signal });
    if (!/^\/api\/media\/[^/?#]+$/.test(media.fileUrl || '')) throw new Error('FramePair 上传未返回成员资产地址');
    result[name + 'FrameUrl'] = media.fileUrl;
    await checkpoint({ stage: 'uploaded-' + name, sourceUrl: asset, ...result });
  }
  const patch = { ...result, imageUrl: '', imageUrls: [], status: 'success', error: '', greenroomExecutionMode: 'extracted-frames' };
  await checkpoint({ stage: 'complete', sourceUrl: asset, ...result, patch });
  // Only this invocation's temporary copies are removed after both Assets exist.
  fs.rmSync(work, { recursive: true, force: true });
  return patch;
}
module.exports = { extractFramePair };
