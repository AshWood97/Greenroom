import { z } from 'zod';
import { apiJson } from '@/lib/clients/http';
import type { ProjectMeta } from './project-document';
import type { SavedProject } from './saved-project';
export const ProjectRowSchema = z.object({ id: z.string(), name: z.string(), thumbnail_url: z.string().nullable(), updated_at: z.string() });
export type ProjectRow = z.infer<typeof ProjectRowSchema>;
export const PROJECT_ROW_COLUMNS = 'id,name,thumbnail_url,updated_at';
export type SaveProjectInput = SavedProject & ProjectMeta;
export const createProject = () => apiJson<ProjectRow>('/api/greenroom/projects', { method: 'POST', body: {} });
export async function deleteProject(id: string) { await apiJson('/api/greenroom/projects/' + id, { method: 'DELETE' }); }
export async function saveProject(id: string, input: SaveProjectInput) { await apiJson('/api/greenroom/projects/' + id, { method: 'PUT', body: input }); }
