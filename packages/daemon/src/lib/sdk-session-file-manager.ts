import { getDataDir } from './data-dir';
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

function getSDKProjectDir(workspacePath: string): string {
  const resolved = existsSync(workspacePath) ? realpathSync(workspacePath) : workspacePath;
  const projectKey = resolved.replace(/[/.]/g, '-');
  const baseDir = process.env.TEST_SDK_SESSION_DIR || join(homedir(), '.claude');
  return join(baseDir, 'projects', projectKey);
}

export function getSDKSessionFilePath(workspacePath: string, sdkSessionId: string): string {
  return join(getSDKProjectDir(workspacePath), `${sdkSessionId}.jsonl`);
}

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
  } catch {}

  return null;
}

export function migrateSDKSessionFile(
  fromWorkspacePath: string,
  toWorkspacePath: string,
  sdkSessionId: string
): boolean {
  try {
    const sourcePath = getSDKSessionFilePath(fromWorkspacePath, sdkSessionId);
    if (!existsSync(sourcePath)) return false;

    const targetPath = getSDKSessionFilePath(toWorkspacePath, sdkSessionId);

    if (sourcePath === targetPath) return true;

    if (existsSync(targetPath)) return true;

    const targetDir = dirname(targetPath);
    mkdirSync(targetDir, { recursive: true });

    copyFileSync(sourcePath, targetPath);
    return true;
  } catch {
    return false;
  }
}

function findSDKSessionFile(workspacePath: string, kaiSessionId: string): string | null {
  try {
    const sessionDir = getSDKProjectDir(workspacePath);

    if (!existsSync(sessionDir)) {
      return null;
    }

    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));

    const matchingFiles: Array<{ path: string; mtime: number }> = [];

    for (const file of files) {
      const filePath = join(sessionDir, file);
      const content = readFileSync(filePath, 'utf-8');

      if (content.includes(kaiSessionId)) {
        const stats = statSync(filePath);
        matchingFiles.push({ path: filePath, mtime: stats.mtimeMs });
      }
    }

    if (matchingFiles.length === 0) {
      return null;
    }

    matchingFiles.sort((a, b) => b.mtime - a.mtime);
    return matchingFiles[0].path;
  } catch {
    return null;
  }
}

