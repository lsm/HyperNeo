import type { SDKUserMessage } from '../sdk/sdk.ts';
import type { NeoInputOrigin } from './neo-message.ts';

export interface NeoConversationAskInput {
  readonly conversationId: string;
  readonly requestId: string;
  readonly askOrigin: NeoInputOrigin;
  readonly content: SDKUserMessage['message']['content'];
}

export interface NeoConversationAsk extends NeoConversationAskInput {
  readonly sequence: number;
  readonly createdAt: string;
  readonly delivery?: { readonly state: 'failed' };
}

export type NeoConversationAskAppendResult =
  | { accepted: true; created: boolean; ask: NeoConversationAsk }
  | { accepted: false; reason: 'invalid_ask' | 'ask_conflict' };
