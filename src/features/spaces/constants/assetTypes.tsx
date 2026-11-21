import { ReactNode } from 'react';
import {
  Image as ImageIcon,
  Film,
  Music,
  Sparkles,
  Code,
  Workflow,
  Layers,
  FileText,
} from 'lucide-react';
import { AssetType } from '../types/space';

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  prompt: '提示词',
  document: '方案',
  code: '代码',
  workflow: '工作流',
  design: '设计',
};

export const ASSET_TYPE_ORDER: AssetType[] = [
  'image',
  'video',
  'audio',
  'prompt',
  'document',
  'code',
  'workflow',
  'design',
];

export const getTypeLabel = (type: AssetType): string =>
  ASSET_TYPE_LABELS[type] || '通用资产';

export const getTypeIcon = (type: AssetType): ReactNode => {
  switch (type) {
    case 'image':
      return <ImageIcon size={12} />;
    case 'video':
      return <Film size={12} />;
    case 'audio':
      return <Music size={12} />;
    case 'prompt':
      return <Sparkles size={12} />;
    case 'code':
      return <Code size={12} />;
    case 'workflow':
      return <Workflow size={12} />;
    case 'design':
      return <Layers size={12} />;
    case 'document':
    default:
      return <FileText size={12} />;
  }
};
