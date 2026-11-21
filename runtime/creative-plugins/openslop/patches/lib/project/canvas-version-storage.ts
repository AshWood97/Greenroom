import { apiJson } from '@/lib/clients/http';
import type { CanvasVersionStorage } from './canvas-history';
import { parseSavedProject } from './saved-project';
export function canvasVersionStorage(projectId: string): CanvasVersionStorage {
  const base = '/api/greenroom/projects/' + projectId + '/versions';
  return {
    list: () => apiJson(base),
    read: async (id) => parseSavedProject(await apiJson(base + '/' + id)),
    create: (content) => apiJson(base, { method: 'POST', body: content }),
    update: (id, content) => apiJson(base + '/' + id, { method: 'PUT', body: content }),
  };
}
