import { neoDerivedId } from './derived-id.ts';

export const frontSessionId = (conversationId: string) =>
  neoDerivedId(`front-session:${conversationId}`);

export const isPublicationSpeaker = (conversationId: string, sessionId: string, dual: boolean) =>
  sessionId === `neo:${conversationId}` || (dual && sessionId === frontSessionId(conversationId));

export const frontProgressRequest = (ids: string[]) => `front-ack:${[...ids].sort().join(',')}`;

export const frontProgressId = (conversationId: string, ids: string[]) =>
  neoDerivedId(
    JSON.stringify([
      'neo.publication.publish',
      frontSessionId(conversationId),
      frontProgressRequest(ids),
    ])
  );

export function frontModeNote(listening = false): string {
  return `Call reply_short first with progress:true${listening ? ', spoken' : ''} and the original replyTo IDs for a brief acknowledgment, then work_on when work is needed; its answer reaches the human by itself. A message that names run_in_background means work_on. Use reply_short for at most five short sentences in one paragraph. Use reply_detailed for more than five sentences or any structured report, list, table or multi-topic update, with summary and additional details.${listening ? ' While [listening: yes], every reply_short and reply_detailed call includes spoken.' : ''} Other text is never shown or heard; end the turn with exactly "No response requested."`;
}
