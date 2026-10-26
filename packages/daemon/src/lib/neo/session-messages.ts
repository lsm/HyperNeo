import { parseRemoteAddress } from '../mailbox/address.ts';
import type { SessionSent } from '../messaging/message-send.ts';
import type { NeoSessionMessageDraft } from '../../storage/repositories/neo-session-message-repository.ts';

export function planNeoSessionMessage(
  sent: SessionSent,
  root: { sessionId: string; conversationId: string } | null,
  title: (sessionId: string) => string | null
): NeoSessionMessageDraft | null {
  if (!root || (sent.fromSession !== root.sessionId && sent.toSession !== root.sessionId))
    return null;
  const name = (sessionId: string) => {
    const remote = parseRemoteAddress(sessionId);
    return remote ? `${remote.sessionId} @ ${remote.daemonId}` : title(sessionId);
  };
  return {
    conversationId: root.conversationId,
    messageId: sent.messageId,
    fromSession: sent.fromSession,
    fromName: name(sent.fromSession),
    toSession: sent.toSession,
    toName: name(sent.toSession),
    text: sent.text,
    createdAt: new Date(sent.at).toISOString(),
    kind: 'session',
  };
}
