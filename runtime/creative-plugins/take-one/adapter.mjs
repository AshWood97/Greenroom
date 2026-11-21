import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { createSuiteAdapter } from '../aigc-shared/adapter.mjs';
import { audioTools } from '../lemo-opuscar/audio-tools.mjs';
import { objectSchema as object, projectIdSchema as projectId, projectFile, prepareRenderInput, textSchema as text, toolDefinition as tool } from '../lemo-opuscar/render-input.mjs';

const prefix = 'take_one';
const base = '/plugins/take-one/';
const documents = { brief: 'BRIEF.md', pitch: 'PITCH.md', brand: 'BRAND.md', storyboard: 'STORYBOARD.md',
  voice: 'VOICE.md', music: 'MUSIC.md', sound: 'SOUND.md', edit: 'EDIT.md', review: 'REVIEW.md', posts: 'POSTS.md', spend: 'spend.md',
  film: 'film/index.html', audio_score: 'music/score.json' };
const reviewState = project => project.review ||= { cuts: [], notes: [], events: [] };
const event = (review, type, data) => review.events.push({ id: randomUUID(), type, at: new Date().toISOString(), ...data });
const cleanText = (value, label, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' 不能为空且不能超过 ' + max + ' 字');
  return value.trim();
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json') || req.headers['x-requested-with'] !== 'greenroom-review') throw new Error('审阅操作需要同源 JSON 请求');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 3 * 1024 * 1024) throw new Error('批注快照过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function media(req, res, path, mimeType) {
  const size = (await stat(path)).size;
  const headers = { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let start = 0, end = size - 1, code = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || !range[1] && !range[2]) { res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + size }); return res.end(); }
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else start = Math.max(0, size - Number(range[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) { res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + size }); return res.end(); }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(code, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  await new Promise(resolve => {
    const stream = createReadStream(path, { start, end });
    stream.once('close', resolve);
    res.once('finish', () => stream.destroy());
    res.once('close', () => stream.destroy());
    stream.once('error', () => res.destroy());
    stream.pipe(res);
  });
}

