// Managed reference-image reinterpretation, not the RunningHub application.
import { generateAnglePrompt, HORIZONTAL_DIRECTIONS, ELEVATION_ANGLES, SHOT_SIZES,
  type HorizontalDirection, type ElevationAngle, type ShotSize } from '@/lib/ai/runninghub-angles';

export type ManagedAngleInput = {
  referenceImage: string; direction: HorizontalDirection; elevation: ElevationAngle; shotSize: ShotSize;
  model?: string; onProgress?: (progress: number, status: string) => void;
};
export function angleImageOptions(input: ManagedAngleInput) {
  if (typeof input.referenceImage !== 'string' || !input.referenceImage.trim()) throw new Error('找不到原图');
  if (!HORIZONTAL_DIRECTIONS.some(item => item.id === input.direction)
    || !ELEVATION_ANGLES.some(item => item.id === input.elevation)
    || !SHOT_SIZES.some(item => item.id === input.shotSize)) throw new Error('无效的视角参数');
  return { prompt: generateAnglePrompt(input.direction, input.elevation, input.shotSize),
    referenceImages: [input.referenceImage], ...(input.model ? { model: input.model } : {}) };
}
export async function generateAngleSwitch(input: ManagedAngleInput): Promise<string> {
  angleImageOptions(input);
  input.onProgress?.(0, 'SUBMITTING');
  const result = await (globalThis as any).greenroomBusiness('angle_switch', {
    referenceImage: input.referenceImage, direction: input.direction, elevation: input.elevation,
    shotSize: input.shotSize, ...(input.model ? { model: input.model } : {}),
  });
  if (typeof result?.url !== 'string' || !result.url) throw new Error('托管视角任务未返回图片');
  input.onProgress?.(100, 'SUCCESS');
  return result.url;
}
