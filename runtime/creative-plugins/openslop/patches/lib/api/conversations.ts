import { randomUUID } from 'node:crypto';
import { listRows, readRow, writeRow } from '@/lib/greenroom/store';
import { parseSloppyMessages, settleUnansweredCalls } from '@/lib/agent/messages';
import type { SloppyMessage } from '@/lib/agent/types';
export async function findConversation(projectId: string, _userId: string) { return (await listRows('conversations')).find((row) => row.projectId === projectId)?.id ?? null; }
export async function findOrCreateConversation(projectId: string, userId: string) {
  const found = await findConversation(projectId, userId); if (found) return found;
  const id = randomUUID(); await writeRow('conversations', id, { id, projectId }); return id;
}
export async function listConversationMessages(id: string): Promise<SloppyMessage[]> { return parseSloppyMessages((await listRows('messages')).filter((row) => row.conversationId === id).sort((a, b) => a.sequence - b.sequence).map((row) => row.message)); }
export async function saveConversationMessage(id: string, message: SloppyMessage) {
  const key = id + '.' + message.id, old = await readRow('messages', key);
  await writeRow('messages', key, { conversationId: id, sequence: old?.sequence ?? Date.now(), message });
}
export async function loadTranscript(projectId: string, userId: string) { const id = await findConversation(projectId, userId); return id ? settleUnansweredCalls(await listConversationMessages(id)) : []; }
