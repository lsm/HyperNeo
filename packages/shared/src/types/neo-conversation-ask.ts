import type { SDKUserMessage } from '../sdk/sdk.d.ts';
import type { NeoReplyTo } from './neo-ask.ts';
import type { NeoInputOrigin } from './neo-message.ts';

export const NEO_MESSAGE_STATUSES = [
  'received',
  'queued',
  'working',
  'read',
  'answered',
  'failed',
] as const;
export type NeoConversationMessageStatus = (typeof NEO_MESSAGE_STATUSES)[number];

export interface NeoConversationAskInput {
  readonly conversationId: string;
  readonly requestId: string;
  readonly askOrigin: NeoInputOrigin;
  readonly content: SDKUserMessage['message']['content'];
  readonly replyTo?: NeoReplyTo;
}

export interface NeoConversationAsk extends NeoConversationAskInput {
  readonly sequence: number;
  readonly createdAt: string;
  readonly delivery?: { readonly state: 'failed' };
  readonly messageStatus?: NeoConversationMessageStatus;
}

export type NeoConversationAskAppendResult =
  | { accepted: true; created: boolean; ask: NeoConversationAsk }
  | { accepted: false; reason: 'invalid_ask' | 'ask_conflict' };

export interface NeoConversationImageRef {
  readonly type: 'image_ref';
  readonly imageId: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly thumbnail: { readonly mediaType: string; readonly data: string } | null;
}

export type NeoConversationAskPageItem = Omit<NeoConversationAsk, 'content'> & {
  readonly content: ReadonlyArray<
    Exclude<NeoConversationAsk['content'], string>[number] | NeoConversationImageRef
  >;
};
