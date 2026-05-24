/**
 * SDK Session File Manager
 *
 * Manages the .jsonl session files created by Claude Agent SDK in ~/.claude/projects/
 * These files store the conversation history and can grow very large with tool outputs.
 *
 * File path structure:
 * ~/.claude/projects/{workspace-path-with-slashes-replaced}/{sdk-session-id}.jsonl
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Database } from '../storage/database';

/**
 * Get the SDK project directory for a workspace path
 * SDK replaces both / and . with - (e.g., /.neokai/ -> --neokai-)
 *
 * @param workspacePath - The session's workspace path
 * @returns Absolute path to the SDK project directory
 */
function getSDKProjectDir(workspacePath: string): string {
  // Resolve symlinks so our path matches the SDK subprocess, which uses realpath
  // for its CWD. Without this, macOS symlinks (e.g., /var → /private/var) cause
  // path mismatches that break session file lookup and resume.
  const resolved = existsSync(workspacePath) ? realpathSync(workspacePath) : workspacePath;
  const projectKey = resolved.replace(/[/.]/g, '-');
  // Support TEST_SDK_SESSION_DIR for isolated testing
  const baseDir = process.env.TEST_SDK_SESSION_DIR || join(homedir(), '.claude');
  return join(baseDir, 'projects', projectKey);
}

/**
 * Construct the path to the SDK session .jsonl file
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID from Query.sessionId
 * @returns Absolute path to the .jsonl file
 */
export function getSDKSessionFilePath(workspacePath: string, sdkSessionId: string): string {
  return join(getSDKProjectDir(workspacePath), `${sdkSessionId}.jsonl`);
}

/**
 * Search all SDK project directories for a session file.
 *
 * The SDK stores session files under ~/.claude/projects/{encoded-cwd}/{sdkSessionId}.jsonl.
 * When the session's effective CWD changes between daemon restarts (e.g. worktree added),
 * the file won't be found at the new CWD. This function scans all known project directories
 * so we can locate and migrate the file before attempting resume.
 *
 * @param sdkSessionId - The SDK session ID to search for
 * @returns Absolute path to the .jsonl file if found, null otherwise
 */
export function findSDKSessionFileGlobally(sdkSessionId: string): string | null {
  const baseDir = process.env.TEST_SDK_SESSION_DIR || join(homedir(), '.claude');
  const projectsDir = join(baseDir, 'projects');

  if (!existsSync(projectsDir)) return null;

  try {
    const projectDirs = readdirSync(projectsDir);
    for (const projectDir of projectDirs) {
      const filePath = join(projectsDir, projectDir, `${sdkSessionId}.jsonl`);
      if (existsSync(filePath)) {
        return filePath;
      }
    }
  } catch {
    // Treat any scan error as "not found"
  }

  return null;
}

/**
 * Migrate an SDK session file from one workspace path's project dir to another's.
 *
 * Called before session resume when the effective CWD has changed since the session
 * was first created (e.g. a worktree was added/removed). Copies the .jsonl file to
 * the target workspace's project dir so the SDK subprocess (which runs with cwd=target)
 * can find it. Non-destructive: the source file is preserved.
 *
 * @param fromWorkspacePath - Workspace path where the file currently lives
 * @param toWorkspacePath - Workspace path where the SDK subprocess will run
 * @param sdkSessionId - The SDK session ID
 * @returns true if the file was copied successfully (or already exists at target)
 */