export function removeToolResultFromSessionFile(
  workspacePath: string,
  sdkSessionId: string | null,
  messageUuid: string,
  kaiSessionId?: string
): boolean {
  try {
    let sessionFile: string | null = null;

    if (sdkSessionId) {
      sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
      if (!existsSync(sessionFile)) {
        return false;
      }
    } else if (kaiSessionId) {
      sessionFile = findSDKSessionFile(workspacePath, kaiSessionId);
      if (!sessionFile) {
        return false;
      }
    } else {
      return false;
    }

    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    let modified = false;
    const updatedLines = lines.map((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;

      if (message.uuid === messageUuid) {
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

    writeFileSync(sessionFile, `${updatedLines.join('\n')}\n`, 'utf-8');

    return true;
  } catch {
    return false;
  }
}

export interface SDKSessionValidationResult {
  valid: boolean;
  orphanedToolResults: Array<{
    toolUseId: string;
    messageUuid: string;
    lineIndex: number;
  }>;
  errors: string[];
}

export interface SDKSessionRepairResult {
  success: boolean;
  backupPath: string | null;
  repairedCount: number;
  errors: string[];
}

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
      return result;
    }

    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    const toolUseIds = new Set<string>();
    const toolResultRefs: Array<{
      toolUseId: string;
      messageUuid: string;
      lineIndex: number;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const message = JSON.parse(lines[i]) as SDKFileMessage;

        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.id) {
              toolUseIds.add(block.id);
            }
          }
        }

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
    const validation = validateSDKSessionFile(workspacePath, sdkSessionId);

    if (validation.valid) {
      result.success = true;
      return result;
    }

    if (validation.errors.length > 0) {
      result.errors.push(...validation.errors);
    }

    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);

    result.backupPath = backupSDKSessionFile(sessionFile);
    if (!result.backupPath) {
      result.errors.push('Failed to create backup - aborting repair');
      return result;
    }

    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    const insertions: Array<{ lineIndex: number; message: string }> = [];

    for (const orphan of validation.orphanedToolResults) {
      const { messages: dbMessages } = db.getSDKMessages(kaiSessionId, 10000);

      let missingAssistantMsg: SDKFileMessage | null = null;
      let missingMsgTimestamp: string | null = null;

      for (const dbMsg of dbMessages) {
        const parsedMsg = dbMsg as unknown as SDKFileMessage & {
          timestamp?: number;
        };
        if (parsedMsg.type === 'assistant' && parsedMsg.message?.content) {
          for (const block of parsedMsg.message.content) {
            if (block.type === 'tool_use' && block.id === orphan.toolUseId) {
              missingAssistantMsg = parsedMsg;
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
        result.errors.push(
          `Could not find tool_use message for ${orphan.toolUseId} in HyperNeo DB`
        );
        continue;
      }

      const orphanedLine = JSON.parse(lines[orphan.lineIndex]) as SDKFileMessage;

      const repairedMsg: SDKFileMessage = {
        parentUuid: orphanedLine.parentUuid,
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

      insertions.push({
        lineIndex: orphan.lineIndex,
        message: JSON.stringify(repairedMsg),
      });

      if (missingAssistantMsg.uuid) {
        const updatedOrphan = {
          ...orphanedLine,
          parentUuid: missingAssistantMsg.uuid,
        };
        lines[orphan.lineIndex] = JSON.stringify(updatedOrphan);
      }

      result.repairedCount++;
    }

    insertions.sort((a, b) => b.lineIndex - a.lineIndex);
    for (const insertion of insertions) {
      lines.splice(insertion.lineIndex, 0, insertion.message);
    }

    writeFileSync(sessionFile, `${lines.join('\n')}\n`, 'utf-8');

    result.success = result.repairedCount > 0;
  } catch (error) {
    result.errors.push(`Repair error: ${error}`);
  }

  return result;
}

export function validateAndRepairSDKSession(
  workspacePath: string,
  sdkSessionId: string,
  kaiSessionId: string,
  db: Database
): boolean {
  const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
  if (!existsSync(sessionFile)) {
    return false;
  }

  const validation = validateSDKSessionFile(workspacePath, sdkSessionId);

  if (validation.valid) {
    return true;
  }

  const repair = repairSDKSessionFile(workspacePath, sdkSessionId, kaiSessionId, db);

  if (repair.success) {
    return true;
  }

  return false;
}

export interface SDKDeleteResult {
  success: boolean;
  deletedFiles: string[];
  deletedSize: number;
  errors: string[];
}

export interface SDKArchiveResult {
  success: boolean;
  archivePath: string | null;
  archivedFiles: string[];
  totalSize: number;
  errors: string[];
}

export interface SDKSessionFileInfo {
  path: string;
  sdkSessionId: string;
  kaiSessionIds: string[];
  size: number;
  modifiedAt: Date;
}

export interface OrphanedSDKFileInfo extends SDKSessionFileInfo {
  reason: 'no-matching-session' | 'unknown-session';
}

interface ArchiveMetadata {
  kaiSessionId: string;
  originalWorkspacePath: string;
  originalFilePaths: string[];
  archivedAt: string;
  totalSize: number;
  fileCount: number;
}

function getArchiveDir(kaiSessionId: string): string {
  const baseDir = process.env.TEST_SDK_SESSION_DIR || getDataDir();
  return join(baseDir, 'claude-session-archives', kaiSessionId);
}

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

    if (sdkSessionId) {
      const filePath = getSDKSessionFilePath(workspacePath, sdkSessionId);
      if (existsSync(filePath)) {
        const stats = statSync(filePath);
        results.push({ path: filePath, size: stats.size });
      }
    }

    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(sessionDir, file);

      if (results.some((r) => r.path === filePath)) {
        continue;
      }

      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.includes(kaiSessionId)) {
          const stats = statSync(filePath);
          results.push({ path: filePath, size: stats.size });
        }
      } catch {}
    }
  } catch {}

  return results;
}

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

    const archiveDir = getArchiveDir(kaiSessionId);
    mkdirSync(archiveDir, { recursive: true });
    result.archivePath = archiveDir;

    const originalPaths: string[] = [];

    for (const file of files) {
      try {
        const fileName = basename(file.path);
        const archivePath = join(archiveDir, fileName);

        try {
          renameSync(file.path, archivePath);
        } catch {
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

        const kaiSessionIds = extractKaiSessionIds(filePath);

        results.push({
          path: filePath,
          sdkSessionId,
          kaiSessionIds,
          size: stats.size,
          modifiedAt: stats.mtime,
        });
      } catch {}
    }
  } catch {}

  return results;
}

function extractKaiSessionIds(filePath: string): string[] {
  const ids = new Set<string>();

  try {
    const content = readFileSync(filePath, 'utf-8');

    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
    const matches = content.match(uuidPattern);

    if (matches) {
      const idCounts = new Map<string, number>();
      for (const id of matches) {
        const lower = id.toLowerCase();
        idCounts.set(lower, (idCounts.get(lower) || 0) + 1);
      }

      for (const [id, count] of idCounts) {
        if (count >= 3) {
          ids.add(id);
        }
      }
    }
  } catch {}

  return Array.from(ids);
}

export function identifyOrphanedSDKFiles(
  files: SDKSessionFileInfo[],
  activeSessionIds: Set<string>,
  archivedSessionIds: Set<string>
): OrphanedSDKFileInfo[] {
  const orphaned: OrphanedSDKFileInfo[] = [];

  for (const file of files) {
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

export interface StripThinkingBlocksResult {
  stripped: boolean;
  thinkingBlocksRemoved: number;
  backupPath: string | null;
}

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
      } catch {}
      return line;
    });

    if (modified) {
      result.backupPath = backupSDKSessionFile(sessionFile);

      writeFileSync(sessionFile, `${updatedLines.join('\n')}\n`, 'utf-8');
      result.stripped = true;
    }
  } catch {}

  return result;
}

export function truncateSessionFileAtMessage(
  workspacePath: string,
  sdkSessionId: string | null | undefined,
  kaiSessionId: string,
  messageUuid: string
): { truncated: boolean; linesRemoved: number } {
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

    const keptLines = lines.slice(0, truncateIndex);
    const linesRemoved = lines.length - truncateIndex;

    const newContent = keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '';
    writeFileSync(filePath, newContent);

    return { truncated: true, linesRemoved };
  } catch {
    return { truncated: false, linesRemoved: 0 };
  }
}

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
    } catch {}

    for (const match of line.matchAll(/"uuid"\s*:\s*"([^"]+)"/g)) {
      messageUuids.add(match[1]);
    }
  }
  return messageUuids;
}
