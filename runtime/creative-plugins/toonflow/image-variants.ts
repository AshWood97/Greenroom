import { z } from 'zod';
import { buildLightingPrompt, readLightingSettings, lightingPresets } from './greenroom-imageLighting';
import { buildMultiAnglePrompt, readMultiAngleSettings } from './greenroom-imageMultiAngle';
import { buildPanoramaPrompt } from './greenroom-imagePanorama';

const angle = z.number().finite().min(-180).max(180);
const color = z.string().regex(/^#[\da-f]{6}$/i);
const lighting = z.strictObject({
  azimuth: angle.optional(), elevation: z.number().finite().min(-90).max(90).optional(),
  brightness: z.number().finite().min(0).max(100).optional(), lightColor: color.optional(),
  rimLight: z.boolean().optional(), rimAzimuth: angle.optional(),
  rimElevation: z.number().finite().min(-90).max(90).optional(),
  rimBrightness: z.number().finite().min(0).max(100).optional(), rimColor: color.optional(),
  preset: z.string().refine(value => !value || lightingPresets.some(item => item.id === value)).optional(),
  smartMode: z.boolean().optional(), smartDesc: z.string().optional(),
});
const multiAngle = z.strictObject({
  azimuth: angle.optional(), elevation: z.number().finite().min(-80).max(80).optional(),
  distance: z.number().finite().min(2).max(10).optional(),
  lens: z.enum(['standard', 'wide']).optional(), viewMode: z.enum(['orbit', 'camera']).optional(),
});
const base = { model_id: z.string().min(1), ratio: z.string().min(1).optional(), size: z.string().min(1).optional() };
const requestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('lighting'), options: lighting }),
  z.strictObject({ ...base, kind: z.literal('multi-angle'), options: multiAngle }),
  z.strictObject({ ...base, kind: z.literal('panorama'), options: z.strictObject({ mode: z.enum(['sphere', 'cylinder']) }) }),
]);
export type ImageVariantRequest = z.infer<typeof requestSchema>;
type ImageModel = { id: string; capabilities?: { verification_status?: unknown; input_modalities?: unknown; aspect_ratios?: unknown; sizes?: unknown } };

/** Only constructs a native draft. Caller validates member file ownership and commits atomically.
 * authorizedModels must be the member's filtered image catalog. Inpainting and rendering are not supported.
 */
export function buildImageVariantDraft(sourceNode: unknown, request: unknown, authorizedModels: ImageModel[]) {
  const source = z.object({ id: z.string().min(1), type: z.literal('remote-imageNode'),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    data: z.object({ label: z.string().optional(), outputs: z.object({ image: z.object({ dataType: z.literal('IMAGE'),
      value: z.object({ url: z.string().min(1), mimeType: z.string().startsWith('image/') }) }) }) }),
  }).parse(sourceNode);
  const input = requestSchema.parse(request);
  const model = authorizedModels.find(item => item.id === input.model_id), caps = model?.capabilities;
  const modalities = caps?.input_modalities;
  if (!model || caps?.verification_status === 'unknown' || !Array.isArray(modalities)
    || !modalities.length || modalities.some(item => typeof item !== 'string' || !item) || !modalities.includes('image')) {
    throw new Error('所选模型未获授权或未明确声明图片输入能力');
  }
  const panoramaRatio = input.kind === 'panorama' ? input.options.mode === 'sphere' ? '2:1' : '4:1' : undefined;
  if (panoramaRatio && input.ratio && input.ratio !== panoramaRatio) throw new Error('全景比例与原生模式不一致');
  const ratio = panoramaRatio ?? input.ratio;
  if (ratio && (!Array.isArray(caps?.aspect_ratios) || !caps.aspect_ratios.includes(ratio))) throw new Error('模型未明确支持所选图片比例');
  if (input.size && (!Array.isArray(caps?.sizes) || !caps.sizes.includes(input.size))) throw new Error('模型未明确支持所选图片尺寸');
  const prompt = input.kind === 'lighting' ? buildLightingPrompt(readLightingSettings(input.options))
    : input.kind === 'multi-angle' ? buildMultiAnglePrompt(readMultiAngleSettings(input.options))
      : buildPanoramaPrompt(input.options.mode);
  const variantLabel = input.kind === 'lighting' ? '打光' : input.kind === 'multi-angle' ? '多角度' : '全景';
  const label = `${source.data.label || '图片'} · ${variantLabel}`;
  const id = crypto.randomUUID();
  return { draft: true as const, generationSubmitted: false as const,
    node: { id, type: 'remote-imageGenerationNode', position: { x: source.position.x + 400, y: source.position.y },
      data: { label, model: JSON.stringify(['greenroom', model.id]), prompt,
        promptModel: prompt.split('\n').map(text => [{ type: 'Write', text }]),
        ...(ratio ? { ratio } : {}), ...(input.size ? { size: input.size } : {}),
        referenceOrder: { in: [encodeURIComponent(JSON.stringify([source.id, 'image']))] } } },
    edge: { id: crypto.randomUUID(), source: source.id, sourceHandle: 'image', target: id, targetHandle: 'in' },
  };
}
