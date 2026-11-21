import { Asset, AssetFilter, SpaceStats } from '../types/space';

const PERSONAL_PATH = '/api/spaces/personal';
const PUBLIC_PATH = '/api/spaces/public';
const ASSETS_PATH = '/api/spaces/assets';
const STATS_PATH = '/api/spaces/stats';

interface AssetResponse {
  asset?: Asset;
  assets?: Asset[];
  success?: boolean;
  message?: string;
  detail?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { detail?: string };
  if (!response.ok) {
    throw new Error(body.detail || '空间服务请求失败');
  }
  return body;
}

function withQuery(path: string, filter?: AssetFilter): string {
  const params = new URLSearchParams();
  if (filter?.type && filter.type !== 'all') params.set('type', filter.type);
  if (filter?.search?.trim()) params.set('search', filter.search.trim());
  if (filter?.ownerId && filter.ownerId !== 'all') params.set('ownerId', filter.ownerId);
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

class SpaceService {
  public async getPersonalAssets(userId: string, filter?: AssetFilter): Promise<Asset[]> {
    const body = await request<AssetResponse>(withQuery(PERSONAL_PATH, filter));
    return (body.assets || []).filter((asset) => asset.ownerId === userId);
  }

  public async getSharedAssets(filter?: AssetFilter): Promise<Asset[]> {
    const body = await request<AssetResponse>(withQuery(PUBLIC_PATH, filter));
    return body.assets || [];
  }

  public async createAsset(
    data: Omit<Asset, 'id' | 'createdAt' | 'updatedAt' | 'ownerId' | 'ownerName' | 'ownerRole' | 'avatarInitials' | 'avatarBgColor'>
  ): Promise<Asset> {
    const body = await request<AssetResponse>(ASSETS_PATH, {
      method: 'POST',
      body: JSON.stringify({
        title: data.title,
        description: data.description,
        type: data.type,
        content: data.content,
        source: data.source,
        generationMeta: data.generationMeta,
        mediaMeta: data.mediaMeta,
      }),
    });
    if (!body.asset) throw new Error('空间服务未返回资产');
    return body.asset;
  }

  public async deleteAsset(assetId: string): Promise<{ success: boolean; message: string }> {
    try {
      const body = await request<AssetResponse>(`${ASSETS_PATH}/${encodeURIComponent(assetId)}`, {
        method: 'DELETE',
      });
      return { success: true, message: body.message || '资产已删除' };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : '删除失败' };
    }
  }

  public async getStats(userId: string): Promise<SpaceStats> {
    if (!userId) {
      throw new Error('缺少当前成员');
    }
    return request<SpaceStats>(STATS_PATH);
  }
}

export const spaceService = new SpaceService();
