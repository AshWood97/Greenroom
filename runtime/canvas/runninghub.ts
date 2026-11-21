import type { RHTool } from './services/api';
import type { RhSubmitRequest } from './services/generation';

const WORKFLOW_ID = 'greenroom-rh-upscale';

// Greenroom 严选 RunningHub 官方内置应用列表：
// 后续为 T8 画布新增 RH 节点默认加入到此列表（Greenroom 严选），不在 RH 超市混入平台内置节点。
export const GREENROOM_RH_CATEGORY = {
  id: 'greenroom-rh-upscale', name: '视频增强', order: -1, createdAt: 0,
};
export const GREENROOM_RH_TOOLS: RHTool[] = [{
  id: WORKFLOW_ID, webappId: WORKFLOW_ID, rhSite: 'intl', title: 'RH Upscale',
  description: '视频增强、超分与插帧 · MP4 ≤ 100 MB',
  categoryId: GREENROOM_RH_CATEGORY.id, coverUrl: '', order: -1, addedAt: 0,
}];

export function isGreenroomRhApp(id: string): boolean {
  return id === WORKFLOW_ID;
}

export function greenroomRhAppInfo(id: string) {
  return {
    webappId: id, rhSite: 'intl',
    nodeInfoList: [
      { nodeId: 'rh-upscale', fieldName: 'inputVideo', fieldType: 'VIDEO', fieldValue: '',
        description: '输入视频：连接上游视频节点或填写视频地址，MP4 格式，最大 100 MB' },
      { nodeId: 'rh-upscale', fieldName: 'model', fieldType: 'SELECT', fieldValue: 'max',
        options: ['max', 'high', 'medium', 'low'], description: '增强模型' },
      { nodeId: 'rh-upscale', fieldName: 'resolution', fieldType: 'SELECT', fieldValue: '1080p',
        options: ['720p', '1080p', '2k', '4k'], description: '输出分辨率' },
      { nodeId: 'rh-upscale', fieldName: 'outputFps', fieldType: 'SELECT', fieldValue: '1x',
        options: ['1x', '2x', '3x', '4x', '23.976', '24', '25', '29.97', '30', '48', '50',
          '59.94', '60', '72', '90', '96', '120', '144'], description: '输出帧率' },
    ],
  };
}

export async function submitGreenroomRh(req: RhSubmitRequest, headers: HeadersInit): Promise<Response> {
  const fields = Object.fromEntries((req.nodeInfoList || []).map((item) => [item.fieldName, item.fieldValue]));
  const fileUrl = String(fields.inputVideo || '').trim();
  if (!fileUrl) throw new Error('请连接或填写一个 MP4 输入视频');
  const params = { model: String(fields.model || 'max'), resolution: String(fields.resolution || '1080p'),
    outputFps: String(fields.outputFps || '1x') };
  const input = new URL(fileUrl, window.location.origin);
  if (input.origin === window.location.origin || ['blob:', 'data:'].includes(input.protocol)) {
    const response = await fetch(input.href);
    if (!response.ok) throw new Error('输入视频不可读取');
    const video = await response.blob();
    const filename = input.protocol === 'data:' || input.protocol === 'blob:'
      ? 'input.mp4' : decodeURIComponent(input.pathname.split('/').pop() || 'input.mp4');
    if ((!filename.toLowerCase().endsWith('.mp4') && video.type !== 'video/mp4')
        || (video.type.startsWith('video/') && video.type !== 'video/mp4')) {
      throw new Error('RH Upscale 仅支持 MP4 视频');
    }
    if (video.size > 100 * 1024 * 1024) throw new Error('RH Upscale 输入视频不能超过 100 MB');
    const uploadHeaders = new Headers(headers);
    uploadHeaders.set('Content-Type', 'video/mp4');
    uploadHeaders.set('X-File-Name', encodeURIComponent('input.mp4'));
    return fetch('/canvas/api/greenroom/runninghub/submit?' + new URLSearchParams(params), {
      method: 'POST', headers: uploadHeaders,
      body: video,
    });
  }
  return fetch('/canvas/api/greenroom/runninghub/submit', {
    method: 'POST', headers,
    body: JSON.stringify({ fileUrl, ...params }),
  });
}
