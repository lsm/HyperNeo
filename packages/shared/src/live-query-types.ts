export interface LiveQuerySubscribeRequest {
  queryName: string; // named query key from server registry
  params: unknown[];
  subscriptionId: string; // client-chosen, unique per client connection
}

export interface LiveQuerySubscribeResponse {
  ok: true;
}

export interface LiveQueryUnsubscribeRequest {
  subscriptionId: string;
}

export interface LiveQueryUnsubscribeResponse {
  ok: true;
}

// Server-pushed via router.sendToClient, not broadcast
export interface LiveQuerySnapshotEvent {
  subscriptionId: string;
  rows: unknown[];
  version: number;
  metadata?: Record<string, unknown>;
}

export interface LiveQueryDeltaEvent {
  subscriptionId: string;
  added?: unknown[];
  removed?: unknown[];
  updated?: unknown[];
  version: number;
  metadata?: Record<string, unknown>;
}

export interface LiveQueryErrorEvent {
  subscriptionId: string;
  code: string;
  message: string;
  phase: 'snapshot' | 'delta';
}
