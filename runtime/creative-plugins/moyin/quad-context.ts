// Adapted from official Moyin director/split-scenes.tsx (7e5c565).
// Copyright (c) 2025 hotflow2024. AGPL-3.0-or-later.
// Pure request preparation only: no generation, uploads, persistence, or result application.
import { buildEmotionDescription } from '@/lib/generation/prompt-builder';
import type { Character, CharacterVariation } from '@/stores/character-library-store';
import type { SplitScene } from '@/stores/director-store';
type ReferenceBucketKind = 'anchor' | 'character' | 'scene' | 'style';
type ReferenceBucket = { kind: ReferenceBucketKind; images: string[] };
type SceneCharacterContext = { characterId: string; name: string; identityNotes: string[]; referenceImages: string[] };
export interface QuadContextInput {
 scene: SplitScene; storyboardConfig: { styleTokens?: string[]; aspectRatio?: string; resolution?: string };
 characters: Character[]; frameType: 'start' | 'end'; variationType: 'angle' | 'composition' | 'moment';
 useCharacterRef?: boolean; model?: string; modelReferenceLimit?: number | null;
}
// Creative selection budgets, not claims about model capability.
const MAX_REFERENCE_IMAGES = 14;
const MAX_NANO_BANANA_REFERENCE_IMAGES = 6;
const NANO_BANANA_IDENTITY_MODELS = new Set([
  'nano-banana-pro',
  'gemini-3-pro-image-preview',
  'nano-banana-2',
  'gemini-3.1-pro-image-preview',
]);
const REFERENCE_BUCKET_PRIORITY: Record<ReferenceBucketKind, number> = {
  anchor: 0,
  character: 1,
  scene: 2,
  style: 3,
};

const normalizeCharacterIdentityText = (value?: string | null, maxLength = 96): string => {
  if (!value) return '';
  const normalized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-*•·]+/, '')
    .replace(/[;,，；。]+$/g, '')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
};

const isNanoBananaProModel = (model?: string | null): boolean => {
  const normalized = (model || '').trim().toLowerCase();
  return NANO_BANANA_IDENTITY_MODELS.has(normalized);
};

const optimizeReferenceImagesForModel = (
  model: string | undefined,
  buckets: ReferenceBucket[],
  limit: number,
): string[] => {
  const orderedBuckets = isNanoBananaProModel(model)
    ? [...buckets].sort((left, right) => REFERENCE_BUCKET_PRIORITY[left.kind] - REFERENCE_BUCKET_PRIORITY[right.kind])
    : buckets;
  const refs: string[] = [];
  const seen = new Set<string>();

  for (const bucket of orderedBuckets) {
    for (const image of bucket.images) {
      if (!image || seen.has(image)) continue;
      seen.add(image);
      refs.push(image);
      if (refs.length >= limit) return refs;
    }
  }

  return refs;
};

const buildReferencePriorityHint = (model: string | undefined, hasCharacterReferences: boolean): string => {
  if (!isNanoBananaProModel(model) || !hasCharacterReferences) return '';
  return [
    'Reference priority:',
    'the earliest character references are canonical identity anchors;',
    'later references are only for scene, lighting, framing, and mood;',
    'later references must never override face-name-body identity.',
  ].join(' ');
};

