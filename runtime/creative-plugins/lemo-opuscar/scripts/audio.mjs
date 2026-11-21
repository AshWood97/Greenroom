// Fixed image-owned audio operations. The sole argument is business JSON,
// never JavaScript, a shell command, an ffmpeg expression or a module path.
import { createReadStream } from 'node:fs';
import { link, mkdir, open, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, sep } from 'node:path';

const SR = 48000;
const numeric = (value, min, max, label) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(label + ' 无效');
  return value;
};
const option = JSON.parse(process.argv[2]);
const root = await realpath(process.cwd());
if (!/^media\/[0-9a-f-]{36}\.wav$/.test(option.output)) throw new Error('音频输出必须为固定工程路径');
const output = join(root, option.output);
await mkdir(dirname(output), { recursive: true });
if (!(await realpath(dirname(output))).startsWith(root + sep)) throw new Error('音频输出路径越过当前工程');
const work = join(dirname(output), '.' + basename(output) + '.work');
const pending = join(work, 'output.wav');

function synthesize(score) {
  const duration = numeric(score.duration, 0.05, 600, '音频时长');
  if (!Array.isArray(score.notes) || score.notes.length > 20000) throw new Error('音符列表无效');
  const frames = Math.ceil(duration * SR), left = new Float32Array(frames), right = new Float32Array(frames);
  for (const note of score.notes) {
    const at = numeric(note.at, 0, duration, '音符起点'), length = numeric(note.duration, 0.001, duration, '音符长度');
    const frequency = numeric(note.frequency, 20, 20000, '音符频率'), velocity = numeric(note.velocity ?? 0.25, 0, 1, '音符音量');
    const pan = numeric(note.pan ?? 0, -1, 1, '声像'), wave = note.wave || 'sine';
    if (!['sine', 'triangle', 'square'].includes(wave)) throw new Error('音色仅支持 sine、triangle、square');
    const start = Math.round(at * SR), count = Math.min(Math.ceil(length * SR), frames - start);
    for (let sample = 0; sample < count; sample++) {
      const seconds = sample / SR, phase = seconds * frequency;
      const sound = wave === 'sine' ? Math.sin(phase * Math.PI * 2) : wave === 'triangle' ? 2 / Math.PI * Math.asin(Math.sin(phase * Math.PI * 2)) : Math.sin(phase * Math.PI * 2) >= 0 ? 1 : -1;
      const envelope = Math.min(1, seconds / 0.008, (length - seconds) / 0.04);
      const value = sound * Math.max(0, envelope) * velocity;
      left[start + sample] += value * Math.sqrt((1 - pan) / 2);
      right[start + sample] += value * Math.sqrt((1 + pan) / 2);
    }
  }
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SR, 24); buffer.writeUInt32LE(SR * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 4, 40);
  for (let sample = 0; sample < frames; sample++) {
    buffer.writeInt16LE(Math.round(Math.tanh(left[sample]) * 30000), 44 + sample * 4);
    buffer.writeInt16LE(Math.round(Math.tanh(right[sample]) * 30000), 46 + sample * 4);
  }
  return buffer;
}

try {
  await mkdir(work, { mode: 0o700 });
  if (option.operation === 'synthesize') await writeFile(pending, synthesize(option.score), { flag: 'wx' });
  else {
    if (!['trim', 'mix', 'concat'].includes(option.operation) || !Array.isArray(option.inputs) || option.inputs.length < 1 || option.inputs.length > 16) throw new Error('音频操作或素材数量无效');
    if (option.operation === 'trim' && option.inputs.length !== 1) throw new Error('trim 只接收一个音频素材');
    const demuxers = { '.wav': 'wav', '.mp3': 'mp3', '.m4a': 'mov', '.mp4': 'mov', '.flac': 'flac', '.ogg': 'ogg', '.aac': 'aac' };
    const inputs = [];
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n'];
    for (const [index, name] of option.inputs.entries()) {
      if (typeof name !== 'string' || !/^media\/[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/.test(name)) throw new Error('音频素材必须为工程 media 文件');
      const file = await realpath(join(root, name));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error('音频素材不属于当前工程');
      const demuxer = demuxers[extname(file).toLowerCase()];
      if (!demuxer) throw new Error('不支持该音频格式');
      inputs.push(file);
      // Force a real media demuxer and pipe-only input. Playlists cannot read
      // other host files or make network requests through ffmpeg.
      args.push('-protocol_whitelist', 'pipe', '-f', demuxer, '-i', 'pipe:' + (index + 3));
    }
    const chains = inputs.map((_, index) => `[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${numeric(option.gains?.[index] ?? 1, 0, 4, '音轨增益')}[a${index}]`);
    const labels = inputs.map((_, index) => `[a${index}]`).join('');
    if (option.operation === 'mix') chains.push(labels + `amix=inputs=${inputs.length}:normalize=0,alimiter=limit=0.95[m]`);
    else if (option.operation === 'concat') chains.push(labels + `concat=n=${inputs.length}:v=0:a=1[m]`);
    else chains.push('[a0]anull[m]');
    const filters = [];
    const offset = numeric(option.offset ?? 0, 0, 600, '音频裁切起点');
    if (option.operation === 'trim') {
      numeric(option.duration, 0.05, 600, '音频裁切长度');
      filters.push(`atrim=start=${offset}:duration=${option.duration}`, 'asetpts=PTS-STARTPTS');
    } else if (option.duration !== undefined) filters.push('atrim=duration=' + numeric(option.duration, 0.05, 600, '音频长度'));
    const fadeIn = numeric(option.fadeIn ?? 0, 0, 30, '淡入时间'), fadeOut = numeric(option.fadeOut ?? 0, 0, 30, '淡出时间');
    if (fadeIn) filters.push('afade=t=in:d=' + fadeIn);
    if (fadeOut) {
      if (!Number.isFinite(option.duration) || fadeOut > option.duration) throw new Error('淡出须指定不小于淡出的 duration');
      filters.push(`afade=t=out:st=${option.duration - fadeOut}:d=${fadeOut}`);
    }
    chains.push('[m]' + (filters.length ? filters.join(',') : 'anull') + '[out]');
    args.push('-filter_complex', chains.join(';'), '-map', '[out]', '-acodec', 'pcm_s16le', '-ar', String(SR), '-ac', '2', pending);
    await new Promise((ok, fail) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe', ...inputs.map(() => 'pipe')] });
      let stderr = '';
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
      child.once('error', fail);
      child.once('close', code => code === 0 ? ok() : fail(new Error(stderr.trim() || 'ffmpeg 退出码 ' + code)));
      for (const [index, file] of inputs.entries()) {
        child.stdio[index + 3].on('error', () => {});
        createReadStream(file).on('error', error => child.stdio[index + 3].destroy(error)).pipe(child.stdio[index + 3]);
      }
    });
  }
  const handle = await open(pending, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  // The visible task path is created only after the producer has completed.
  // link() is atomic and refuses to replace an existing result.
  await link(pending, output);
  const directory = await open(dirname(output), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  await unlink(pending);
  await rmdir(work);
  process.stdout.write(JSON.stringify({ path: option.output, mimeType: 'audio/wav', operation: option.operation }));
} catch (error) { process.stderr.write(String(error.message || error)); process.exitCode = 1; }
