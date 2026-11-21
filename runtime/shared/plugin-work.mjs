import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const terminal = new Set(['succeeded', 'completed', 'done', 'failed', 'cancelled', 'canceled']);
const pending = (job) => !terminal.has(job.status ?? job.state)
  || Boolean(job.localFile && !job.archived)
  || Boolean(job.platformTaskId && job.status === 'succeeded' && job.downloaded === false);
const json = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const directories = (path) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name)) : [];
const rows = (path) => existsSync(path) ? readdirSync(path).filter((name) => name.endsWith('.json')).map((name) => json(join(path, name))) : [];

function sqlite(path, queries) {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try { return queries.some((query) => Boolean(db.prepare(query).get())); }
  finally { db.close(); }
}

function unboundArcReelWork(root, nativePaths) {
  const path = join(root, 'greenroom-jobs.sqlite3');
  if (!existsSync(path)) return false;
  const bindings = new DatabaseSync(path, { readOnly: true });
  const native = [];
  try {
    for (const file of nativePaths.filter(existsSync)) native.push(new DatabaseSync(file, { readOnly: true }));
    const tasks = native.map((database) => database.prepare('SELECT status FROM tasks WHERE task_id=?'));
    return bindings.prepare('SELECT business_id FROM jobs').all().some(({ business_id }) => {
      if (!business_id) return true;
      const task = tasks.map((query) => query.get(business_id)).find(Boolean);
      return !task || !['succeeded', 'failed', 'cancelled'].includes(task.status);
    });
  } finally { bindings.close(); for (const database of native) database.close(); }
}