const buildCharacterIdentityNotes = (
  character: Character,
  selectedVariation?: CharacterVariation,
): string[] => {
  const notes: string[] = [];
  const push = (value?: string | null, maxLength = 96) => {
    const normalized = normalizeCharacterIdentityText(value, maxLength);
    if (!normalized || notes.includes(normalized)) return;
    notes.push(normalized);
  };

  const anchors = character.identityAnchors;
  if (anchors) {
    const boneStructure = [anchors.faceShape, anchors.jawline, anchors.cheekbones].filter(Boolean).join(', ');
    const facialFeatures = [anchors.eyeShape, anchors.eyeDetails, anchors.noseShape, anchors.lipShape].filter(Boolean).join(', ');
    const hairDetails = [anchors.hairStyle, anchors.hairlineDetails].filter(Boolean).join(', ');
    const colorDetails = [
      anchors.colorAnchors?.iris ? `iris ${anchors.colorAnchors.iris}` : '',
      anchors.colorAnchors?.hair ? `hair ${anchors.colorAnchors.hair}` : '',
      anchors.colorAnchors?.skin ? `skin ${anchors.colorAnchors.skin}` : '',
      anchors.colorAnchors?.lips ? `lips ${anchors.colorAnchors.lips}` : '',
    ].filter(Boolean).join(', ');

    if (boneStructure) push(`bone structure ${boneStructure}`);
    if (facialFeatures) push(`facial features ${facialFeatures}`);
    if (anchors.uniqueMarks?.length) push(`unique marks ${anchors.uniqueMarks.slice(0, 2).join(', ')}`);
    if (hairDetails) push(`hair ${hairDetails}`);
    if (colorDetails) push(`color anchors ${colorDetails}`);
    if (anchors.skinTexture) push(`skin texture ${anchors.skinTexture}`);
  }

  if (notes.length < 4) push(character.appearance);
  if (notes.length < 4) push(character.visualTraits);
  if (notes.length < 4) push(character.description);
  if (notes.length < 4) push(character.role);

  if (selectedVariation) {
    const variationPrompt = selectedVariation.visualPromptZh || selectedVariation.visualPrompt || selectedVariation.name;
    push(`current outfit/state ${variationPrompt}`, 84);
  }

  return notes.slice(0, 4);
};

const buildCharacterIdentityBlock = (contexts: SceneCharacterContext[]): string => {
  if (contexts.length === 0) return '';

  const lines = ['Character identity lock:'];
  contexts.forEach((context) => {
    const summary = context.identityNotes.length > 0
      ? context.identityNotes.join('; ')
      : 'use the canonical earliest reference as the exact face/body identity anchor';
    lines.push(`- ${context.name}: ${summary}.`);
  });

  if (contexts.length > 1) {
    lines.push('Do not swap face identity, body identity, speaking ownership, or action ownership between named characters.');
  } else {
    lines.push('The named character must remain the exact same person in every output.');
  }

  return lines.join('\n');
};

const buildSceneCharacterCastLine = (contexts: SceneCharacterContext[]): string => {
  if (contexts.length === 0) return '';

  const names = contexts.map((context) => context.name).join(', ');
  if (contexts.length === 1) {
    return `Exact scene cast: ${names} only. Do not add any other person.`;
  }

  return `Exact scene cast: ${names}. Keep the face-name-body mapping exact for each named character and do not swap who performs or receives the action.`;
};

