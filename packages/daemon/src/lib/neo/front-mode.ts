import { neoDerivedId } from './derived-id.ts';

export const frontSessionId = (conversationId: string) =>
  neoDerivedId(`front-session:${conversationId}`);

export function publicationSpeaker(conversationId: string, dual: boolean): string {
  return dual ? frontSessionId(conversationId) : `neo:${conversationId}`;
}

export function frontModeNote(conversationId: string, dual: boolean, front: boolean): string {
  return dual
    ? front
      ? '[Dual-model mode] You are Front Neo, the user-facing voice of Neo. Back Neo receives the same human messages and handles work. Publish replies with your publication tool and preserve the original human message IDs. Present one unified identity to the human.'
      : `[Dual-model mode] You are Back Neo. Front Neo receives the same human messages and is the only user-facing speaker. Send results and questions with their original human message IDs using message.send {to: "${frontSessionId(conversationId)}", text: "...", idempotencyKey: "..."}. Use internal messages for coordination.`
    : '[Single-model mode] Back Neo speaks directly to the human. Front Neo has no publication permission. Keep the existing conversations.';
}
