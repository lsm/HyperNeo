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

export interface NeoConsultation {
  id: string;
  requestKey: string;
  concernId: string;
  originSessionId: string;
  originMessageId: string | null;
  sessionId: string;
  question: string;
  status: 'pending' | 'reported' | 'failed';
  answer: string | null;
  createdAt: number;
}

export interface NeoWork {
  id: string;
  requestKey: string;
  concernId: string | null;
  originSessionId: string;
  originMessageId: string | null;
  title: string;
  instruction: string;
  targetSessionId?: string | null;
  sessionId: string | null;
  status: 'proposed' | 'queued' | 'reported' | 'failed' | 'cancelled';
  report: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NeoConsultationWaiter = Omit<
  NeoConsultation,
  'status' | 'answer' | 'originMessageId'
> & {
  originMessageId: string;
  status: 'queued' | 'admitted' | 'cancelled';
};
