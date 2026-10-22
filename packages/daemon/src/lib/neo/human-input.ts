import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoService } from './service.ts';

type Reads = Pick<NeoService, 'repo' | 'asks' | 'db'>;

export function receivedNeoHumanInput(
  reads: Reads,
  sessionId: string,
  messageId: string
): NeoConversationAsk | null {
  const conversationId = reads.repo.conversationId();
  if (!conversationId || reads.repo.defaultBinding()?.sessionId !== sessionId) return null;
  const ask = reads.asks.find(conversationId, messageId);
  const prompt = reads.db
    .getSDKMessageRepo()
    .getMessageByStatusAndUuid(sessionId, 'consumed', messageId);
  return ask?.askOrigin.sessionId === sessionId &&
    ask.askOrigin.messageId === messageId &&
    prompt?.type === 'user' &&
    prompt.session_id === sessionId &&
    prompt.uuid === messageId &&
    'inputKind' in prompt &&
    prompt.inputKind === 'human'
    ? ask
    : null;
}
