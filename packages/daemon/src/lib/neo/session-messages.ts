import type { SessionSent } from '../messaging/message-send.ts';
import type { NeoSessionMessageDraft } from '../../storage/repositories/neo-session-message-repository.ts';

export function planNeoSessionMessage(
  sent: SessionSent,
  root: { sessionId: string; conversationId: string } | null,
  title: (sessionId: string) => string | null
): NeoSessionMessageDraft | null {
  if (!root || (sent.fromSession !== root.sessionId && sent.toSession !== root.sessionId))
    return null;
  return {
    conversationId: root.conversationId,
    messageId: sent.messageId,
    fromSession: sent.fromSession,
    fromName: title(sent.fromSession),
    toSession: sent.toSession,
    toName: title(sent.toSession),
    text: sent.text,
    createdAt: new Date(sent.at).toISOString(),
  };
}
