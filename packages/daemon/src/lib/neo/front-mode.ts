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
  return `Call reply once per human message with its original replyTo ID${listening ? ' and spoken' : ''}: the answer, or with work_on:true a one-sentence acknowledgment when work is needed; that answer reaches the human by itself. A message that names run_in_background means work_on. Add details only for more than five sentences or any structured report, list, table or multi-topic update.${listening ? ' While [listening: yes], every reply call includes spoken.' : ''} Other text is never shown or heard; end the turn with exactly "No response requested."`;
}
