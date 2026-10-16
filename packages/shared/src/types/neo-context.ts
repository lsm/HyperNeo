export interface NeoProject {
  id: string;
  parentId?: string | null;
  epicUrl?: string | null;
  workspaceAliases?: string[];
  repository?: string;
  folders?: { machine: string; folder: string }[];
  title: string;
  summary: string;
  context: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface NeoBinding {
  sessionId: string;
  projectId: string | null;
  kind: 'neo' | 'project' | 'worker';
}

export interface NeoConsultation {
  id: string;
  requestKey: string;
  projectId: string;
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
  projectId: string | null;
  originSessionId: string;
  originMessageId: string | null;
  title: string;
  instruction: string;
  targetSessionId?: string | null;
  sessionId: string | null;
  status: 'proposed' | 'queued' | 'reported' | 'failed' | 'cancelled';
  report: string | null;
  follows?: string | null;
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
