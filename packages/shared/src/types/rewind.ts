export interface RewindPreview {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  messagesAffected?: number;
}

export interface RewindResult {
  success: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  conversationRewound?: boolean;
  messagesDeleted?: number;
}

export type RewindMode = 'files' | 'conversation' | 'both';

export interface SelectiveRewindRequest {
  messageIds: string[];
  sessionId: string;
  mode?: RewindMode;
}

export interface SelectiveRewindResult {
  success: boolean;
  error?: string;
  messagesDeleted: number;
  filesReverted: string[];
  rewindCase?: 'sdk-native' | 'diff-based' | 'hybrid';
  diffRevertedFiles?: string[];
}