export async function createAdapter(ctx) {
  const audio = audioTools();
  const suite = await createSuiteAdapter(ctx, {
    id: 'take-one', prefix, knowledgeRoot: '/opt/creative-skills/take-one/take-one', documents,
    scripts: audio.scripts, prepareRender: prepareRenderInput,
    extraTools: [
      tool(prefix, 'capabilities', '读取首映创作室托管能力及明确不可用的外部路线。', object({})),
      tool(prefix, 'register_review_cut', '把已经完成并归档的 render 注册为审阅版本，之后可逐帧批注和双版比较。', object({ projectId, jobId: projectId, renderJobId: projectId, label: text }, ['projectId', 'jobId', 'renderJobId', 'label'])),
      tool(prefix, 'open_review', '返回当前私有工程已认证的审阅室链接。', object({ projectId }, ['projectId'])),
      tool(prefix, 'get_review', '读取本工程所有审阅版本、逐帧批注、快照、逐条回复与发送事件。', object({ projectId }, ['projectId'])),
      tool(prefix, 'add_note', '在已登记成片的某帧、坐标或整片添加批注。', object({ projectId, cutId: projectId, text, t: { oneOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] }, x: { oneOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] }, y: { oneOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] }, shot: { type: 'string' } }, ['projectId', 'cutId', 'text'])),
      tool(prefix, 'reply_note', '逐条回应意见；只有指定真实不同版本后才可将该意见 resolved=true。', object({ projectId, noteId: projectId, text, cutId: projectId, resolved: { type: 'boolean' } }, ['projectId', 'noteId', 'text'])),
      tool(prefix, 'send_notes', '保存 notes/sent 事件及当前待处理批注数，供原制作会话读取。', object({ projectId, cutId: projectId }, ['projectId', 'cutId'])),
      tool(prefix, 'read_review_events', '按事件游标读取批注与 notes/sent 事件；不提交新的生成任务。', object({ projectId, after: projectId }, ['projectId'])),
    ],
    handlers: {
      ...audio.handlers,
      capabilities: () => ({ displayName: '首映创作室', upstream: 'talsiach/take-one', codeFilm: true, reviewRoom: true,
        trustedAudio: ['synthesize', 'trim', 'mix', 'concat'], managedGeneration: ['image', 'video', 'tts', 'music'],
        unavailable: ['Higgsfield/Suno/ElevenLabs 等外部网站操作', '产品网页录屏', '个人 API Key 与外部素材下载', '任意 shell、build.sh 或成员脚本执行'] }),
      async register_review_cut(args, api) {
        const production = await api.getProduction({ projectId: args.projectId, jobId: args.jobId });
        const job = production.jobs.find(item => item.jobId === args.renderJobId && item.kind === 'render');
        const path = 'renders/' + args.renderJobId + '/output/video.mp4';
        if (job?.status !== 'completed' || !job.outputs?.some(output => output.projectPath === path)) throw new Error('只能登记本工程已完成且归档的 MP4 成片');
        await projectFile(api, args.projectId, path);
        const project = await api.loadProject(args.projectId), review = reviewState(project);
        const existing = review.cuts.find(cut => cut.renderJobId === args.renderJobId);
        if (existing) return existing;
        const cut = { id: randomUUID(), label: cleanText(args.label, '版本名称', 100), productionJobId: args.jobId, renderJobId: args.renderJobId,
          fps: job.render.fps, duration: job.render.duration, width: job.render.width, height: job.render.height, output: job.outputs[0], createdAt: new Date().toISOString() };
        cut.video = `video/${args.projectId}/${cut.id}.mp4`;
        review.cuts.unshift(cut); event(review, 'cut/registered', { cutId: cut.id });
        await api.saveProject(project);
        return cut;
      },
      async open_review(args, api) { await api.loadProject(args.projectId); return { title: '首映创作室', url: base + '?projectId=' + encodeURIComponent(args.projectId) }; },
      async get_review(args, api) {
        const project = await api.loadProject(args.projectId);
        const current = project.productions[project.currentProductionId];
        const production = current ? { jobId: current.jobId, status: current.status, jobs: current.jobs.map(job => ({ jobId: job.jobId, platformTaskId: job.platformTaskId,
          label: job.label, status: job.status, error: job.error, lastQueryError: job.lastQueryError, archiveError: job.archiveError })) } : null;
        return { projectId: project.projectId, title: project.title, revision: project.revision, production, ...reviewState(project) };
      },
      async add_note(args, api) {
        const project = await api.loadProject(args.projectId), review = reviewState(project), cut = review.cuts.find(item => item.id === args.cutId);
        if (!cut) throw new Error('审阅版本不存在');
        const t = args.t === undefined || args.t === null ? null : Number(args.t);
        if (t !== null && (!Number.isFinite(t) || t < 0 || t > cut.duration)) throw new Error('批注时间超出成片范围');
        const pin = args.x !== undefined && args.x !== null || args.y !== undefined && args.y !== null;
        if (pin && (t === null || ![args.x, args.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1))) throw new Error('逐帧坐标必须为 0–1 范围内的 x/y');
        const note = { id: randomUUID(), cutId: cut.id, cut: cut.label, t, frame: t === null ? null : Math.min(Math.ceil(cut.duration * cut.fps) - 1, Math.round(t * cut.fps)),
          x: pin ? args.x : null, y: pin ? args.y : null, text: cleanText(args.text, '批注'), done: false, at: new Date().toISOString(), replies: [] };
        if (args.shot !== undefined) {
          if (typeof args.shot !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(args.shot)) throw new Error('批注快照必须为 JPEG');
          const data = Buffer.from(args.shot.slice('data:image/jpeg;base64,'.length), 'base64');
          if (data.length > 2 * 1024 * 1024 || data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw new Error('JPEG 快照无效或过大');
          const root = await realpath(api.projectPath(args.projectId)), directory = join(root, 'review/shots');
          await mkdir(directory, { recursive: true });
          if (!(await realpath(directory)).startsWith(root + sep)) throw new Error('批注快照路径不属于当前工程');
          await writeFile(join(directory, note.id + '.jpg'), data);
          note.shot = `shots/${args.projectId}/${note.id}.jpg`;
        }
        review.notes.push(note); event(review, 'notes/created', { cutId: cut.id, noteId: note.id });
        await api.saveProject(project); return note;
      },
      async reply_note(args, api) {
        const project = await api.loadProject(args.projectId), review = reviewState(project), note = review.notes.find(item => item.id === args.noteId);
        if (!note) throw new Error('批注不存在');
        const cut = args.cutId && review.cuts.find(item => item.id === args.cutId);
        if (args.cutId && !cut || args.resolved === true && (!cut || cut.id === note.cutId)) throw new Error('解决批注需绑定真实的新成片版本');
        const reply = { id: randomUUID(), text: cleanText(args.text, '回应'), cutId: cut?.id || null, resolved: args.resolved === true, at: new Date().toISOString() };
        note.replies.push(reply); note.done = reply.resolved;
        event(review, 'notes/replied', { noteId: note.id, cutId: reply.cutId, resolved: reply.resolved });
        await api.saveProject(project); return note;
      },
      async send_notes(args, api) {
        const project = await api.loadProject(args.projectId), review = reviewState(project);
        if (!review.cuts.some(cut => cut.id === args.cutId)) throw new Error('审阅版本不存在');
        event(review, 'notes/sent', { cutId: args.cutId, open: review.notes.filter(note => !note.done && note.cutId === args.cutId).length });
        await api.saveProject(project); return review.events.at(-1);
      },
      async read_review_events(args, api) {
        const project = await api.loadProject(args.projectId), review = reviewState(project);
        const index = args.after ? review.events.findIndex(item => item.id === args.after) : -1;
        return { events: review.events.slice(index + 1), cursor: review.events.at(-1)?.id || null };
      },
    },
  });
  suite.handleUi = async (req, res, suffix) => {
    try {
      const url = new URL(req.url, 'http://managed');
      const path = suffix.split('?')[0];
      const get = ['GET', 'HEAD'].includes(req.method);
      const fixed = { '/': ['review.html', 'text/html; charset=utf-8'], '/review.mjs': ['review.mjs', 'text/javascript; charset=utf-8'], '/review.css': ['review.css', 'text/css; charset=utf-8'] }[path];
      if (get && fixed) {
        const content = await readFile(new URL('./' + fixed[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': fixed[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'" });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      const call = async (name, args) => (await suite.callTool(prefix + '_' + name, args)).structuredContent;
      if (req.method === 'GET' && path === '/api/projects') return json(res, 200, await call('list_projects', {}));
      if (req.method === 'GET' && path === '/api/review') return json(res, 200, await call('get_review', { projectId: url.searchParams.get('projectId') }));
      const action = { '/api/notes': 'add_note', '/api/reply': 'reply_note', '/api/send': 'send_notes' }[path];
      if (req.method === 'POST' && action) return json(res, 200, await call(action, await body(req)));
      const match = /^\/(video|shots)\/([A-Za-z0-9_-]{1,64})\/([0-9a-f-]{36})\.(mp4|jpg)$/.exec(path);
      if (get && match && (match[1] === 'video' && match[4] === 'mp4' || match[1] === 'shots' && match[4] === 'jpg')) {
        return await suite.withMediaLease(match[2], async () => {
          const file = await (async () => {
          const api = suite.api(), project = await api.loadProject(match[2]), review = reviewState(project);
          if (match[1] === 'video') {
            const cut = review.cuts.find(item => item.id === match[3]);
            if (!cut) throw new Error('审阅版本不存在');
            return projectFile(api, project.projectId, 'renders/' + cut.renderJobId + '/output/video.mp4');
          }
          if (!review.notes.some(note => note.id === match[3] && note.shot)) throw new Error('批注快照不存在');
          return projectFile(api, project.projectId, 'review/shots/' + match[3] + '.jpg');
          })();
          return await media(req, res, file, match[1] === 'video' ? 'video/mp4' : 'image/jpeg');
        });
      }
      return json(res, 404, { error: '审阅资源不存在' });
    } catch (error) { return json(res, 400, { error: ctx.formatGenerationError(error.message || error) }); }
  };
  return suite;
}
