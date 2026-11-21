import { z } from 'zod';
import { apiJson } from '@/lib/clients/http';
import { ElementTypeSchema } from '@/lib/canvas/types';
import { ASSET_CONNECTOR_TYPES, AssetResultSchema } from '@/lib/connectors/types';
import { GenerationInputsSchema } from '@/lib/generation/inputs';
import type { CommittedVersion, ElementVersion } from '@/lib/generation/versions';
import type { ElementVersionStorage } from '@/lib/generation/history';
const row = z.object({ elementId: z.string(), createdAt: z.string(), connectorType: z.enum(ASSET_CONNECTOR_TYPES),
  elementType: ElementTypeSchema.optional(), inputs: GenerationInputsSchema, result: AssetResultSchema, pinned: z.boolean() });
export const parseElementVersions = (rows: unknown) => z.array(row).parse(rows ?? []);
export const fetchElementVersions = (projectId: string, elementId: string) => apiJson<ElementVersion[]>('/api/greenroom/projects/' + projectId + '/history/' + elementId);
export const saveElementVersion = (projectId: string, version: CommittedVersion) => apiJson<ElementVersion>('/api/greenroom/projects/' + projectId + '/history/' + version.elementId, { method: 'POST', body: version });
export const elementHistoryStorage = (projectId: string): ElementVersionStorage => ({ read: (id) => fetchElementVersions(projectId, id), write: (version) => saveElementVersion(projectId, version) });
