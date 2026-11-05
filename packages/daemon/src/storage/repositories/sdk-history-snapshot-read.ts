import { capSdkMessage } from '../../lib/rpc-handlers/message-output-cap.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';

class HistorySnapshotReader extends SDKMessageRepository {
  read(sessionId: string, since: number | undefined, requireSession: boolean) {
    if (requireSession && !this.sessionExists(sessionId)) throw new Error('Session not found');
    const { messages, hasMore } = this.getSDKMessages(
      sessionId,
      100,
      undefined,
      since,
      undefined,
      undefined,
      capSdkMessage
    );
    return { sdkMessages: messages, hasMore };
  }
}

export const historySnapshotReads = defineRepositoryOp(
  'sdk.message.snapshot.read',
  'read',
  HistorySnapshotReader,
  ['read'] as const
);
