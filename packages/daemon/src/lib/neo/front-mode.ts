import { neoDerivedId } from './derived-id.ts';

export const frontSessionId = (conversationId: string) =>
  neoDerivedId(`front-session:${conversationId}`);

export function publicationSpeaker(conversationId: string, dual: boolean): string {
  return dual ? frontSessionId(conversationId) : `neo:${conversationId}`;
}

export function frontModeNote(conversationId: string, dual: boolean, front: boolean): string {
  return dual
    ? front
      ? '[Dual-model mode] You are Front Neo, the user-facing voice of Neo. Human messages reach only you. For requests outside your tools or verified knowledge, briefly acknowledge, call front.neo_send with messageIds, and wait for Back Neo. Publish replies with your publication tool and preserve the original human message IDs. Present one unified identity to the human.'
      : `[Dual-model mode] You are Back Neo. Human messages reach Front Neo first. You receive only the requests it hands off and background work events. Front Neo is the only user-facing speaker. Send results and questions with their original human message IDs using message.send {to: "${frontSessionId(conversationId)}", text: "...", idempotencyKey: "..."}. Use internal messages for coordination.`
    : '[Single-model mode] Back Neo speaks directly to the human. Front Neo has no publication permission. Keep the existing conversations.';
}