export function migrateSDKSessionFile(
  fromWorkspacePath: string,
  toWorkspacePath: string,
  sdkSessionId: string
): boolean {
  try {
    const sourcePath = getSDKSessionFilePath(fromWorkspacePath, sdkSessionId);
    if (!existsSync(sourcePath)) return false;

    const targetPath = getSDKSessionFilePath(toWorkspacePath, sdkSessionId);

    // Already at the right place — nothing to do
    if (sourcePath === targetPath) return true;

    // File already exists at target — treat as success (may have been migrated earlier)
    if (existsSync(targetPath)) return true;

    // Ensure the target project directory exists
    const targetDir = dirname(targetPath);
    mkdirSync(targetDir, { recursive: true });

    copyFileSync(sourcePath, targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find SDK session file by searching the workspace directory
 * Useful when we don't have the SDK session ID (e.g., session not currently running)
 *
 * @param workspacePath - The session's workspace path
 * @param kaiSessionId - The NeoKai session ID to search for in files
 * @returns Path to the session file if found, null otherwise
 */
function findSDKSessionFile(workspacePath: string, kaiSessionId: string): string | null {
  try {
    const sessionDir = getSDKProjectDir(workspacePath);

    if (!existsSync(sessionDir)) {
      return null;
    }

    // Search all .jsonl files for the NeoKai session ID
    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));

    // Track all matching files with their modification times
    const matchingFiles: Array<{ path: string; mtime: number }> = [];

    for (const file of files) {
      const filePath = join(sessionDir, file);
      const content = readFileSync(filePath, 'utf-8');

      // Check if this file contains the NeoKai session ID
      if (content.includes(kaiSessionId)) {
        const stats = statSync(filePath);
        matchingFiles.push({ path: filePath, mtime: stats.mtimeMs });
      }
    }

    // Return the most recently modified file
    if (matchingFiles.length === 0) {
      return null;
    }

    matchingFiles.sort((a, b) => b.mtime - a.mtime);
    return matchingFiles[0].path;
  } catch {
    return null;
  }
}

/**
 * Remove tool_result content from a specific message in the SDK session file
 *
 * Replaces large tool_result content with a placeholder to reduce file size
 * and unstick sessions with context overflow.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID from Query.sessionId (optional, will search if not provided)
 * @param messageUuid - The UUID of the message to modify
 * @param kaiSessionId - The NeoKai session ID (for fallback search)
 * @returns true if successful, false otherwise
 */
export function removeToolResultFromSessionFile(
  workspacePath: string,
  sdkSessionId: string | null,
  messageUuid: string,
  kaiSessionId?: string
): boolean {
  try {
    let sessionFile: string | null = null;

    // Primary: Use SDK session ID for direct file path construction
    // This is 100% reliable - the filename IS the SDK session ID
    if (sdkSessionId) {
      sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
      if (!existsSync(sessionFile)) {
        return false;
      }
    }
    // Fallback: Search by NeoKai session ID (only when session not currently running)
    // This is less reliable as the same NeoKai ID can appear in 100+ SDK files
    else if (kaiSessionId) {
      sessionFile = findSDKSessionFile(workspacePath, kaiSessionId);
      if (!sessionFile) {
        return false;
      }
    } else {
      return false;
    }

    // Read the .jsonl file (each line is a JSON object)
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    // Process each line to find and modify the target message
    let modified = false;
    const updatedLines = lines.map((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;

      // Check if this is the target message
      if (message.uuid === messageUuid) {
        // Modify tool_result content in this message
        if (
          message.type === 'user' &&
          message.message &&
          typeof message.message === 'object' &&
          'content' in message.message &&
          Array.isArray(message.message.content)
        ) {
          const messageContent = message.message as Record<string, unknown>;
          const contentArray = messageContent.content as unknown[];

          messageContent.content = contentArray.map((block: unknown) => {
            const blockObj = block as Record<string, unknown>;
            if (blockObj.type === 'tool_result') {
              modified = true;
              return {
                ...blockObj,
                content: [
                  {
                    type: 'text',
                    text: '⚠️ Output removed by user. Run again with filter to narrow down the message.',
                  },
                ],
              };
            }
            return block;
          });
        }
      }

      return JSON.stringify(message);
    });

    if (!modified) {
      return false;
    }

    // Write back to file
    writeFileSync(sessionFile, `${updatedLines.join('\n')}\n`, 'utf-8');

    return true;
  } catch {
    return false;
  }
}

/**
 * Result of SDK session file validation
 */
export interface SDKSessionValidationResult {
  valid: boolean;
  orphanedToolResults: Array<{
    toolUseId: string;
    messageUuid: string;
    lineIndex: number;
  }>;
  errors: string[];
}

/**
 * Result of SDK session file repair
 */
export interface SDKSessionRepairResult {
  success: boolean;
  backupPath: string | null;
  repairedCount: number;
  errors: string[];
}

/**
 * SDK message format in .jsonl file
 */
interface SDKFileMessage {
  type: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      id?: string;
      tool_use_id?: string;
      [key: string]: unknown;
    }>;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SDKSessionUsageSanitizationResult {
  success: boolean;
  filePath: string | null;
  sanitizedCount: number;
  errors: string[];
}

function isFiniteTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Sanitize legacy Claude SDK JSONL transcripts before daemon-restart resume.
 *
 * Older SDK versions persisted assistant messages without message.usage. Current
 * SDK readMessages expects usage.input_tokens to exist and can crash before our
 * normal query error handling runs. This function performs the smallest safe
 * mutation: assistant messages get a usage object and numeric input/output token
 * counts, preserving any other SDK-owned fields.
 */
export function sanitizeAssistantUsageInSDKSessionFile(
  workspacePath: string,
  sdkSessionId: string
): SDKSessionUsageSanitizationResult {
  const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
  const result: SDKSessionUsageSanitizationResult = {
    success: true,
    filePath: sessionFile,
    sanitizedCount: 0,
    errors: [],
  };

  if (!existsSync(sessionFile)) {
    result.filePath = null;
    return result;
  }

  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n');
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      let message: SDKFileMessage;
      try {
        message = JSON.parse(line) as SDKFileMessage;
      } catch (parseError) {
        result.errors.push(`Failed to parse line ${i}: ${parseError}`);
        continue;
      }

      if (message.type !== 'assistant' || !message.message) continue;

      const existingUsage =
        message.message.usage && typeof message.message.usage === 'object'
          ? message.message.usage
          : {};
      const nextUsage = {
        ...existingUsage,
        input_tokens: isFiniteTokenCount(existingUsage.input_tokens)
          ? existingUsage.input_tokens
          : 0,
        output_tokens: isFiniteTokenCount(existingUsage.output_tokens)
          ? existingUsage.output_tokens
          : 0,
      };

      if (
        message.message.usage !== existingUsage ||
        nextUsage.input_tokens !== existingUsage.input_tokens ||
        nextUsage.output_tokens !== existingUsage.output_tokens
      ) {
        message.message.usage = nextUsage;
        lines[i] = JSON.stringify(message);
        result.sanitizedCount++;
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(sessionFile, lines.join('\n'), 'utf-8');
    }
  } catch (error) {
    result.success = false;
    result.errors.push(`Sanitization error: ${error}`);
  }

  return result;
}

