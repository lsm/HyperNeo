export type NeoSessionMessageKind = 'session' | 'worker-batch';

export interface NeoSessionMessage {
  messageId: string;
  conversationId: string;
  sequence: number;
  fromSession: string;
  fromName: string | null;
  toSession: string;
  toName: string | null;
  text: string;
  createdAt: string;
  kind: NeoSessionMessageKind;
}