export function buildQuadContext(input: QuadContextInput) {
 const {scene, storyboardConfig, characters, frameType, variationType, model, useCharacterRef = false} = input;
 const strategyReferenceLimit = isNanoBananaProModel(model) ? MAX_NANO_BANANA_REFERENCE_IMAGES : MAX_REFERENCE_IMAGES;
 const modelReferenceLimit = Number.isSafeInteger(input.modelReferenceLimit) && input.modelReferenceLimit! >= 0 ? input.modelReferenceLimit! : null;
 const selectionReferenceLimit = modelReferenceLimit === null ? strategyReferenceLimit : Math.min(strategyReferenceLimit, modelReferenceLimit);
 if (modelReferenceLimit === 0) throw new Error('当前模型明确不接受参考图，四宫格变体需要原图；请选择支持参考图的模型');
 if (!scene || !storyboardConfig || !Array.isArray(characters)) throw new Error('四宫格场景或配置缺失');
 if (!['start', 'end'].includes(frameType)) throw new Error('无效首尾帧类型');
 if (!['angle', 'composition', 'moment'].includes(variationType)) throw new Error('无效四宫格变体');
 const sourceImage = frameType === 'start' ? (scene.imageDataUrl || scene.imageHttpUrl) : (scene.endFrameImageUrl || scene.endFrameHttpUrl);
 if (typeof sourceImage !== 'string' || !sourceImage.trim()) throw new Error('找不到原图');
 const getSceneCharacterContexts = (characterIds: string[], variationMap?: Record<string,string>): SceneCharacterContext[] => {
    if (!characterIds?.length) return [];



    return characterIds.flatMap((characterId) => {
      const character = characters.find((item) => item.id === characterId);
      if (!character) return [];

      const variationId = variationMap?.[characterId];
      const selectedVariation = variationId
        ? character.variations?.find((variation) => variation.id === variationId)
        : undefined;

      const referenceImages: string[] = [];
      const seen = new Set<string>();
      const pushRef = (value?: string | null) => {
        if (!value || seen.has(value)) return;
        seen.add(value);
        referenceImages.push(value);
      };

      pushRef(character.thumbnailUrl);
      pushRef(selectedVariation?.referenceImage);

      for (const view of character.views || []) {
        pushRef(view.imageBase64 || view.imageUrl);
      }

      for (const image of character.referenceImages || []) {
        pushRef(image);
      }

      for (const image of selectedVariation?.clothingReferenceImages || []) {
        pushRef(image);
      }

      return [{
        characterId,
        name: character.name || 'Unnamed character',
        identityNotes: buildCharacterIdentityNotes(character, selectedVariation),
        referenceImages: referenceImages.slice(0, MAX_REFERENCE_IMAGES),
      }];
    });

 };
 const getCharacterReferenceImages = (characterIds: string[], variationMap?: Record<string,string>): string[] => {
    const contexts = getSceneCharacterContexts(characterIds, variationMap);
    if (contexts.length === 0) return [];

    const refs: string[] = [];
    const seen = new Set<string>();

    const maxDepth = contexts.reduce((depth, context) => Math.max(depth, context.referenceImages.length), 0);

    for (let index = 0; index < maxDepth; index += 1) {
      for (const context of contexts) {
        const image = context.referenceImages[index];
        if (!image || seen.has(image)) continue;
        seen.add(image);
        refs.push(image);
        if (refs.length >= MAX_REFERENCE_IMAGES) {
          return refs;
        }
      }
    }

    return refs.slice(0, MAX_REFERENCE_IMAGES);

 };
 const getSceneIdentityLockLines = (scene: SplitScene, model?: string, hasCharacterRefs?: boolean): string[] => {
    const contexts = getSceneCharacterContexts(scene.characterIds || [], scene.characterVariationMap);
    if (contexts.length === 0) return [];

    const lines: string[] = [];
    const castLine = buildSceneCharacterCastLine(contexts);
    const resolvedHasCharacterRefs = hasCharacterRefs ?? contexts.some((context) => context.referenceImages.length > 0);

    if (castLine) {
      lines.push(castLine);
    }

    const identityBlock = buildCharacterIdentityBlock(contexts);
    if (identityBlock) {
      lines.push(...identityBlock.split('\n'));
    }

    const priorityHint = buildReferencePriorityHint(model, resolvedHasCharacterRefs);
    if (priorityHint) {
      lines.push(priorityHint);
    }

    return lines;

 };
      // Build variation labels based on type
      const variationLabels = variationType === 'angle'
        ? ['正面偏左', '正面偏右', '侧面特写', '全景俯瞰']
        : variationType === 'composition'
          ? ['全身远景', '半身中景', '面部特写', '环境交代']
          : ['动作起始', '动作过程', '动作高潮', '动作结束'];

      const variationPrompts = variationType === 'angle'
        ? ['slight left angle view', 'slight right angle view', 'side profile close-up', 'wide aerial overview']
        : variationType === 'composition'
          ? ['full body wide shot', 'medium shot waist up', 'close-up face', 'establishing shot with environment']
          : ['action beginning', 'action in progress', 'action climax', 'action ending'];

      // Build base prompt from scene
      const basePrompt = scene.imagePromptZh?.trim() || scene.imagePrompt?.trim() || scene.videoPromptZh?.trim() || scene.videoPrompt?.trim() || '';
      const styleTokens = storyboardConfig.styleTokens || [];
      const aspect = storyboardConfig.aspectRatio || '9:16';
      const sceneCharacterContexts = getSceneCharacterContexts(scene.characterIds || [], scene.characterVariationMap);
      const sceneCharacterRefs = useCharacterRef
        ? getCharacterReferenceImages(scene.characterIds || [], scene.characterVariationMap)
        : [];
      const hasCharacterRefs = sceneCharacterContexts.some((context) => context.referenceImages.length > 0);

      // === 人物数量约束 ===
      const charCount = scene.characterIds?.length || 0;
      let charCountPhrase = '';

      if (!useCharacterRef) {
        // 方案A (默认): 信任原图，移除干扰
        charCountPhrase = 'Keep the EXACT same number of characters and their positions as the reference image. Do NOT add or remove characters. Maintain the original character composition.';
      } else {
        // 方案B (勾选): 使用角色库参考，保留硬性人数限制
        charCountPhrase = charCount === 0
          ? 'NO human figures in any panel, empty scene or environment only.'
          : charCount === 1
            ? 'EXACTLY ONE person in each panel, single character only, do NOT duplicate the character.'
            : `EXACTLY ${charCount} distinct people in each panel, no more no less, each person appears only ONCE.`;
      }

      // === 竖屏构图约束（与九宫格一致） ===
      const verticalConstraint = aspect === '9:16' ? 'vertical composition, tighter framing, avoid letterboxing, ' : '';

      // === 动作描述（对时刻变体重要） ===
      const actionDesc = scene.actionSummary?.trim() || '';
      const actionContext = (variationType === 'moment' && actionDesc)
        ? `Action sequence context: ${actionDesc}. `
        : '';

      // === 情绪氛围（保持一致性） ===
      const emotionDesc = buildEmotionDescription(scene.emotionTags || []);
      const moodContext = emotionDesc ? `Mood across all panels: ${emotionDesc} ` : '';

      // === 场景上下文 ===
      const sceneContext = [scene.sceneName, scene.sceneLocation].filter(Boolean).join(' - ');
      const settingContext = sceneContext ? `Setting: ${sceneContext}. ` : '';

      // === 风格键字组 ===
      const styleStr = styleTokens.length > 0 ? `Artistic style consistent: ${styleTokens.join(', ')}. ` : '';

      // Build 2x2 grid prompt
      const gridPromptParts: string[] = [];
      gridPromptParts.push('Generate a 2x2 grid image with 4 panels, each panel separated by thin white lines.');
      gridPromptParts.push('Layout: 2 rows, 2 columns, reading order left-to-right, top-to-bottom.');

      // 每个面板的描述（包含人物数量约束）
      variationPrompts.forEach((v, idx) => {
        const row = Math.floor(idx / 2) + 1;
        const col = (idx % 2) + 1;
        gridPromptParts.push(`Panel [row ${row}, col ${col}]: ${verticalConstraint}${charCountPhrase} ${basePrompt}, ${v}`);
      });

      // 全局约束
      if (settingContext) gridPromptParts.push(settingContext);
      if (actionContext) gridPromptParts.push(actionContext);
      if (moodContext) gridPromptParts.push(moodContext);
      if (styleStr) gridPromptParts.push(styleStr);

      // === 一致性键字组（与 buildAnchorPhrase 一致） ===
      gridPromptParts.push('Keep character appearance, wardrobe and facial features consistent across all 4 panels.');
      gridPromptParts.push('Keep lighting and color grading consistent across all 4 panels.');
      gridPromptParts.push('IMPORTANT: NO TEXT, NO WORDS, NO LETTERS, NO CAPTIONS, NO SPEECH BUBBLES, NO DIALOGUE BOXES, NO SUBTITLES, NO WRITING of any kind in any panel.');

      const gridPrompt = [gridPromptParts.join(' '), getSceneIdentityLockLines(scene, model, hasCharacterRefs).join('\n')].filter(Boolean).join('\n\n');


      const optimizedRefs = optimizeReferenceImagesForModel(model, [
        { kind: 'anchor', images: [sourceImage] },
        { kind: 'character', images: sceneCharacterRefs },
        { kind: 'scene', images: scene.sceneReferenceImage ? [scene.sceneReferenceImage] : [] },
      ], selectionReferenceLimit);

 return { model, strategyReferenceLimit, modelReferenceLimit, modelReferenceLimitStatus: modelReferenceLimit === null ? 'unknown' : 'verified', selectionReferenceLimit, prompt: gridPrompt, referenceImages: optimizedRefs, originalImage: sourceImage,
 variationType, variationTypeLabel: variationType === 'angle' ? '视角变体' : variationType === 'composition' ? '构图变体' : '时刻变体',
 variationLabels, aspectRatio: aspect, resolution: storyboardConfig.resolution || '2K' };
}
