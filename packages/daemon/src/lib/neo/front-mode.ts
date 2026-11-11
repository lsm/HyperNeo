import { neoDerivedId } from './derived-id.ts';

export const frontSessionId = (conversationId: string) =>
  neoDerivedId(`front-session:${conversationId}`);

export const publicationSpeaker = (conversationId: string, dual: boolean) =>
  dual ? frontSessionId(conversationId) : `neo:${conversationId}`;

export const frontProgressRequest = (ids: string[]) => `front-ack:${[...ids].sort().join(',')}`;

export const frontProgressId = (conversationId: string, ids: string[]) =>
  neoDerivedId(
    JSON.stringify([
      'neo.publication.publish',
      frontSessionId(conversationId),
      frontProgressRequest(ids),
    ])
  );

export function frontModeNote(_conversationId: string, dual: boolean, front: boolean): string {
  return dual
    ? front
      ? '[Dual-model mode] You are Convo. Only you publish to the human. Call reply_short first with progress:true and the original replyTo IDs for a brief acknowledgment, then neo_send when work is needed. Use reply_short for a brief final answer or reply_detailed for a substantial result with summary and details. Plain assistant text stays internal.'
      : `[Dual-model mode] Human input reaches Convo first. You receive its handoffs and background work. Convo is the sole speaker. Send results and their original human IDs to Convo with message.send. Your publication and speech tools are disabled in this mode.`
    : '[Single-model mode] Neo receives and answers the human directly. Preserve the Convo session for reuse.';
}
