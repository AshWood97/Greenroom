import { useCanvasStore } from './stores/canvas';

type CanvasHooks = { before: (id: string) => Promise<unknown>; refresh: (id: string) => Promise<unknown> };
let hooks: CanvasHooks | null = null;

export function registerManagedCanvasHooks(value: CanvasHooks) {
  hooks = value;
  return () => { if (hooks === value) hooks = null; };
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch('/canvas/api/greenroom/' + path, options);
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error || `画布请求失败（HTTP ${response.status}）`);
  return body.data;
}

export async function runGreenroomNodes(nodeIds: string[], options: { canvasId?: string; submissionId?: string; includeDependencies?: boolean } = {}) {
  const canvasId = options.canvasId || useCanvasStore.getState().activeId;
  if (!canvasId || !hooks) throw new Error('画布尚未加载完成');
  const callbacks = hooks;
  await callbacks.before(canvasId);
  let run = await request('runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    canvasId, nodeIds, includeDependencies: options.includeDependencies ?? false,
    submissionId: options.submissionId || `canvas-ui:${crypto.randomUUID()}`,
  }) });
  for (;;) {
    await callbacks.refresh(canvasId);
    if (!['queued', 'running', 'polling'].includes(run.status)) break;
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    run = await request('runs/' + encodeURIComponent(run.id));
  }
  if (run.status !== 'succeeded') throw new Error(run.summary?.lastError || run.nodes?.flatMap((node: any) => node.attempts).find((attempt: any) => attempt.error)?.error?.message || '画布运行未完成，原任务编号已保留');
  return run;
}
