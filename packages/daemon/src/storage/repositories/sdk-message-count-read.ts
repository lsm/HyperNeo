import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';

class MessageCountReader extends SDKMessageRepository {
  count(sessionId: string, requireSession: boolean): number {
    if (requireSession && !this.sessionExists(sessionId)) throw new Error('Session not found');
    return this.getSDKMessageCount(sessionId);
  }
}

export const messageCountReads = defineRepositoryOp(
  'sdk.message.count.read',
  'read',
  MessageCountReader,
  ['count'] as const
);
