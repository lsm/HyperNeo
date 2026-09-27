export interface NeoConcern {
  id: string;
  title: string;
  summary: string;
  context: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface NeoBinding {
  sessionId: string;
  concernId: string | null;
  kind: 'neo' | 'concern' | 'worker';
}

export interface NeoWork {
  id: string;
  requestKey: string;
  concernId: string | null;
  originSessionId: string;
  title: string;
  instruction: string;
  sessionId: string | null;
  status: 'proposed' | 'queued' | 'reported' | 'failed' | 'cancelled';
  report: string | null;
  createdAt: number;
  updatedAt: number;
}
