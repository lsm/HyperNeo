/**
 * Rewind Feature Types
 *
 * Types for the rewind feature, which allows restoring workspace files
 * and/or conversation to a previous checkpoint.
 *
 * Note: Checkpoints are now derived from user messages stored in the database.
 * Each user message with a UUID serves as a potential rewind point.
 */

/**
 * Result of a rewind preview operation (dry run).
 * Shows what would change without actually modifying anything.
 */
export interface RewindPreview {
  /** Whether rewind is possible */
  canRewind: boolean;
  /** Error message if rewind is not possible */
  error?: string;
  /** List of files that would be changed */
  filesChanged?: string[];
  /** Number of line insertions */
  insertions?: number;
  /** Number of line deletions */
  deletions?: number;
  /** Number of messages that would be deleted (for conversation/both modes) */
  messagesAffected?: number;
}

/**
 * Result of a rewind execution operation.
 * Contains the actual changes made.
 */
export interface RewindResult {
  /** Whether the rewind operation succeeded */
  success: boolean;
  /** Error message if the operation failed */
  error?: string;
  /** List of files that were changed */
  filesChanged?: string[];
  /** Number of line insertions */
  insertions?: number;
  /** Number of line deletions */
  deletions?: number;
  /** Whether the conversation was rewound (messages deleted) */
  conversationRewound?: boolean;
  /** Number of messages deleted from the conversation */
  messagesDeleted?: number;
}

/**
 * Rewind mode - what to restore when rewinding.
 */
export type RewindMode = 'files' | 'conversation' | 'both';

// ==================== Selective Rewind Types ====================

/**
 * Request for selective rewind operation.
 * Selective rewind allows choosing specific messages to rewind,
 * deleting all messages from the first selected message onward.
 */
export interface SelectiveRewindRequest {
  /** Message UUIDs to rewind (all messages from first selected to end) */
  messageIds: string[];
  /** Session ID */
  sessionId: string;
  /** Rewind mode - what to restore when rewinding */
  mode?: RewindMode;
}

/**
 * Preview result for selective rewind operation.
 * Shows what would change without actually modifying anything.
 */
export interface SelectiveRewindPreview {
  /** Whether selective rewind is possible */
  canRewind: boolean;
  /** Error message if rewind is not possible */
  error?: string;
  /** Number of messages that would be deleted */
  messagesToDelete: number;
  /** Files that would be reverted, with strategy information */
  filesToRevert: Array<{
    /** File path relative to workspace root */
    path: string;
    /** Whether SDK checkpoint is available for this file */
    hasCheckpoint: boolean;
    /** Whether Edit tool diff is available as fallback */
    hasEditDiff: boolean;
  }>;
}

/**
 * Result of a selective rewind execution operation.
 * Contains the actual changes made.
 */
export interface SelectiveRewindResult {
  /** Whether the selective rewind operation succeeded */
  success: boolean;
  /** Error message if the operation failed */
  error?: string;
  /** Number of messages deleted from the conversation */
  messagesDeleted: number;
  /** List of file paths that were reverted */
  filesReverted: string[];
  /** Which rewind case was used for file reversion */
  rewindCase?: 'sdk-native' | 'diff-based' | 'hybrid';
  /** Files reverted via diff-based approach */
  diffRevertedFiles?: string[];
}
