import type { StoryboardFrame } from '@/core/storyboard/types/storyboard';

// Task SSE refreshes the page. Keep only this route's view in the URL, without
// notifying the router/loader and rehydrating unsaved editor fields on each click.
function editorUrl(projectId?: string): URL | null {
  if (!projectId || typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  return url.pathname === `/plugins/kineo/project/edit/${encodeURIComponent(projectId)}` ? url : null;
}
export function editorFrameId(projectId?: string): string | undefined {
  return editorUrl(projectId)?.searchParams.get('frameId') || undefined;
}
export function rememberEditorView(projectId: string | undefined, view: {frameId?: string | null; step?: number}) {
  const url = editorUrl(projectId);
  if (!url) return;
  if ('frameId' in view) {
    if (view.frameId) url.searchParams.set('frameId', view.frameId);
    else url.searchParams.delete('frameId');
  }
  if (view.step !== undefined && Number.isInteger(view.step) && view.step >= 0 && view.step <= 3) {
    url.searchParams.set('step', String(view.step));
  }
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}

// The native parser returns episodes/scenes/shots; the editor consumes flat frames.
// Retain already generated media by the original shot ID, never by array position.
export function editorFrames(input: any, previous: any[] = []): StoryboardFrame[] {
  if (!Array.isArray(input)) return [];
  const retained = new Map(previous.filter(row => row && typeof row.id === 'string').map(row => [row.id, row]));
  const result: any[] = [], ids = new Set<string>();
  const visit = (rows: any[]) => {
    for (const row of rows) {
      if (Array.isArray(row?.scenes)) { visit(row.scenes); continue; }
      if (Array.isArray(row?.shots)) { visit(row.shots); continue; }
      if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('分镜缺少唯一原始编号');
      ids.add(row.id);
      const old = retained.get(row.id) || {};
      result.push({...old,...row,id:row.id,title:row.title ?? old.title ?? row.id,
        sceneDescription:row.sceneDescription ?? row.prompt ?? row.description ?? old.sceneDescription ?? '',
        composition:row.composition ?? old.composition ?? '中心构图',cameraType:row.cameraType ?? old.cameraType ?? 'medium',
        dialogue:row.dialogue ?? old.dialogue ?? '',duration:row.duration ?? row.duration_seconds ?? old.duration ?? 3,
        imageUrl:row.imageUrl !== undefined ? row.imageUrl : row.image_url ?? old.imageUrl,
        videoUrl:row.videoUrl !== undefined ? row.videoUrl : row.video_url ?? old.videoUrl,
        audioUrl:row.audioUrl !== undefined ? row.audioUrl : row.audio_url ?? old.audioUrl});
    }
  };
  visit(input);
  return result;
}
