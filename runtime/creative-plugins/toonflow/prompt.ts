import { createRequire } from 'node:module';
import { getPromptText } from './greenroom-prompt-contract';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

// The caller supplies the same ordered inputs used for media and referenceOrder.
export function resolveVideoPrompt(
  nodeData: { prompt?: string; promptModel?: Parameters<typeof getPromptText>[1] },
  orderedInputs: { source: string; sourceHandle: string; dataType?: string }[],
): string {
  if (!nodeData.promptModel?.length) return nodeData.prompt ?? '';
  const references = orderedInputs.flatMap((item, index) =>
    ['IMAGE', 'VIDEO', 'AUDIO', 'STRING', 'FILE'].includes(item.dataType ?? '')
      ? [{ id: encodeURIComponent(JSON.stringify([item.source, item.sourceHandle])), value: `{{ref ${index + 1}}}` }]
      : []);
  // JSDOM defaults leave script execution and subresource loading disabled.
  const dom = new JSDOM('');
  try {
    return getPromptText(dom.window.document, nodeData.promptModel, referenceId => {
      const value = references.find(reference => reference.id === referenceId)?.value;
      if (value === undefined) throw new Error('提示词引用的素材已失效，请重新选择引用');
      return value;
    });
  } finally {
    dom.window.close();
  }
}
