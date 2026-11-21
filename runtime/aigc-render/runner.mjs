import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.bin': 'application/octet-stream', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.ktx': 'image/ktx', '.ktx2': 'image/ktx2' };
const policy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts allow-same-origin";

function number(value, name, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`渲染参数 ${name} 无效`);
  return value;
}

async function inputFile(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('渲染资源必须位于 input 内');
  const path = await realpath(join(root, name));
  if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('渲染资源越过 input 边界');
  return path;
}

export async function render(inputDirectory = '/input', outputDirectory = '/output') {
  const input = await realpath(inputDirectory), output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  let browser, server, encoder, encoding, job;
  const resultPath = join(output, 'result.json');
  try {
    job = JSON.parse(await readFile(await inputFile(input, 'job.json'), 'utf8'));
    if (job.version !== 1 || !['lemo-opuscar', 'take-one'].includes(job.suiteId)) throw new Error('不支持的渲染输入协议');
    const entry = await inputFile(input, job.entry);
    if (extname(entry) !== '.html') throw new Error('渲染入口必须为 HTML');
    const width = number(job.width, 'width', 2, 3840, true), height = number(job.height, 'height', 2, 3840, true);
    if (width % 2 || height % 2) throw new Error('渲染宽高必须为偶数');
    const fps = number(job.fps, 'fps', 1, 60, true), duration = number(job.duration, 'duration', 0.05, 600);
    const audio = job.audio ? await inputFile(input, job.audio) : undefined;
    server = createServer(async (req, res) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
        const url = new URL(req.url, 'http://renderer');
        if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        const file = await inputFile(input, decodeURIComponent(url.pathname).slice(1));
        if (!types[extname(file)]) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') return res.end();
        createReadStream(file).on('error', () => res.destroy()).pipe(res);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    // The dedicated Job is the execution boundary: no network, credentials or
    // other member data, read-only root/input and only this task's output/tmp.
    // Do not require user namespaces or relax the caller's Pod security policy.
    // This renderer must never execute inside the DSH host or review service.
    browser = await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--no-pings', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin ? route.continue() : route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    if (job.suiteId === 'lemo-opuscar') {
      // A dropped WebGL context can leave the page alive while every following
      // frame is blank. Ignore a context the page deliberately releases.
      await page.addInitScript(() => {
        const own = new WeakSet(), wrapped = new WeakSet(), lost = new Set();
        for (const type of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) if (type) {
          const getExtension = type.prototype.getExtension;
          type.prototype.getExtension = function (name) {
            const extension = getExtension.apply(this, arguments), canvas = this.canvas;
            if (extension && /^webgl_lose_context$/i.test(name) && !wrapped.has(extension)) {
              wrapped.add(extension);
              const loseContext = extension.loseContext;
              extension.loseContext = function () { own.add(canvas); return loseContext.apply(this, arguments); };
            }
            return extension;
          };
        }
        const name = canvas => canvas?.id ? `canvas#${canvas.id}` : 'canvas';
        addEventListener('webglcontextlost', event => {
          if (own.has(event.target)) return;
          lost.add(event.target);
          window.__greenroomGlLost = name(event.target);
        }, true);
        addEventListener('webglcontextrestored', event => {
          own.delete(event.target);
          lost.delete(event.target);
          window.__greenroomGlLost = lost.size ? name([...lost][0]) : null;
        }, true);
      });
    }
    const checkLemoWebgl = async () => {
      if (job.suiteId !== 'lemo-opuscar') return;
      const lost = await page.evaluate(() => window.__greenroomGlLost || null);
      if (lost) throw new Error(`WebGL 上下文已丢失（${lost}），渲染已停止，请检查场景中的画布和图形资源`);
    };
    let frameError;
    page.on('pageerror', error => { frameError ||= error.message; });
    page.on('console', message => { if (message.type() === 'error') frameError ||= message.text(); });
    page.on('requestfailed', request => { frameError ||= `渲染资源读取失败：${request.failure()?.errorText || '未知原因'} ${request.url()}`; });
    page.on('response', response => { if (response.status() >= 400) frameError ||= `渲染资源读取失败（HTTP ${response.status()}）：${response.url()}`; });
    context.on('page', popup => { if (popup !== page) popup.close(); });
    await page.goto(origin + '/' + relative(input, entry).split(sep).map(encodeURIComponent).join('/'), { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => window.READY === true && (typeof window.renderFrame === 'function' || typeof window.render === 'function'), null, { timeout: 30_000 });
    if (frameError) throw new Error(frameError);
    await checkLemoWebgl();
    const encoderArgs = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'pipe', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0'];
    if (audio) encoderArgs.push('-protocol_whitelist', 'pipe', '-i', 'pipe:3');
    encoderArgs.push('-map', '0:v:0');
    if (audio) encoderArgs.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k');
    encoderArgs.push('-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', String(duration), '-movflags', '+faststart', join(output, 'video.mp4'));
    encoder = spawn('ffmpeg', encoderArgs, { stdio: ['pipe', 'ignore', 'pipe', ...(audio ? ['pipe'] : [])] });
    encoder.stdin.on('error', () => {});
    if (audio) encoder.stdio[3].on('error', () => {});
    let stderr = '';
    encoder.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
    encoding = new Promise((ok, fail) => {
      encoder.once('error', fail);
      encoder.once('close', code => code === 0 ? ok() : fail(new Error(stderr.trim() || `ffmpeg 退出码 ${code}`)));
    });
    // The rejection is consumed below after frame capture, including when the
    // encoder fails before the first frame is written.
    encoding.catch(() => {});
    if (audio) createReadStream(audio).on('error', error => encoder.stdio[3].destroy(error)).pipe(encoder.stdio[3]);
    const frames = Math.ceil(duration * fps);
    for (let frame = 0; frame < frames; frame++) {
      await page.evaluate(async t => { await (window.renderFrame || window.render)(t); }, frame / fps);
      if (frameError) throw new Error(frameError);
      const png = await page.screenshot({ type: 'png', timeout: 30_000 });
      await checkLemoWebgl();
      await new Promise((ok, fail) => encoder.stdin.write(png, error => error ? fail(error) : ok()));
    }
    encoder.stdin.end();
    await encoding;
    const result = { status: 'completed', artifact: { path: 'video.mp4', mimeType: 'video/mp4' }, width, height, fps, duration, frames };
    await writeFile(resultPath, JSON.stringify(result));
    return result;
  } catch (error) {
    encoder?.kill('SIGKILL');
    if (!['lemo-opuscar', 'take-one'].includes(job?.suiteId)) throw error;
    await unlink(join(output, 'video.mp4')).catch(() => {});
    const result = { status: 'failed', error: String(error.message || error) };
    await writeFile(resultPath, JSON.stringify(result));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(ok => server?.listening ? server.close(ok) : ok());
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  render().catch(error => { process.stderr.write(String(error.message || error) + '\n'); process.exitCode = 1; });
}
