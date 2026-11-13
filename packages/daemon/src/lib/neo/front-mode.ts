import { neoDerivedId } from './derived-id.ts';

export const frontSessionId = (conversationId: string) =>
  neoDerivedId(`front-session:${conversationId}`);

export const isPublicationSpeaker = (conversationId: string, sessionId: string, dual: boolean) =>
  sessionId === `neo:${conversationId}` || (dual && sessionId === frontSessionId(conversationId));

export const frontProgressRequest = (ids: string[]) => `front-ack:${[...ids].sort().join(',')}`;

export function frontModeNote(listening = false): string {
  return `Call reply once per human message with its original replyTo ID${listening ? ' and spoken' : ''}: the answer if your reads answer it, otherwise one brief line on what will be done. Every message also goes on to be handled in full. A message that names run_in_background means work is needed. Add details only for more than five sentences or any structured report, list, table or multi-topic update.${listening ? ' While [listening: yes], every reply call includes spoken.' : ''} Other text is never shown or heard; end the turn with exactly "No response requested."`;
}
