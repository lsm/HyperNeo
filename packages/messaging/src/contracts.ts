import type { ParsedAddress } from './address.ts';
import type { ActorRef, DeliveryRecord, MessageRecord } from './types.ts';

export type ResolvedTarget = {
  targetRef: string;
  address: ParsedAddress;
  actor: ActorRef;
};

export type UnresolvedTarget = {
  targetRef: string;
  address?: ParsedAddress;
  reason: string;
};

export type ResolveTargetsResult = {
  resolved: ResolvedTarget[];
  unresolved: UnresolvedTarget[];
};

export interface ActorResolver {
  resolveTargets(message: MessageRecord): Promise<ResolveTargetsResult>;
}

export type RouteMessageResult = {
  message: MessageRecord;
  deliveries: DeliveryRecord[];
};

export interface MessageRouter {
  routeMessage(message: MessageRecord): Promise<RouteMessageResult>;
}

export type CreateMessageInput = Omit<MessageRecord, 'messageId' | 'createdAt'> & {
  messageId?: string;
  createdAt?: number;
};

export type CreateDeliveryInput = Omit<DeliveryRecord, 'deliveryId' | 'createdAt'> & {
  deliveryId?: string;
  createdAt?: number;
};

export interface MessageStore {
  createMessage(input: CreateMessageInput): Promise<MessageRecord>;
  getMessage(messageId: string): Promise<MessageRecord | undefined>;
  listMessagesByConversation(spaceId: string, conversationId: string): Promise<MessageRecord[]>;
}

export interface DeliveryStore {
  createDelivery(input: CreateDeliveryInput): Promise<DeliveryRecord>;
  getDelivery(deliveryId: string): Promise<DeliveryRecord | undefined>;
  listDeliveriesByMessage(messageId: string): Promise<DeliveryRecord[]>;
  updateDelivery(delivery: DeliveryRecord): Promise<DeliveryRecord>;
}

export interface MessagingStorage extends MessageStore, DeliveryStore {}
