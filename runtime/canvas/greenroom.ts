import { IMAGE_MODELS, VIDEO_MODELS, LLM_MODELS, setGreenroomDefaultLlm } from './providers/models';
import { CANVAS_NODE_SCHEMA_MANIFEST } from './config/nodeRegistry';
import { useThemeStore } from './stores/theme';

type Model = { id: string; label: string; capabilities: Record<string, unknown>; base_slug?: string; provider_label?: string; catalog_order?: number };
export const greenroomNodeDefaults: Record<string, Record<string, unknown>> = {};

// Input modalities count only when the catalog declares them for real: a non-empty array
// of non-empty strings, and not an explicitly unknown verification status. Anything else
// is not evidence of compatibility, so it returns undefined instead of an empty list that
// every subset check would pass.
function declaredModalities(capabilities?: Record<string, unknown>): string[] | undefined {
  if (!capabilities || capabilities.verification_status === 'unknown') return undefined;
  const declared = capabilities.input_modalities;
  if (!Array.isArray(declared) || !declared.length) return undefined;
  if (!declared.every((value) => typeof value === 'string' && value)) return undefined;
  return declared;
}

// The catalog itself marks StarNet; only that exact provider_label qualifies. The family
// comes solely from a non-empty, equal base_slug. Both sides must carry a real modality
// declaration, and the candidate must include every modality the chosen entry declares.
function starnetSibling(rows: Model[], chosen?: Model): Model | undefined {
  if (!chosen?.base_slug) return undefined;
  const required = declaredModalities(chosen.capabilities);
  if (!required) return undefined;
  return rows.find((row) => {
    if (row.id === chosen.id || row.base_slug !== chosen.base_slug) return false;
    if (row.provider_label !== '星网') return false;
    const declared = declaredModalities(row.capabilities);
    return !!declared && required.every((value) => declared.includes(value));
  });
}