// These suites have no runtime lifecycle. Their saved project state is the
// inventory of original render addresses, including tasks predating the host
// binding ledger. Missing/unreadable inventory is not evidence of no work.
export function inspectRenderWork(root) {
  try {
    const jobs = [];
    for (const suiteId of ['lemo-opuscar', 'take-one', 'hypit']) {
      const projects = join(root, suiteId, 'projects');
      for (const entry of readdirSync(projects, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const project = JSON.parse(readFileSync(join(projects, entry.name, 'state.json'), 'utf8'));
        if (project.suiteId !== suiteId || project.projectId !== entry.name
          || !project.productions || typeof project.productions !== 'object' || Array.isArray(project.productions)) throw new Error('Unknown render project');
        for (const production of Object.values(project.productions)) {
          if (!Array.isArray(production?.jobs)) throw new Error('Unknown render production');
          for (const job of production.jobs) {
            if (!job || typeof job.kind !== 'string') throw new Error('Unknown render job');
            if (job.kind !== 'render') continue;
            if (job.renderSubmitted !== true) {
              if (job.status === 'prepared') continue;
              throw new Error('Unknown render submission');
            }
            if (typeof job.jobId !== 'string' || !job.jobId) throw new Error('Unknown render address');
            const record = { suiteId, projectId: project.projectId, jobId: job.jobId };
            if (job.status === 'completed' && job.archivedAt && job.outputs?.length === 1
              && typeof job.outputs[0]?.assetId === 'string' && job.outputs[0].assetId) record.assetId = job.outputs[0].assetId;
            jobs.push(record);
          }
        }
      }
    }
    return { known: true, jobs };
  } catch { return { known: false, jobs: [] }; }
}

// Read the same durable records used by each backend's original restore path.
// Missing new-member data is empty; unreadable/schema-unknown data stays busy.
export function inspectPluginWork(id, root) {
  try {
    let busy;
    switch (id) {
      case 't8':
        // The member canvas backend runs and recovers its own durable runs;
        // an interrupted or unreadable run stays busy so the original task is
        // never dropped.
        busy = sqlite(join(root, 'data/t8-projects.sqlite3'), [
          "SELECT 1 FROM runs WHERE status NOT IN ('succeeded','failed','stopped') OR status IS NULL LIMIT 1",
          "SELECT 1 FROM node_runs WHERE status NOT IN ('succeeded','failed','stopped') OR status IS NULL LIMIT 1",
          "SELECT 1 FROM run_attempts WHERE status NOT IN ('succeeded','failed','stopped') OR status IS NULL LIMIT 1",
        ]);
        break;
      case 'huobao':
        busy = sqlite(join(root, 'huobao.sqlite3'), [
          "SELECT 1 FROM sys_task WHERE status NOT IN ('completed','failed','cancelled') LIMIT 1",
          "SELECT 1 FROM video_merges WHERE status NOT IN ('completed','failed','cancelled') LIMIT 1",
        ]);
        break;
      case 'moneyprinter':
        busy = sqlite(join(root, 'moneyprinter.sqlite3'), [
          "SELECT 1 FROM jobs WHERE state != 'done' OR state IS NULL LIMIT 1",
          "SELECT 1 FROM materials m WHERE local_file IS NULL AND task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE m.id LIKE j.id || ':%' AND j.state='done') LIMIT 1",
        ]);
        break;
      case 'toonflow':
        // Canvas conflicts have preserved results and need user resolution, not background work.
        // Match Toonflow's local idle contract; unknown/save_pending still prevent shutdown.
        busy = sqlite(join(root, 'greenroom-jobs.sqlite3'), ["SELECT 1 FROM jobs WHERE state NOT IN ('succeeded','failed','conflict') OR state IS NULL LIMIT 1"]);
        break;
      case 'moyin': {
        const path = join(root, 'moyin-jobs.sqlite3');
        if (!existsSync(path)) { busy = false; break; }
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          db.exec('BEGIN');
          const columns = new Set(db.prepare('PRAGMA table_info(media_jobs)').all().map(column => column.name));
          // An ID suffix locates the expected row, but only its stored parent and kind prove association.
          const linked = columns.has('parent_job_id') && columns.has('kind')
            ? "m.parent_job_id=j.id AND ((j.operation='shot_image' AND m.kind='image') OR (j.operation='shot_video' AND m.kind='video'))"
            : '0';
          const uncertain = db.prepare(`SELECT 1 FROM jobs j JOIN media_jobs m ON m.id=j.id || '-media-0'
            WHERE j.state='failed' AND (m.state IS NULL OR m.state<>'failed')
            AND (j.operation IS NULL OR (j.operation IN ('shot_image','shot_video') AND COALESCE((${linked}),0)=0)) LIMIT 1`).get();
          if (uncertain) return { known: false, busy: true, recover: false };
          const media = db.prepare("SELECT 1 FROM media_jobs WHERE state NOT IN ('succeeded','failed') OR state IS NULL LIMIT 1").get();
          const jobs = db.prepare(`SELECT 1 FROM jobs j LEFT JOIN media_jobs m ON m.id=j.id || '-media-0'
            WHERE j.state IS NULL OR j.state NOT IN ('succeeded','failed')
            OR (j.state='failed' AND j.operation IN ('shot_image','shot_video')
              AND (m.state IS NULL OR m.state<>'failed') AND (${linked})) LIMIT 1`).get();
          const failedParent = columns.has('parent_job_id') && db.prepare(`SELECT 1 FROM jobs j
            JOIN media_jobs m ON m.parent_job_id=j.id WHERE j.state='failed'
            AND (j.operation IS NULL OR j.operation IN ('shot_image','shot_video','generate_image','generate_video','angle_switch'))
            AND (m.state IS NULL OR m.state<>'failed') LIMIT 1`).get();
          busy = Boolean(media || jobs || failedParent);
        } finally { db.close(); }
        break;
      }
      case 'arcreel':
        {
          const paths = [join(root, 'arcreel.db'), join(root, '.arcreel.db')];
          busy = paths.some((path) => sqlite(path, ["SELECT 1 FROM tasks WHERE status NOT IN ('succeeded','failed','cancelled') OR status IS NULL LIMIT 1"]))
            || unboundArcReelWork(root, paths);
        }
        break;
      case 'localminidrama':
        busy = sqlite(join(root, 'localminidrama.sqlite3'), ['async_tasks', 'image_generations', 'video_generations', 'video_merges'].map((table) =>
          `SELECT 1 FROM ${table} WHERE status NOT IN ('completed','failed','cancelled','draft') OR status IS NULL LIMIT 1`));
        break;
      case 'open-ai-canvas':
        busy = sqlite(join(root, 'open_ai_canvas.db'), [
          "SELECT 1 FROM tasks WHERE status NOT IN ('succeeded','failed','cancelled','text_replay') OR status IS NULL OR provider_cancel_status IN ('requested','uncertain') LIMIT 1",
          "SELECT 1 FROM cloud_agent_executions WHERE cleanup_pending=1 OR status NOT IN ('completed','failed','cancelled','waiting_user','waiting_approval') OR status IS NULL LIMIT 1",
          "SELECT 1 FROM agent_memory_settings WHERE last_status IN ('queued','running') LIMIT 1",
          "SELECT 1 FROM upload_reservations WHERE expires_at > datetime('now') LIMIT 1",
        ]);
        break;
      case 'kineo':
        busy = Object.values(json(join(root, 'state.json'), { tasks: {} }).tasks).some(pending);
        break;
      case 'vimax':
        busy = rows(join(root, 'tasks')).some(pending);
        break;
      case 'openslop':
        busy = [...rows(join(root, 'jobs')), ...rows(join(root, 'runs'))].some(pending);
        break;
      case 'drama-skills':
      case 'openmontage':
        busy = directories(join(root, 'projects')).some((project) => Object.values(json(join(project, '.greenroom/state.json'), { tasks: {} }).tasks).some(pending));
        break;
      default:
        return { known: false, busy: true };
    }
    return { known: true, busy };
  } catch (error) { return { known: false, busy: true, ...(id === 'moyin' ? { recover: false } : {}), error: error.message }; }
}
