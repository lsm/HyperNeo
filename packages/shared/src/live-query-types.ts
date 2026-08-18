export interface LiveQuerySubscribeRequest {
  queryName: string;
  params: unknown[];
  subscriptionId: string;
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