export async function initializeGreenroom() {
  if (!localStorage.getItem('t8-canvas-theme')) useThemeStore.getState().setStyle('tech');
  const style = document.createElement('style');
  style.textContent = `
    .t8-topbar { gap: 8px; overflow-x: auto; min-height: 44px; }
    .t8-topbar > div { flex-shrink: 0; white-space: nowrap; }
    .t8-topbar > div:last-child > .relative { display: none; }
    .t8-topbar h1 { font-size: 13px; }
    @media (max-width: 900px) {
      .t8-topbar > div:first-child > :not(h1):not(.t8-topbar-status-chip) { display: none; }
      .t8-topbar > div:last-child > button span { display: none; }
      .t8-topbar-status-chip { font-size: 0; }
    }
  `;
  document.head.append(style);
  const theme = useThemeStore.getState();
  theme.setCustomUiFont('');
  theme.setUiFontPreset('readable');
  let models: Record<'llm' | 'image' | 'video', Model[]> = { llm: [], image: [], video: [] };
  let error = '';
  try {
    const response = await fetch('/canvas/api/greenroom/settings', { signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || '平台画布设置暂不可用');
    theme.setCustomUiFont(body.data.customUiFont);
    theme.setUiFontPreset(body.data.uiFontPreset);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : '平台画布设置暂不可用';
  }
  try {
    const response = await fetch('/canvas/api/greenroom/models', { signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.error || '平台模型目录暂不可用');
    models = body.data;
  } catch (reason) {
    error = reason instanceof Error ? reason.message : '平台模型目录暂不可用';
  }
  const options = (kind: 'llm' | 'image' | 'video') => models[kind].map((m) => ({ value: m.id, label: m.label }));
  const imageOptions = options('image');
  const videoOptions = options('video');
  const llmModels = models.llm.map((m) => ({ id: m.id, label: m.label, provider: 'llm-direct' as const,
                                         vision: Array.isArray(m.capabilities?.input_modalities)
                                           && m.capabilities.input_modalities.includes('image') }));
  LLM_MODELS.splice(0, LLM_MODELS.length, ...llmModels);
  // The central catalog reorders same-family rows, so the original heuristic must run on
  // the catalog's own order; the StarNet sibling is resolved afterwards from that pick.
  const originalLlmModels = [...models.llm].sort((a, b) => (a.catalog_order ?? 0) - (b.catalog_order ?? 0));
  const defaultLlmModel = originalLlmModels.find((m) => {
    const s = `${m.id} ${m.label || ''}`.toLowerCase();
    return s.includes('1017') && (s.includes('deepseek') || s.includes('flash') || s.includes('ds'));
  }) || originalLlmModels.find((m) => `${m.id} ${m.label || ''}`.toLowerCase().includes('1017'))
     || originalLlmModels.find((m) => {
    const s = `${m.id} ${m.label || ''}`.toLowerCase();
    return (s.includes('deepseek') || s.includes('ds')) && s.includes('flash');
  }) || originalLlmModels[0];
  const defaultLlmId = starnetSibling(models.llm, defaultLlmModel)?.id || defaultLlmModel?.id || '__unconfigured__';
  setGreenroomDefaultLlm(defaultLlmId);
  IMAGE_MODELS.splice(0, IMAGE_MODELS.length, {
    id: 'greenroom-image', apiModel: imageOptions[0]?.value || '__unconfigured__', label: 'GREENROOM 图像', tabLabel: 'GREENROOM',
    description: '平台托管生成',
    provider: 'zhenzhen', paramKind: 'gpt-size', capabilities: ['t2i', 'i2i'],
    apiModelOptions: imageOptions.length ? imageOptions : [{ value: '__unconfigured__', label: '图像模型未开通' }],
    aspectRatios: ['Auto', '1:1', '16:9', '9:16'], defaultAspectRatio: 'Auto',
    sizes: ['1024x1024', '2048x2048', 'auto'], defaultSize: '2048x2048', supportsReference: true, maxReferenceImages: 1,
  });
  VIDEO_MODELS.splice(0, VIDEO_MODELS.length, {
    id: 'greenroom-video', label: 'GREENROOM 视频', description: '平台托管生成', kind: 'grok', provider: 'zhenzhen',
    apiModelOptions: videoOptions.length ? videoOptions : [{ value: '__unconfigured__', label: '视频模型未开通' }],
    ratios: ['16:9', '9:16', '1:1'], defaultRatio: '16:9', supportImages: true, maxRefImages: 1,
    durations: [5, 10], defaultDuration: 5, resolutions: ['720p', '1080p'], defaultResolution: '720p',
  });
  greenroomNodeDefaults.image = { model: 'greenroom-image', apiModel: imageOptions[0]?.value || '__unconfigured__',
                                  aspectRatio: 'Auto', sizeLevel: '2048x2048' };
  greenroomNodeDefaults.video = { mainId: 'greenroom-video', model: videoOptions[0]?.value || '__unconfigured__' };
  greenroomNodeDefaults.llm = { model: defaultLlmId };
  for (const node of CANVAS_NODE_SCHEMA_MANIFEST.types) {
    if (node.type === 'llm') node.generation.defaults.model = defaultLlmId;
    if (node.type === 'image') {
      node.generation.defaults.model = 'greenroom-image';
      node.generation.defaults.apiModel = imageOptions[0]?.value || '__unconfigured__';
    }
    if (node.type === 'video') {
      node.generation.defaults.mainId = 'greenroom-video';
      node.generation.defaults.model = videoOptions[0]?.value || '__unconfigured__';
    }
  }
  if (error || !models.image.length || !models.video.length || !models.llm.length) {
    const banner = document.createElement('div');
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:8px;max-width:85%;padding:8px 14px;border:1px solid #d99c35;border-radius:8px;background:#272117;color:#ffd494;font:12px system-ui';
    const message = document.createElement('span');
    message.textContent = error || '部分生成模型尚未开通，请联系管理员；画布编辑与保存可正常使用。';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭模型提示');
    closeButton.title = '关闭提示';
    closeButton.textContent = '×';
    closeButton.style.cssText = 'flex-shrink:0;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:20px/1 system-ui;cursor:pointer';
    closeButton.addEventListener('click', () => banner.remove());
    banner.append(message, closeButton);
    document.body.append(banner);
  }
}
