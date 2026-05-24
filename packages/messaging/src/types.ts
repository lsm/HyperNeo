export type ActorKind = 'human' | 'session' | 'agent' | 'worker' | 'system';

export type ActorStatus = 'active' | 'inactive' | 'archived' | 'deleted';

export type ActorRef = {
  actorId: string;
  kind: ActorKind;
  spaceId: string;
  handle?: string;
  roles?: string[];
  status: ActorStatus;
};

export type MessageKind = 'message' | 'system';

export type MessageAttachmentKind = 'image' | 'file' | 'url';

export type MessageAttachment = {
  id?: string;
  type: MessageAttachmentKind;
  mimeType?: string;
  name?: string;
  url?: string;
  storageKey?: string;
};

export type MessageRecord = {
  messageId: string;
  spaceId: string;
  senderActorId: string;
  targets: string[];
  body: string;
  kind: MessageKind;
  workflowRunId?: string;
  taskId?: string;
  conversationId?: string;
  replyToMessageId?: string;
  attachments?: MessageAttachment[];
  data?: Record<string, unknown>;
  idempotencyKey?: string;
  createdAt: number;
};

export type DeliveryState = 'queued' | 'delivered' | 'failed' | 'expired' | 'skipped';

export type DeliveryRecord = {
  deliveryId: string;
  messageId: string;
  targetActorId?: string;
  targetRef: string;
  state: DeliveryState;
  attemptCount: number;
  maxAttempts: number;
  createdAt: number;
  expiresAt?: number;
  lastError?: string;
  deliveredSessionId?: string;
  deliveredAt?: number;
};
