/**
 * Reference Types
 *
 * Core type definitions for the @ reference system.
 * References allow users to mention tasks, goals, files, and folders
 * in chat inputs using @ref{type:id} syntax.
 */

import type { SpaceTask } from './space.ts';

/**
 * The type of entity being referenced.
 * Union type (not enum) following existing codebase patterns like `SessionType`.
 */
export type ReferenceType = 'task' | 'goal' | 'file' | 'folder';

/**
 * A mention of a reference in text, as inserted by the autocomplete.
 * Stored in message content as @ref{type:id}.
 */
export interface ReferenceMention {
  type: ReferenceType;
  id: string;
  displayText: string;
}

/**
 * A single result returned from the reference.search RPC.
 * Used by the reference.search RPC handler (M1 Task 1.3) and the
 * useReferenceAutocomplete hook (M2).
 */
export interface ReferenceSearchResult {
  type: ReferenceType;
  id: string;
  /** Short human-readable ID (e.g. "t-42", "g-7") for tasks and goals */
  shortId?: string;
  /** Primary display text shown in the autocomplete menu */
  displayText: string;
  /** Secondary text shown below displayText (e.g. task status, file path) */
  subtitle?: string;
}

/**
 * A resolved reference with full entity data.
 */
export interface ResolvedReference {
  type: ReferenceType;
  id: string;
  /** Polymorphic — cast based on `type` */
  data: unknown;
}

export interface ResolvedTaskReference extends ResolvedReference {
  type: 'task';
  /** Space task payloads are typed; legacy room task payloads are preserved as opaque data. */
  data: SpaceTask | object;
}

export interface ResolvedGoalReference extends ResolvedReference {
  type: 'goal';
  /** Legacy room goal payloads are preserved as opaque compatibility data. */
  data: object;
}

/**
 * File content payload returned for a resolved file reference.
 * Mirrors the return shape of the resolve RPC handler in
 * packages/daemon/src/lib/rpc-handlers/reference-handlers.ts.
 */
export interface ResolvedFileData {
  path: string;
  /** UTF-8 text content, or null when the file is binary */
  content: string | null;
  /** True when the file contains binary (non-text) data; content will be null */
  binary: boolean;
  /** True when file content was truncated to stay within payload limits */
  truncated: boolean;
  size: number;
  mtime: string;
}

/** A single entry in a resolved folder listing. */
export interface FolderEntry {
  path: string;
  name: string;
  /** 'directory' matches FileManager.FileInfo and the real filesystem API */
  type: 'file' | 'directory';
}

/** Resolved file reference — data includes content (possibly truncated or absent for binary files) */
export interface ResolvedFileReference extends ResolvedReference {
  type: 'file';
  data: ResolvedFileData;
}

export interface ResolvedFolderReference extends ResolvedReference {
  type: 'folder';
  data: {
    path: string;
    entries: FolderEntry[];
  };
}

/**
 * Metadata stored in a message blob for all @ references within that message.
 * Uses Record (not Map) because this is serialized to JSON in the sdk_message column.
 *
 * Key is the raw @ref{type:id} token string.
 */
export type ReferenceMetadata = Record<
  string,
  { type: ReferenceType; id: string; displayText: string; status?: string }
>;

/**
 * Regex for parsing @ref{type:id} tokens from text.
 *
 * Matches: @ref{task:t-42}, @ref{goal:g-7}, @ref{file:src/foo.ts}, @ref{folder:src}
 * Does NOT match: normal @mentions, markdown links
 *
 * NOTE: This regex uses the 'g' flag, so it is stateful.
 * Always reset lastIndex to 0 (or use .exec() in a loop) before reuse.
 */
export const REFERENCE_PATTERN = /@ref\{([^}:]+):([^}]+)\}/g;
