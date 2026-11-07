import { messageImageAt } from '../../lib/rpc-handlers/message-image-link.ts';
import { capSdkMessage } from '../../lib/rpc-handlers/message-output-cap.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';

class SingleMessageReader extends SDKMessageRepository {
  read(sessionId: string, messageUuid: string, capped = false) {
    if (!this.sessionExists(sessionId)) throw new Error('Session not found');
    const sdkMessage = this.getMessageByUuid(sessionId, messageUuid);
    if (!sdkMessage) throw new Error('Message not found');
    return { sdkMessage: capped ? capSdkMessage(sessionId)(sdkMessage) : sdkMessage };
  }

  image(sessionId: string, messageUuid: string, index: number) {
    return messageImageAt(this.getMessageByUuid(sessionId, messageUuid), index);
  }
}

export const singleMessageReads = defineRepositoryOp(
  'sdk.message.single.read',
  'read',
  SingleMessageReader,
  ['read', 'image'] as const
);
