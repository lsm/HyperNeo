import { neoDerivedId } from './derived-id.ts';

export const frontSessionId = (conversationId: string) =>
  neoDerivedId(`front-session:${conversationId}`);

export function frontModeNote(_conversationId: string, dual: boolean, front: boolean): string {
  return dual
    ? front
      ? '[Dual-model mode] You are Convo. The daemon presents your final reply. Use only reads and neo_send. Hand actions and uncertain facts to Neo with the original human message IDs, then finish with a brief status. Neo publishes its answer through the canonical publication path.'
      : `[Dual-model mode] Human input reaches Convo first. You receive its handoffs and background work. Use the canonical Neo publication and speech tools. Answer each human input once; edit the existing publication for corrections and progress.`
    : '[Single-model mode] Neo receives and answers the human directly. Preserve the Convo session for reuse.';
}
