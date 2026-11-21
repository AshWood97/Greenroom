import { z } from 'zod';
import { sceneSchema, createEmptyScene, createMannequinObject, directorPlanSchema, anchorSchema } from './greenroom-director-contract';

// Same document contract as the native director3dNode. No renderer, AI loop or export is run here.
const modelDocumentSchema = z.strictObject({
  version: z.literal(1), scene: sceneSchema,
  plans: z.array(directorPlanSchema.safeExtend({ id: z.string().min(1), instruction: z.string().optional() })),
});
export function readDirectorDocument(value?: unknown) {
  return modelDocumentSchema.parse(value ?? { version: 1, scene: createEmptyScene(), plans: [] });
}
export function addDirectorMannequin(value: unknown) {
  const document = readDirectorDocument(value);
  const object = createMannequinObject(crypto.randomUUID());
  const current = document.scene;
  const mannequins = current.objectList.filter(item => item.objType === 'mannequin');
  object.position.x = mannequins.length ? Math.max(...mannequins.map(item => item.position.x)) + 1 : 0;
  const nextScene = { ...current, objectList: [...current.objectList, object] };
  if (!current.objectList.length) nextScene.sceneConfig = { ...current.sceneConfig,
    camera: { ...current.sceneConfig.camera, position: { x: 3, y: 2.2, z: 4 } },
    controls: { target: { x: 0, y: 0.9, z: 0 } } };
  return { ...document, scene: sceneSchema.parse(nextScene) };
}

export function restoreDirectorInstruction(value: unknown, planId: string) {
  const plans = readDirectorDocument(value).plans.filter(plan => plan.id === planId);
  if (plans.length !== 1) throw new Error(plans.length ? '原方案 ID 不唯一' : '原方案不存在');
  const prompt = plans[0].instruction;
  if (typeof prompt !== 'string') throw new Error('此旧方案未保存输入提示词');
  // Native director3dNode setPrompt: retain whitespace and line order, including empty lines.
  return { prompt, promptModel: prompt ? prompt.split('\n').map(text => [{ type: 'Write' as const, text }]) : [] };
}

const anchorsSchema = z.array(anchorSchema).max(100, '最多记录 100 个关键帧')
  .refine(anchors => new Set(anchors.map(anchor => anchor.id)).size === anchors.length, '关键帧 ID 不能重复');
export type DirectorAnchorEdit =
  | { action: 'set'; anchors: unknown }
  | { action: 'reorder'; anchorIds: string[] }
  | { action: 'remove'; anchorId: string };

/** Sets reference camera parameters only; it does not capture a WebGL view or change any plan. */
export function editDirectorAnchors(current: unknown, input: DirectorAnchorEdit) {
  if (input.action === 'set') return { anchors: anchorsSchema.parse(input.anchors) };
  const anchors = anchorsSchema.parse(current ?? []);
  if (input.action === 'remove') {
    if (!anchors.some(anchor => anchor.id === input.anchorId)) throw new Error('原关键帧不存在');
    return { anchors: anchors.filter(anchor => anchor.id !== input.anchorId) };
  }
  if (input.action === 'reorder') {
    const ids = z.array(z.string().min(1)).max(100).parse(input.anchorIds);
    if (new Set(ids).size !== ids.length) throw new Error('关键帧顺序包含重复 ID');
    const byId = new Map(anchors.map(anchor => [anchor.id, anchor]));
    if (ids.some(id => !byId.has(id))) throw new Error('原关键帧不存在');
    if (ids.length !== anchors.length) throw new Error('重排须包含全部原关键帧 ID');
    return { anchors: ids.map(id => byId.get(id)!) };
  }
  throw new Error('不支持的关键帧操作');
}