/**
 * Validate SDK session file for orphaned tool_result blocks
 *
 * Checks that every tool_result has a corresponding tool_use in the conversation history.
 * SDK context compaction can sometimes remove tool_use blocks while keeping tool_results,
 * which causes API validation errors.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID
 * @returns Validation result with list of orphaned tool_results
 */
export function validateSDKSessionFile(
  workspacePath: string,
  sdkSessionId: string
): SDKSessionValidationResult {
  const result: SDKSessionValidationResult = {
    valid: true,
    orphanedToolResults: [],
    errors: [],
  };

  try {
    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);

    if (!existsSync(sessionFile)) {
      // No file means nothing to validate - this is OK for new sessions
      return result;
    }

    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    // Collect all tool_use IDs
    const toolUseIds = new Set<string>();
    // Collect all tool_result references
    const toolResultRefs: Array<{
      toolUseId: string;
      messageUuid: string;
      lineIndex: number;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const message = JSON.parse(lines[i]) as SDKFileMessage;

        // Collect tool_use IDs from assistant messages
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.id) {
              toolUseIds.add(block.id);
            }
          }
        }

        // Collect tool_result references from user messages
        if (message.type === 'user' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              toolResultRefs.push({
                toolUseId: block.tool_use_id,
                messageUuid: message.uuid || 'unknown',
                lineIndex: i,
              });
            }
          }
        }
      } catch (parseError) {
        result.errors.push(`Failed to parse line ${i}: ${parseError}`);
      }
    }

    // Find orphaned tool_results (those without matching tool_use)
    for (const ref of toolResultRefs) {
      if (!toolUseIds.has(ref.toolUseId)) {
        result.orphanedToolResults.push(ref);
        result.valid = false;
      }
    }
  } catch (error) {
    result.valid = false;
    result.errors.push(`Validation error: ${error}`);
  }

  return result;
}

/**
 * Backup SDK session file before making changes
 *
 * @param sessionFilePath - Path to the session file
 * @returns Path to backup file, or null if backup failed
 */
