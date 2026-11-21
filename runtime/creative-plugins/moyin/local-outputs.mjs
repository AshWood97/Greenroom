import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';

// Native folder-export transport. Files are private member outputs, not browser downloads.
export function createLocalOutputs({ media, base, inside, scope, readMedia, splitQuad }) {
  const folder = () => {
    const id = scope.getStore()?.id;
    if (!id) throw new Error('本地输出必须属于持久化业务任务');
    const root = inside(media, 'outputs/job-' + encodeURIComponent(id));
    return { root, receipt: join(root, 'result.json') };
  };
  const ref = file => ({ url: base + 'media/' + relative(media, file).split(sep).map(encodeURIComponent).join('/'), localPath: 'local-image://' + relative(media, file).split(sep).join('/') });
  const begin = () => {
    const location = folder();
    if (existsSync(location.receipt)) return { ...location, previous: JSON.parse(readFileSync(location.receipt, 'utf8')) };
    if (existsSync(location.root)) throw new Error('原任务留有部分本地输出，已保留且不覆盖；请查看原文件并显式创建新导出任务');
    mkdirSync(location.root, { recursive: true });
    return location;
  };
  return {
    async exportFolder(run) {
      const target = begin(); if (target.previous) return target.previous;
      const files = [];
      const handle = directory => ({
        async getDirectoryHandle(name) { const file = inside(directory, name); mkdirSync(file, { recursive: true }); return handle(file); },
        async getFileHandle(name) { const file = inside(directory, name); return { async createWritable() {
          let content;
          return { async write(value) { content = value instanceof Blob ? Buffer.from(await value.arrayBuffer()) : value; },
            async close() { if (content === undefined) throw new Error('原生导出未写入内容'); try { writeFileSync(file, content, { flag: 'wx' }); } catch (error) { error.code = 'GREENROOM_EXPORT_PARTIAL'; throw error; } files.push({ name: relative(target.root, file).split(sep).join('/'), ...ref(file) }); } };
        } }; },
      });
      const previous = globalThis.window.showDirectoryPicker;
      globalThis.window.showDirectoryPicker = async () => handle(target.root);
      try { if (await run() !== true) throw new Error('原生目录导出未完成'); }
      finally { if (previous) globalThis.window.showDirectoryPicker = previous; else delete globalThis.window.showDirectoryPicker; }
      const result = { kind: 'native-folder-export', files };
      writeFileSync(target.receipt, JSON.stringify(result), { flag: 'wx' });
      return result;
    },
    async split(reference) {
      const target = begin(); if (target.previous) return target.previous;
      const result = await splitQuad(await readMedia(reference));
      const images = result.tiles.map(tile => { const file = join(target.root, `quad-${tile.index + 1}.png`); writeFileSync(file, tile.bytes, { flag: 'wx' }); return { index: tile.index, position: tile.position, width: tile.width, height: tile.height, ...ref(file) }; });
      const output = { kind: 'existing-quad-split', original: reference, images };
      writeFileSync(target.receipt, JSON.stringify(output), { flag: 'wx' });
      return output;
    },
  };
}

