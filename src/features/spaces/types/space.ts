export type AssetType = 'document' | 'code' | 'prompt' | 'workflow' | 'design' | 'image' | 'video' | 'audio';
export type AssetSource = 'manual' | 'deepseek_harness' | 'asset_service';

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  resultSummary: string;
}

export interface AssetGenerationMeta {
  model: string;
  prompt: string;
  toolCalls?: ToolCallRecord[];
  reasoningTimeMs?: number;
  thinkingContent?: string;
  /** true 表示内容为演示模式模拟数据，未调用真实模型 */
  demo?: boolean;
}

export interface MediaMeta {
  storageAssetId?: string; // asset-service ast_... ID
  uploadId?: string;
  fileUrl?: string; // 会话鉴权的稳定媒体路由
  thumbnailUrl?: string; // WebP 缩略图 URL
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256?: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

export interface Asset {
  id: string;
  title: string;
  description: string;
  type: AssetType;
  content: string;
  ownerId: string;
  ownerName: string;
  ownerRole: string;
  avatarInitials: string;
  avatarBgColor: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  source: AssetSource;
  generationMeta?: AssetGenerationMeta;
  mediaMeta?: MediaMeta;
}

export interface AssetFilter {
  type?: AssetType | 'all';
  search?: string;
  ownerId?: string;
}

export interface SpaceStats {
  myTotal: number;
  spaceTotal: number;
}