function backupSDKSessionFile(sessionFilePath: string): string | null {
  try {
    const backupDir = join(dirname(sessionFilePath), 'backups');
    mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = sessionFilePath.split('/').pop() || 'session.jsonl';
    const backupPath = join(backupDir, `${fileName}.backup.${timestamp}`);

    copyFileSync(sessionFilePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Repair SDK session file by inserting missing tool_use messages from NeoKai DB
 *
 * When SDK context compaction removes tool_use blocks while keeping tool_results,
 * this function attempts to repair the file by looking up the missing messages
 * from NeoKai's database and inserting them at the correct positions.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID
 * @param kaiSessionId - The NeoKai session ID (for DB lookup)
 * @param db - Database instance for message lookup
 * @returns Repair result with backup path and count of repaired messages
 */
export function repairSDKSessionFile(
  workspacePath: string,
  sdkSessionId: string,
  kaiSessionId: string,
  db: Database
): SDKSessionRepairResult {
  const result: SDKSessionRepairResult = {
    success: false,
    backupPath: null,
    repairedCount: 0,
    errors: [],
  };

  try {
    // First validate to find orphaned tool_results
    const validation = validateSDKSessionFile(workspacePath, sdkSessionId);

    if (validation.valid) {
      result.success = true;
      return result; // Nothing to repair
    }

    if (validation.errors.length > 0) {
      result.errors.push(...validation.errors);
    }

    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);

    // Create backup before modifying
    result.backupPath = backupSDKSessionFile(sessionFile);
    if (!result.backupPath) {
      result.errors.push('Failed to create backup - aborting repair');
      return result;
    }

    // Read the file
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    // For each orphaned tool_result, try to find and insert the missing tool_use
    const insertions: Array<{ lineIndex: number; message: string }> = [];

    for (const orphan of validation.orphanedToolResults) {
      // Look up the tool_use message from NeoKai DB by searching for the tool_use_id
      // Note: db.getSDKMessages returns up to 100 messages by default, increase limit to search more
      const { messages: dbMessages } = db.getSDKMessages(kaiSessionId, 10000);

      let missingAssistantMsg: SDKFileMessage | null = null;
      let missingMsgTimestamp: string | null = null;

      for (const dbMsg of dbMessages) {
        // SDKMessage from DB is already parsed - cast to our local SDKFileMessage type
        const parsedMsg = dbMsg as unknown as SDKFileMessage & {
          timestamp?: number;
        };
        if (parsedMsg.type === 'assistant' && parsedMsg.message?.content) {
          for (const block of parsedMsg.message.content) {
            if (block.type === 'tool_use' && block.id === orphan.toolUseId) {
              missingAssistantMsg = parsedMsg;
              // timestamp is injected by the repository as a number (milliseconds)
              missingMsgTimestamp = parsedMsg.timestamp
                ? new Date(parsedMsg.timestamp).toISOString()
                : new Date().toISOString();
              break;
            }
          }
        }
        if (missingAssistantMsg) break;
      }

      if (!missingAssistantMsg) {
        result.errors.push(`Could not find tool_use message for ${orphan.toolUseId} in NeoKai DB`);
        continue;
      }

      // Get the orphaned message to extract metadata for the repaired message
      const orphanedLine = JSON.parse(lines[orphan.lineIndex]) as SDKFileMessage;

      // Build the repaired SDK file message format
      const repairedMsg: SDKFileMessage = {
        parentUuid: orphanedLine.parentUuid, // Will need adjustment
        isSidechain: false,
        userType: 'external',
        cwd: orphanedLine.cwd || workspacePath,
        sessionId: sdkSessionId,
        version: orphanedLine.version || '2.1.1',
        gitBranch: orphanedLine.gitBranch,
        slug: orphanedLine.slug,
        message: missingAssistantMsg.message,
        requestId: `req_recovered_${missingAssistantMsg.uuid?.slice(0, 8) || 'unknown'}`,
        type: 'assistant',
        uuid: missingAssistantMsg.uuid,
        timestamp: missingMsgTimestamp || new Date().toISOString(),
      };

      // Find the correct insertion point (before the orphaned tool_result)
      // And update the parentUuid of the orphaned message to point to the repaired message
      insertions.push({
        lineIndex: orphan.lineIndex,
        message: JSON.stringify(repairedMsg),
      });

      // Update the orphaned message's parentUuid to point to the repaired message
      if (missingAssistantMsg.uuid) {
        const updatedOrphan = {
          ...orphanedLine,
          parentUuid: missingAssistantMsg.uuid,
        };
        lines[orphan.lineIndex] = JSON.stringify(updatedOrphan);
      }

      result.repairedCount++;
    }

    // Insert messages in reverse order (to preserve line indices)
    insertions.sort((a, b) => b.lineIndex - a.lineIndex);
    for (const insertion of insertions) {
      lines.splice(insertion.lineIndex, 0, insertion.message);
    }

    // Write back to file
    writeFileSync(sessionFile, `${lines.join('\n')}\n`, 'utf-8');

    result.success = result.repairedCount > 0;
  } catch (error) {
    result.errors.push(`Repair error: ${error}`);
  }

  return result;
}

/**
 * Validate and auto-repair SDK session file before resuming
 *
 * This is the main entry point for session resume validation.
 * It validates the SDK session file and attempts auto-repair if needed.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID
 * @param kaiSessionId - The NeoKai session ID (for DB lookup)
 * @param db - Database instance for message lookup
 * @returns true if session is valid (or was repaired), false if unrecoverable
 */
export function validateAndRepairSDKSession(
  workspacePath: string,
  sdkSessionId: string,
  kaiSessionId: string,
  db: Database
): boolean {
  // If the SDK session file doesn't exist, the session can't be resumed.
  // This happens when the file was deleted externally (cleanup, manual deletion,
  // workspace path change). Return false so the caller clears sdkSessionId
  // and starts a fresh query without resume.
  const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
  if (!existsSync(sessionFile)) {
    return false;
  }

  // First validate
  const validation = validateSDKSessionFile(workspacePath, sdkSessionId);

  if (validation.valid) {
    return true;
  }

  // Attempt repair
  const repair = repairSDKSessionFile(workspacePath, sdkSessionId, kaiSessionId, db);

  if (repair.success) {
    return true;
  }

  return false;
}

// ============================================================================
// SDK Session File Cleanup & Archive Functions
// ============================================================================

/**
 * Result of SDK session file deletion
 */
export interface SDKDeleteResult {
  success: boolean;
  deletedFiles: string[];
  deletedSize: number;
  errors: string[];
}

/**
 * Result of SDK session file archival
 */
export interface SDKArchiveResult {
  success: boolean;
  archivePath: string | null;
  archivedFiles: string[];
  totalSize: number;
  errors: string[];
}

/**
 * Information about an SDK session file
 */
export interface SDKSessionFileInfo {
  path: string;
  sdkSessionId: string;
  kaiSessionIds: string[];
  size: number;
  modifiedAt: Date;
}

/**
 * Information about an orphaned SDK session file
 */
export interface OrphanedSDKFileInfo extends SDKSessionFileInfo {
  reason: 'no-matching-session' | 'unknown-session';
}

/**
 * Archive metadata stored alongside archived files
 */
interface ArchiveMetadata {
  kaiSessionId: string;
  originalWorkspacePath: string;
  originalFilePaths: string[];
  archivedAt: string;
  totalSize: number;
  fileCount: number;
}

/**
 * Get the archive directory for a NeoKai session
 */
function getArchiveDir(kaiSessionId: string): string {
  // Support TEST_SDK_SESSION_DIR for isolated testing
  const baseDir = process.env.TEST_SDK_SESSION_DIR || join(homedir(), '.neokai');
  return join(baseDir, 'claude-session-archives', kaiSessionId);
}

/**
 * Find all SDK session files for a NeoKai session
 * Returns all files that contain the NeoKai session ID
 */
function findAllSDKFilesForSession(
  workspacePath: string,
  sdkSessionId: string | null,
  kaiSessionId: string
): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];

  try {
    const sessionDir = getSDKProjectDir(workspacePath);

    if (!existsSync(sessionDir)) {
      return results;
    }

    // If we have SDK session ID, get that file directly
    if (sdkSessionId) {
      const filePath = getSDKSessionFilePath(workspacePath, sdkSessionId);
      if (existsSync(filePath)) {
        const stats = statSync(filePath);
        results.push({ path: filePath, size: stats.size });
      }
    }

    // Also search for any other files containing the NeoKai session ID
    // (in case there are multiple SDK sessions for the same NeoKai session)
    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(sessionDir, file);

      // Skip if already added via SDK session ID
      if (results.some((r) => r.path === filePath)) {
        continue;
      }

      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.includes(kaiSessionId)) {
          const stats = statSync(filePath);
          results.push({ path: filePath, size: stats.size });
        }
      } catch {
        // Skip files we can't read
      }
    }
  } catch {
    // Silent failure - caller will handle empty results
  }

  return results;
}