// The member server owns both native fileStorage IPC and worker writes. Keep the
// read/compare/rename synchronous: no other request in that process can interleave.
// This is not a lock for multiple servers writing the same member directory.
export function createShotWriteback({ db, filename }) {
  db.exec('CREATE TABLE IF NOT EXISTS shot_selections(job_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0)');
  const kindOf = operation => operation === 'shot_image' ? 'image' : operation === 'shot_video' ? 'video' : null;
  const fieldsOf = kind => kind === 'video' ? ['imageUrl', 'videoUrl'] : ['imageUrl'];
  const valueOf = (shot, field) => shot?.[field] ?? null;
  function projectIn(document, projectId) {
    const state = document?.state ?? document;
    if (state?.projects && typeof state.projects === 'object') return state.projects[projectId];
    return state?.activeProjectId === projectId ? state.projectData : undefined;
  }
  function read(projectId, shotId) {
    const scoped = '_p/' + projectId + '/script';
    const key = existsSync(filename(scoped)) ? scoped : 'moyin-script-store';
    if (!existsSync(filename(key))) return null;
    const document = JSON.parse(readFileSync(filename(key), 'utf8'));
    const project = projectIn(document, projectId);
    if (!Array.isArray(project?.shots)) return null;
    const shot = project.shots.find(item => item.id === shotId);
    return shot ? { key, document, project, shot } : null;
  }
  function capture(operation, args) {
    const kind = kindOf(operation);
    if (!kind) return null;
    const projectId = args.projectId, shotId = args.shotId || args.shot?.id;
    if (typeof projectId !== 'string' || !projectId || typeof shotId !== 'string' || !shotId) throw new Error('请指定已有项目和分镜');
    const current = read(projectId, shotId);
    if (!current) throw new Error('分镜存储不可读取，未提交生成');
    // A renderer may still hold an older Shot object. Do not authorize replacing
    // today's selection on behalf of that older view.
    if (args.shot && fieldsOf(kind).some(field => valueOf(args.shot, field) !== valueOf(current.shot, field))) throw new Error('分镜选择已改变，请刷新后再生成');
    return { projectId, shotId, kind, expected: Object.fromEntries(fieldsOf(kind).map(field => [field, valueOf(current.shot, field)])), shot: args.shot || current.shot };
  }
  function record(id, snapshot) {
    // A newly requested generation for this slot supersedes older automatic
    // selection, while every older task and its eventual result stay available.
    for (const row of db.prepare('SELECT job_id,snapshot FROM shot_selections WHERE invalidated=0').all()) {
      const prior = JSON.parse(row.snapshot);
      if (prior.projectId === snapshot.projectId && prior.shotId === snapshot.shotId && prior.kind === snapshot.kind) db.prepare('UPDATE shot_selections SET invalidated=1 WHERE job_id=?').run(row.job_id);
    }
    db.prepare('INSERT INTO shot_selections(job_id,snapshot) VALUES(?,?)').run(id, JSON.stringify(snapshot));
  }
  function get(id) {
    const row = db.prepare('SELECT * FROM shot_selections WHERE job_id=?').get(id);
    return row ? { ...row, snapshot: JSON.parse(row.snapshot) } : null;
  }
  // Native Zustand persists an entire project even for a character edit. Use
  // exactly what this renderer read to distinguish an unchanged old selection
  // from an explicit user change while a background shot result was saved.
  function mergeWrite(key, value, previous) {
    const result = { value, superseded: [] };
    if (typeof previous !== 'string' || typeof value !== 'string' || !existsSync(filename(key))) return result;
    const scoped = /^_p\/(.+)\/script$/.exec(key);
    if (!scoped && key !== 'moyin-script-store') return result;
    const incoming = JSON.parse(value), base = JSON.parse(previous), current = JSON.parse(readFileSync(filename(key), 'utf8'));
    const ids = scoped ? [scoped[1]] : Object.keys((incoming.state ?? incoming)?.projects || {});
    for (const projectId of ids) {
      const nextProject = projectIn(incoming, projectId), baseProject = projectIn(base, projectId), currentProject = projectIn(current, projectId);
      if (!Array.isArray(nextProject?.shots) || !Array.isArray(baseProject?.shots) || !Array.isArray(currentProject?.shots)) continue;
      for (const next of nextProject.shots) {
        const prior = baseProject.shots.find(shot => shot.id === next.id);
        const latest = currentProject.shots.find(shot => shot.id === next.id);
        if (!prior || !latest) continue;
        for (const kind of ['image', 'video']) for (const part of ['Url', 'Status', 'Progress', 'Error']) {
          const field = kind + part;
          if (valueOf(next, field) === valueOf(prior, field)) {
            if (Object.hasOwn(latest, field)) next[field] = latest[field]; else delete next[field];
          } else if (part === 'Url' && valueOf(latest, field) !== valueOf(prior, field) && valueOf(next, field) !== valueOf(latest, field)) {
            result.superseded.push({ projectId, shotId: next.id, kind, output: valueOf(latest, field) });
          }
        }
      }
    }
    result.value = JSON.stringify(incoming);
    return result;
  }
  function finishWrite(superseded) {
    if (!superseded.length) return;
    const rows = db.prepare('SELECT s.job_id,s.snapshot,j.result FROM shot_selections s JOIN jobs j ON j.id=s.job_id WHERE j.state=\'succeeded\' AND j.result IS NOT NULL').all();
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot), result = JSON.parse(row.result);
      if (result.selection?.status !== 'applied' || !superseded.some(item => item.projectId === snapshot.projectId && item.shotId === snapshot.shotId && item.kind === snapshot.kind && item.output === result.url)) continue;
      result.selection = { status: 'conflict', message: '生成产物已保留；之后用户更改了分镜选择，未覆盖用户选择' };
      db.prepare('UPDATE jobs SET result=? WHERE id=?').run(JSON.stringify(result), row.job_id);
    }
  }
  // Native writes invalidate outstanding selections before touching the file.
  // The durable bit also catches A -> B -> A, deletion and project replacement.
  function beforeWrite(key, raw, directory = false, excludeJobId = null) {
    if (!directory && key !== 'moyin-script-store' && !/^_p\/.+\/script$/.test(key)) return;
    const rows = db.prepare('SELECT job_id,snapshot FROM shot_selections WHERE invalidated=0').all();
    let parsed;
    for (const row of rows) {
      if (row.job_id === excludeJobId) continue;
      const snapshot = JSON.parse(row.snapshot);
      const scoped = '_p/' + snapshot.projectId + '/script';
      const relevant = directory ? scoped === key || scoped.startsWith(key + '/') || key === '' : key === scoped || key === 'moyin-script-store';
      if (!relevant) continue;
      // A legacy file is not active after the native scoped file exists.
      if (key === 'moyin-script-store' && existsSync(filename(scoped))) continue;
      if (raw !== null && parsed === undefined) parsed = JSON.parse(raw);
      const shot = raw === null ? null : projectIn(parsed, snapshot.projectId)?.shots?.find(item => item.id === snapshot.shotId);
      const current = raw === null ? null : read(snapshot.projectId, snapshot.shotId);
      if (!shot || !current || Object.keys(snapshot.expected).some(field => valueOf(shot, field) !== valueOf(current.shot, field))) db.prepare('UPDATE shot_selections SET invalidated=1 WHERE job_id=?').run(row.job_id);
    }
  }
  function apply(id, output) {
    const row = get(id);
    const retain = (status, message) => ({ status, message });
    if (!row) return retain('legacy', '原任务缺少提交时的选择快照，产物已保留，未自动替换当前选择');
    if (row.invalidated) return retain('conflict', '提交后分镜选择已改变，产物已保留，当前选择未替换');
    const snapshot = row.snapshot;
    let temporary;
    try {
      const current = read(snapshot.projectId, snapshot.shotId);
      if (!current) return retain('conflict', '分镜已改变或不存在，产物已保留，当前选择未替换');
      const kind = snapshot.kind;
      // The file rename may have completed before the parent task's result was
      // persisted. A still-valid snapshot and the same output identify that
      // completed write without treating an earlier user change as ours.
      if (valueOf(current.shot, kind + 'Url') === output
          && current.shot[kind + 'Status'] === 'completed'
          && current.shot[kind + 'Progress'] === 100
          && Object.entries(snapshot.expected).every(([field, expected]) => field === kind + 'Url' || valueOf(current.shot, field) === expected)) return { status: 'applied' };
      if (Object.entries(snapshot.expected).some(([field, expected]) => valueOf(current.shot, field) !== expected)) return retain('conflict', '分镜已改变或不存在，产物已保留，当前选择未替换');
      Object.assign(current.shot, { [kind + 'Url']: output, [kind + 'Status']: 'completed', [kind + 'Progress']: 100 });
      delete current.shot[kind + 'Error'];
      current.project.updatedAt = Date.now();
      const serialized = JSON.stringify(current.document);
      const target = filename(current.key);
      temporary = target + '.shot-' + randomUUID() + '.tmp';
      const mode = statSync(target).mode & 0o777;
      writeFileSync(temporary, serialized, { flag: 'wx', mode });
      // Creation applies umask. Restore the existing permissions before the
      // rename; a chmod failure leaves the original document untouched.
      chmodSync(temporary, mode);
      beforeWrite(current.key, serialized, false, id);
      renameSync(temporary, target);
      return { status: 'applied' };
    } catch {
      // A completed provider result is not a failed generation. Keep its link,
      // leave unreadable/unsupported storage untouched, and never auto-resubmit.
      return retain('unavailable', '产物已保留，但分镜保存未完成；当前选择未自动替换，请查看后台任务产物');
    } finally { if (temporary) { try { rmSync(temporary, { force: true }); } catch {} } }
  }
  return { capture, record, get, beforeWrite, mergeWrite, finishWrite, apply };
}
