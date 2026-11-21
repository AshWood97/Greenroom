export const basePath = process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH || '/plugins/openslop';
export async function catalog() {
  const response = await fetch((process.env.GREENROOM_SELF_URL || 'http://127.0.0.1:18809') + '/api/greenroom/catalog', {cache:'no-store'});
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '无法读取托管模型'); return value;
}