/**
 * Delete SDK session files for a NeoKai session
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID (optional, will search if not provided)
 * @param kaiSessionId - The NeoKai session ID
 * @returns Delete result with list of deleted files
 */
export function deleteSDKSessionFiles(
  workspacePath: string,
  sdkSessionId: string | null,
  kaiSessionId: string
): SDKDeleteResult {
  const result: SDKDeleteResult = {
    success: true,
    deletedFiles: [],
    deletedSize: 0,
    errors: [],
  };

  try {
    const files = findAllSDKFilesForSession(workspacePath, sdkSessionId, kaiSessionId);

    if (files.length === 0) {
      return result;
    }

    for (const file of files) {
      try {
        unlinkSync(file.path);
        result.deletedFiles.push(file.path);
        result.deletedSize += file.size;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to delete ${file.path}: ${errorMsg}`);
        result.success = false;
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Delete operation failed: ${errorMsg}`);
    result.success = false;
  }

  return result;
}

/**
 * Archive SDK session files for a NeoKai session
 *
 * Moves files to ~/.neokai/claude-session-archives/{kaiSessionId}/
 * and creates an archive-metadata.json file.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID (optional, will search if not provided)
 * @param kaiSessionId - The NeoKai session ID
 * @returns Archive result with archive path and list of archived files
 */
export function archiveSDKSessionFiles(
  workspacePath: string,
  sdkSessionId: string | null,
  kaiSessionId: string
): SDKArchiveResult {
  const result: SDKArchiveResult = {
    success: true,
    archivePath: null,
    archivedFiles: [],
    totalSize: 0,
    errors: [],
  };

  try {
    const files = findAllSDKFilesForSession(workspacePath, sdkSessionId, kaiSessionId);

    if (files.length === 0) {
      return result;
    }

    // Create archive directory
    const archiveDir = getArchiveDir(kaiSessionId);
    mkdirSync(archiveDir, { recursive: true });
    result.archivePath = archiveDir;

    const originalPaths: string[] = [];

    // Move each file to archive
    for (const file of files) {
      try {
        const fileName = basename(file.path);
        const archivePath = join(archiveDir, fileName);

        // Use rename for atomic move (or copy+delete if across filesystems)
        try {
          renameSync(file.path, archivePath);
        } catch {
          // Fallback to copy+delete if rename fails (cross-filesystem)
          copyFileSync(file.path, archivePath);
          unlinkSync(file.path);
        }

        result.archivedFiles.push(archivePath);
        result.totalSize += file.size;
        originalPaths.push(file.path);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to archive ${file.path}: ${errorMsg}`);
        result.success = false;
      }
    }

    // Write archive metadata
    if (result.archivedFiles.length > 0) {
      const metadata: ArchiveMetadata = {
        kaiSessionId,
        originalWorkspacePath: workspacePath,
        originalFilePaths: originalPaths,
        archivedAt: new Date().toISOString(),
        totalSize: result.totalSize,
        fileCount: result.archivedFiles.length,
      };

      const metadataPath = join(archiveDir, 'archive-metadata.json');
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Archive operation failed: ${errorMsg}`);
    result.success = false;
  }

  return result;
}

/**
 * Scan SDK project directory for all session files
 *
 * @param workspacePath - The workspace path to scan
 * @returns List of SDK session file info
 */
export function scanSDKSessionFiles(workspacePath: string): SDKSessionFileInfo[] {
  const results: SDKSessionFileInfo[] = [];

  try {
    const sessionDir = getSDKProjectDir(workspacePath);

    if (!existsSync(sessionDir)) {
      return results;
    }

    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(sessionDir, file);

      try {
        const stats = statSync(filePath);
        const sdkSessionId = file.replace('.jsonl', '');

        // Extract NeoKai session IDs from file content
        const kaiSessionIds = extractKaiSessionIds(filePath);

        results.push({
          path: filePath,
          sdkSessionId,
          kaiSessionIds,
          size: stats.size,
          modifiedAt: stats.mtime,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Silent failure - caller will handle empty results
  }

  return results;
}

/**
 * Extract NeoKai session IDs from an SDK session file
 * Looks for UUID patterns in the file content
 */
function extractKaiSessionIds(filePath: string): string[] {
  const ids = new Set<string>();

  try {
    const content = readFileSync(filePath, 'utf-8');

    // UUID v4 pattern (NeoKai session IDs)
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
    const matches = content.match(uuidPattern);

    if (matches) {
      // Filter to unique IDs that appear multiple times (likely session IDs, not message UUIDs)
      const idCounts = new Map<string, number>();
      for (const id of matches) {
        const lower = id.toLowerCase();
        idCounts.set(lower, (idCounts.get(lower) || 0) + 1);
      }

      // Session IDs typically appear many times (in each message)
      // Message UUIDs typically appear only once or twice
      for (const [id, count] of idCounts) {
        if (count >= 3) {
          ids.add(id);
        }
      }
    }
  } catch {
    // Return empty if we can't read
  }

  return Array.from(ids);
}

/**
 * Identify orphaned SDK session files
 *
 * Files are considered orphaned if none of their NeoKai session IDs
 * match any active or archived session in the database.
 *
 * @param files - List of SDK session file info from scanSDKSessionFiles
 * @param activeSessionIds - Set of active NeoKai session IDs
 * @param archivedSessionIds - Set of archived NeoKai session IDs
 * @returns List of orphaned files with reason
 */
export function identifyOrphanedSDKFiles(
  files: SDKSessionFileInfo[],
  activeSessionIds: Set<string>,
  archivedSessionIds: Set<string>
): OrphanedSDKFileInfo[] {
  const orphaned: OrphanedSDKFileInfo[] = [];

  for (const file of files) {
    // Check if any of the NeoKai session IDs match known sessions
    const hasActiveSession = file.kaiSessionIds.some((id) => activeSessionIds.has(id));
    const hasArchivedSession = file.kaiSessionIds.some((id) => archivedSessionIds.has(id));

    if (!hasActiveSession && !hasArchivedSession) {
      orphaned.push({
        ...file,
        reason: file.kaiSessionIds.length === 0 ? 'unknown-session' : 'no-matching-session',
      });
    }
  }

  return orphaned;
}

/**
 * Result of thinking block stripping
 */
export interface StripThinkingBlocksResult {
  stripped: boolean;
  thinkingBlocksRemoved: number;
  backupPath: string | null;
}

/**
 * Strip thinking blocks from the SDK session JSONL file
 *
 * Thinking block signatures are provider-specific and cannot be validated across
 * providers. Anthropic rejects GLM/MiniMax signatures; GLM/MiniMax reject Anthropic
 * signatures. Both directions fail with "400: Invalid signature in thinking block".
 * Removing these blocks before resume preserves conversation context (text + tool
 * usage) while avoiding the signature validation error.
 *
 * Without this, the SDK recovers by starting a fresh conversation — sdkSessionId
 * is preserved but all conversation context is lost.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID
 * @returns Result with count of removed thinking blocks
 */
export function stripThinkingBlocksFromSessionFile(
  workspacePath: string,
  sdkSessionId: string
): StripThinkingBlocksResult {
  const result: StripThinkingBlocksResult = {
    stripped: false,
    thinkingBlocksRemoved: 0,
    backupPath: null,
  };

  try {
    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);

    if (!existsSync(sessionFile)) {
      return result;
    }

    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    let modified = false;
    const updatedLines = lines.map((line) => {
      try {
        const message = JSON.parse(line) as SDKFileMessage;

        if (
          message.type === 'assistant' &&
          message.message?.content &&
          Array.isArray(message.message.content)
        ) {
          const original = message.message.content;
          const filtered = original.filter((block: { type: string }) => block.type !== 'thinking');

          if (filtered.length < original.length) {
            result.thinkingBlocksRemoved += original.length - filtered.length;
            message.message.content = filtered;
            modified = true;
            return JSON.stringify(message);
          }
        }
      } catch {
        // Skip unparseable lines — preserve them as-is
      }
      return line;
    });

    if (modified) {
      // Backup before modifying
      result.backupPath = backupSDKSessionFile(sessionFile);

      writeFileSync(sessionFile, `${updatedLines.join('\n')}\n`, 'utf-8');
      result.stripped = true;
    }
  } catch {
    // Best-effort — if stripping fails, the SDK will recover by starting fresh
  }

  return result;
}

/**
 * Truncate the SDK session JSONL file at a specific message
 *
 * Removes the message with the given UUID and all subsequent messages from the JSONL file.
 * This ensures the file is physically cleaned up during rewind, not just logically skipped
 * via resumeSessionAt.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID (for direct file path lookup)
 * @param kaiSessionId - The NeoKai session ID (fallback for file search)
 * @param messageUuid - The UUID of the message to truncate at (this message is removed too)
 * @returns Object with truncation result
 */
export function truncateSessionFileAtMessage(
  workspacePath: string,
  sdkSessionId: string | null | undefined,
  kaiSessionId: string,
  messageUuid: string
): { truncated: boolean; linesRemoved: number } {
  // Find the JSONL file
  let filePath: string | null = null;
  if (sdkSessionId) {
    const candidatePath = getSDKSessionFilePath(workspacePath, sdkSessionId);
    if (existsSync(candidatePath)) {
      filePath = candidatePath;
    }
  }
  if (!filePath) {
    filePath = findSDKSessionFile(workspacePath, kaiSessionId);
  }
  if (!filePath || !existsSync(filePath)) {
    return { truncated: false, linesRemoved: 0 };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Find the line containing the message UUID
    let truncateIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i].includes(`"uuid":"${messageUuid}"`) ||
        lines[i].includes(`"uuid": "${messageUuid}"`)
      ) {
        truncateIndex = i;
        break;
      }
    }

    if (truncateIndex === -1) {
      // UUID not found - try looser match
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(messageUuid)) {
          truncateIndex = i;
          break;
        }
      }
    }

    if (truncateIndex === -1) {
      return { truncated: false, linesRemoved: 0 };
    }

    // Keep lines before the message, remove it and everything after
    const keptLines = lines.slice(0, truncateIndex);
    const linesRemoved = lines.length - truncateIndex;

    // Write back (ensure file ends with newline if non-empty)
    const newContent = keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '';
    writeFileSync(filePath, newContent);

    return { truncated: true, linesRemoved };
  } catch {
    return { truncated: false, linesRemoved: 0 };
  }
}

