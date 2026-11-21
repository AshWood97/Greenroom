import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FileProvider } from '@/utils/ai/files';

type TextModel = { capabilities?: { input_modalities?: unknown; verification_status?: unknown } };

export async function readTextReferences(
  directory: string,
  references: unknown,
  model: TextModel | undefined,
  provider: FileProvider,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  // The media reader calls managed leases at runtime; do not create a top-level import cycle.
  const { aiReferenceSchema, readAiReferences } = await import('@/utils/ai');
  const { getDocumentExtension, getReadableFileMimeType, getTextMimeType } = await import('@/lib/documentFormats');
  const { resolveWorkspacePath } = await import('@/utils/workspace/files');
  const parsed = aiReferenceSchema.array().max(32).parse(references);
  for (const item of parsed) {
    signal?.throwIfAborted();
    if (item.dataType === 'STRING') continue;
    if (item.dataType === 'VIDEO') throw new Error('文本模型的视频输入尚未完成托管链路接入，请先提取图片或文本参考');
    if (item.dataType === 'IMAGE') {
      const capabilities = model?.capabilities, modalities = capabilities?.input_modalities;
      if (capabilities?.verification_status === 'unknown' || !Array.isArray(modalities)
        || !modalities.length || modalities.some(value => typeof value !== 'string' || !value)
        || !modalities.includes('image')) throw new Error('所选文本模型尚未明确声明可用的图片输入能力');
    } else {
      const normalized = getReadableFileMimeType(item.value.url, item.value.mimeType);
      // Match readDocument's branch exactly: no parser/cache is entered for plain text.
      const documentExtension = getDocumentExtension(item.value.url)
        ?? (getTextMimeType(item.value.url) ? undefined : getDocumentExtension('', normalized));
      if (documentExtension) throw new Error('当前文件参考仅支持纯文本，PDF、Office、CSV 等文档解析尚未接入');
      if (!getTextMimeType(item.value.url, item.value.mimeType)) throw new Error('不支持此参考文件格式，仅支持可识别的纯文本');
    }
    const name = item.value.url;
    if (isAbsolute(name) || /^[a-z][a-z\d+.-]*:/i.test(name) || name.includes('\\')
      || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('参考文件须使用项目内的相对路径');
    const root = await realpath(directory);
    if (root !== resolve(directory)) throw new Error('参考文件不能经过符号链接');
    const file = await resolveWorkspacePath(root, name);
    if (file.path !== resolve(root, name)) throw new Error('参考文件不能经过符号链接');
  }
  return readAiReferences(directory, parsed, signal, provider);
}