/**
 * Check whether a message UUID still exists in the SDK session JSONL file.
 *
 * This is used before passing resumeSessionAt back to the SDK. Auto-compaction
 * can replace older transcript entries with a summary, so a UUID that remains
 * in NeoKai's DB may no longer be resumable from the SDK transcript.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID (for direct file path lookup)
 * @param kaiSessionId - The NeoKai session ID (fallback for file search)
 * @param messageUuid - The UUID of the message to find
 * @returns true when the UUID exists in the JSONL transcript
 */
export function messageUuidExistsInSessionFile(
  workspacePath: string,
  sdkSessionId: string | null | undefined,
  kaiSessionId: string,
  messageUuid: string
): boolean {
  const messageUuids = readMessageUuidsFromSessionFile(workspacePath, sdkSessionId, kaiSessionId);
  return messageUuids?.has(messageUuid) ?? false;
}

function readMessageUuidsFromSessionFile(
  workspacePath: string,
  sdkSessionId: string | null | undefined,
  kaiSessionId: string
): Set<string> | null {
  const filePath = resolveSDKSessionFilePath(workspacePath, sdkSessionId, kaiSessionId);
  if (!filePath) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return extractMessageUuids(content);
  } catch {
    return null;
  }
}

function resolveSDKSessionFilePath(
  workspacePath: string,
  sdkSessionId: string | null | undefined,
  kaiSessionId: string
): string | null {
  let filePath: string | null = null;
  if (sdkSessionId) {
    const candidatePath = getSDKSessionFilePath(workspacePath, sdkSessionId);
    if (existsSync(candidatePath)) {
      filePath = candidatePath;
    }
  }
  if (!filePath) {
    filePath = findSDKSessionFile(workspacePath, kaiSessionId);
  }
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  return filePath;
}

function extractMessageUuids(content: string): Set<string> {
  const messageUuids = new Set<string>();
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { uuid?: unknown };
      if (typeof parsed.uuid === 'string') {
        messageUuids.add(parsed.uuid);
        continue;
      }
    } catch {
      // Fall through to a light regex fallback for partially malformed lines.
    }

    for (const match of line.matchAll(/"uuid"\s*:\s*"([^"]+)"/g)) {
      messageUuids.add(match[1]);
    }
  }
  return messageUuids;
}
