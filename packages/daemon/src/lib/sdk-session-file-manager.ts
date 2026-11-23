import {
  archiveSession,
  deleteSession,
  getSessionInfo,
  unarchiveSession,
} from '@anthropic-ai/claude-agent-sdk';
import { generateUUID } from '@hyperneo/shared';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Database } from '../storage/database.ts';
import { stripDisallowedBlockKeys } from './content-block-keys.ts';

export function getSDKProjectDir(workspacePath: string): string {
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

export function removeToolResultFromSessionFile(
  workspacePath: string,
  sdkSessionId: string | null,
  messageUuid: string
): boolean {
  try {
    if (!sdkSessionId) return false;
    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
    if (!existsSync(sessionFile)) return false;

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

    rewriteSessionFile(sessionFile, `${updatedLines.join('\n')}\n`);

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
      rewriteSessionFile(sessionFile, lines.join('\n'));
    }
  } catch (error) {
    result.success = false;
    result.errors.push(`Sanitization error: ${error}`);
  }

  return result;
}

const VALIDATE_CHUNK_BYTES = 8 * 1024 * 1024;
const VALIDATED_SESSION_FILES_MAX = 64;

interface ValidatedSessionFile {
  ino: number;
  offset: number;
  head: Buffer;
  tail: Buffer;
  lines: number;
  toolUseIds: Set<string>;
  pending: SDKSessionValidationResult['orphanedToolResults'];
}

const validatedSessionFiles = new Map<string, ValidatedSessionFile>();

const sessionFileRewrites = new Map<string, number>();

function rewriteSessionFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
  validatedSessionFiles.delete(path);
  sessionFileRewrites.set(path, (sessionFileRewrites.get(path) ?? 0) + 1);
}

function scanSessionLine(state: ValidatedSessionFile, line: string, errors: string[]): void {
  if (!line.trim()) return;
  const lineIndex = state.lines++;
  if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return;
  try {
    const message = JSON.parse(line) as SDKFileMessage;
    for (const block of message.message?.content ?? []) {
      if (message.type === 'assistant' && block.type === 'tool_use' && block.id)
        state.toolUseIds.add(block.id);
      if (message.type === 'user' && block.type === 'tool_result' && block.tool_use_id)
        state.pending.push({
          toolUseId: block.tool_use_id,
          messageUuid: message.uuid || 'unknown',
          lineIndex,
        });
    }
  } catch (parseError) {
    errors.push(`Failed to parse line ${lineIndex}: ${parseError}`);
  }
}

export async function validateSDKSessionFile(
  workspacePath: string,
  sdkSessionId: string
): Promise<SDKSessionValidationResult> {
  const result: SDKSessionValidationResult = { valid: true, orphanedToolResults: [], errors: [] };
  const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
  const generation = sessionFileRewrites.get(sessionFile) ?? 0;
  let rewritten = false;
  let scanned: ValidatedSessionFile | null = null;
  try {
    if (!existsSync(sessionFile)) {
      validatedSessionFiles.delete(sessionFile);
      sessionFileRewrites.delete(sessionFile);
      return result;
    }
    const { ino, size } = statSync(sessionFile);
    const known = validatedSessionFiles.get(sessionFile);
    validatedSessionFiles.delete(sessionFile);
    const handle = await open(sessionFile, 'r');
    try {
      const head = Buffer.alloc(known ? known.head.length : 0);
      const tail = Buffer.alloc(known ? known.tail.length : 0);
      if (known && known.ino === ino && known.offset <= size) {
        await handle.read(head, 0, head.length, 0);
        await handle.read(tail, 0, tail.length, known.offset - tail.length);
      }
      const state: ValidatedSessionFile =
        known &&
        known.ino === ino &&
        known.offset <= size &&
        head.equals(known.head) &&
        tail.equals(known.tail)
          ? known
          : {
              ino,
              offset: 0,
              head: Buffer.alloc(0),
              tail: Buffer.alloc(0),
              lines: 0,
              toolUseIds: new Set(),
              pending: [],
            };
      let buffer = Buffer.alloc(Math.min(VALIDATE_CHUNK_BYTES, Math.max(1, size - state.offset)));
      let partial = '';
      while (state.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        const end = chunk.lastIndexOf(0x0a);
        if (end < 0 && state.offset + bytesRead >= size) {
          partial = chunk.toString('utf8');
          break;
        }
        if (end < 0) {
          buffer = Buffer.alloc(buffer.length * 2);
          continue;
        }
        for (const line of chunk.subarray(0, end).toString('utf8').split('\n'))
          scanSessionLine(state, line, result.errors);
        state.offset += end + 1;
      }
      state.head = Buffer.alloc(Math.min(64, state.offset));
      await handle.read(state.head, 0, state.head.length, 0);
      state.tail = Buffer.alloc(Math.min(64, state.offset));
      await handle.read(state.tail, 0, state.tail.length, state.offset - state.tail.length);
      state.pending = state.pending.filter((ref) => !state.toolUseIds.has(ref.toolUseId));
      scanned = state;
      const view = partial
        ? { ...state, toolUseIds: new Set(state.toolUseIds), pending: [...state.pending] }
        : state;
      if (partial) scanSessionLine(view, partial, result.errors);
      result.orphanedToolResults = view.pending.filter(
        (ref) => !view.toolUseIds.has(ref.toolUseId)
      );
      result.valid = result.orphanedToolResults.length === 0;
    } finally {
      await handle.close();
    }
    rewritten = (sessionFileRewrites.get(sessionFile) ?? 0) !== generation;
    if (scanned && !rewritten) validatedSessionFiles.set(sessionFile, scanned);
    for (const stale of validatedSessionFiles.keys()) {
      if (validatedSessionFiles.size <= VALIDATED_SESSION_FILES_MAX) break;
      validatedSessionFiles.delete(stale);
    }
  } catch (error) {
    result.valid = false;
    result.errors.push(`Validation error: ${error}`);
  }
  if (rewritten) return validateSDKSessionFile(workspacePath, sdkSessionId);
  return result;
}

const BACKUPS_PER_SESSION = 2;

function backupSDKSessionFile(sessionFilePath: string): string | null {
  try {
    const backupDir = join(dirname(sessionFilePath), 'backups');
    mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = sessionFilePath.split('/').pop() || 'session.jsonl';
    const backupPath = join(backupDir, `${fileName}.backup.${timestamp}`);

    copyFileSync(sessionFilePath, backupPath);
    const ownBackups = readdirSync(backupDir)
      .filter((name) => name.startsWith(`${fileName}.backup.`))
      .sort();
    for (const surplus of ownBackups.slice(0, -BACKUPS_PER_SESSION)) {
      unlinkSync(join(backupDir, surplus));
    }
    return backupPath;
  } catch {
    return null;
  }
}

function findRequestBlobToolUse(lines: string[], toolUseId: string): SDKFileMessage | null {
  for (const line of lines) {
    if (!line.includes('"api-request-blob"') || !line.includes(toolUseId)) continue;
    let blob: SDKFileMessage;
    try {
      blob = JSON.parse(line) as SDKFileMessage;
    } catch {
      continue;
    }
    const content = blob.message?.content;
    if (
      blob.type === 'api-request-blob' &&
      blob.message?.role === 'assistant' &&
      Array.isArray(content) &&
      content.some((block) => block.type === 'tool_use' && block.id === toolUseId)
    ) {
      return { type: 'assistant', uuid: generateUUID(), message: blob.message };
    }
  }
  return null;
}

function survivingParentUuid(
  lines: string[],
  lineIndex: number,
  parentUuid: string | undefined
): string | undefined {
  if (parentUuid && lines.some((line) => line.includes(`"uuid":"${parentUuid}"`))) {
    return parentUuid;
  }
  for (let i = lineIndex - 1; i >= 0; i--) {
    try {
      const line = JSON.parse(lines[i]) as SDKFileMessage;
      if (line.uuid && !line.isSidechain) return line.uuid;
    } catch {}
  }
  return undefined;
}

export async function repairSDKSessionFile(
  workspacePath: string,
  sdkSessionId: string,
  kaiSessionId: string,
  db: Database
): Promise<SDKSessionRepairResult> {
  const result: SDKSessionRepairResult = {
    success: false,
    backupPath: null,
    repairedCount: 0,
    errors: [],
  };

  try {
    const validation = await validateSDKSessionFile(workspacePath, sdkSessionId);

    if (validation.valid) {
      result.success = true;
      return result;
    }

    if (validation.errors.length > 0) {
      result.errors.push(...validation.errors);
    }

    const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);

    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    const insertions: Array<{ lineIndex: number; message: string }> = [];
    const recoveredToolUseIds = new Set<string>();
    const restoredTail = new Map<number, string>();

    for (const orphan of validation.orphanedToolResults) {
      if (recoveredToolUseIds.has(orphan.toolUseId)) {
        result.repairedCount++;
        continue;
      }
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

      missingAssistantMsg ??= findRequestBlobToolUse(lines, orphan.toolUseId);

      if (!missingAssistantMsg) {
        result.errors.push(
          `Could not find tool_use message for ${orphan.toolUseId} in HyperNeo DB or transcript`
        );
        continue;
      }

      for (const block of missingAssistantMsg.message?.content ?? []) {
        if (block.type === 'tool_use' && block.id) recoveredToolUseIds.add(block.id);
      }

      const orphanedLine = JSON.parse(lines[orphan.lineIndex]) as SDKFileMessage;

      const repairedMsg: SDKFileMessage = {
        parentUuid:
          restoredTail.get(orphan.lineIndex) ??
          survivingParentUuid(lines, orphan.lineIndex, orphanedLine.parentUuid),
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
        restoredTail.set(orphan.lineIndex, missingAssistantMsg.uuid);
        const updatedOrphan = {
          ...orphanedLine,
          parentUuid: missingAssistantMsg.uuid,
        };
        lines[orphan.lineIndex] = JSON.stringify(updatedOrphan);
      }

      result.repairedCount++;
    }

    if (
      result.repairedCount === 0 ||
      result.repairedCount !== validation.orphanedToolResults.length
    ) {
      return result;
    }

    result.backupPath = backupSDKSessionFile(sessionFile);
    if (!result.backupPath) {
      result.errors.push('Failed to create backup - aborting repair');
      return result;
    }

    const ordered = insertions
      .map((insertion, order) => ({ ...insertion, order }))
      .sort((a, b) => b.lineIndex - a.lineIndex || b.order - a.order);
    for (const insertion of ordered) {
      lines.splice(insertion.lineIndex, 0, insertion.message);
    }

    rewriteSessionFile(sessionFile, `${lines.join('\n')}\n`);

    result.success = true;
  } catch (error) {
    result.errors.push(`Repair error: ${error}`);
  }

  return result;
}

export interface SDKTranscriptCheck {
  valid: boolean;
  repairError?: string;
}

const validatingSessionFiles = new Map<string, Promise<SDKTranscriptCheck>>();

export function validateAndRepairSDKSession(
  workspacePath: string,
  sdkSessionId: string,
  kaiSessionId: string,
  db: Database
): Promise<SDKTranscriptCheck> {
  const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
  const running = validatingSessionFiles.get(sessionFile);
  if (running) return running;
  const run = validateAndRepairSessionFile(workspacePath, sdkSessionId, kaiSessionId, db).finally(
    () => validatingSessionFiles.delete(sessionFile)
  );
  validatingSessionFiles.set(sessionFile, run);
  return run;
}

async function validateAndRepairSessionFile(
  workspacePath: string,
  sdkSessionId: string,
  kaiSessionId: string,
  db: Database
): Promise<SDKTranscriptCheck> {
  const sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
  if (!existsSync(sessionFile)) {
    return { valid: false };
  }

  const validation = await validateSDKSessionFile(workspacePath, sdkSessionId);

  if (validation.valid) {
    return { valid: true };
  }

  const repair = await repairSDKSessionFile(workspacePath, sdkSessionId, kaiSessionId, db);

  if (repair.success) {
    return { valid: true };
  }

  return { valid: false, repairError: repair.errors.join('; ') || 'repair failed' };
}

export async function archiveSDKSessions(
  workspacePath: string,
  sdkSessionIds: readonly string[]
): Promise<number> {
  let archived = 0;
  for (const id of sdkSessionIds)
    if (await ifSessionFound(() => archiveSession(id, { dir: workspacePath }))) archived++;
  return archived;
}

export async function withUnarchivedSDKSessions(
  workspacePath: string,
  sdkSessionIds: readonly string[],
  commit: () => Promise<boolean>
): Promise<boolean> {
  const restored: string[] = [];
  let committed = false;
  const options = { dir: workspacePath };
  try {
    for (const id of sdkSessionIds) {
      if (!(await getSessionInfo(id, options))?.archived) continue;
      if (await ifSessionFound(() => unarchiveSession(id, options))) restored.push(id);
    }
    committed = await commit();
    return committed;
  } finally {
    if (!committed) await archiveSDKSessions(workspacePath, restored);
  }
}

export async function deleteSDKSessions(
  workspacePath: string,
  sdkSessionIds: readonly string[]
): Promise<number> {
  let deleted = 0;
  for (const id of sdkSessionIds) {
    if (await ifSessionFound(() => deleteSession(id, { dir: workspacePath }))) deleted++;
    const filePath = getSDKSessionFilePath(workspacePath, id);
    validatedSessionFiles.delete(filePath);
    sessionFileRewrites.delete(filePath);
  }
  return deleted;
}

async function ifSessionFound(mutate: () => Promise<void>): Promise<boolean> {
  try {
    await mutate();
    return true;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return false;
    throw error;
  }
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
          const filtered = original
            .filter((block: { type: string }) => block.type !== 'thinking')
            .map(stripDisallowedBlockKeys);

          if (
            filtered.length < original.length ||
            filtered.some((block, index) => block !== original[index])
          ) {
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

      rewriteSessionFile(sessionFile, `${updatedLines.join('\n')}\n`);
      result.stripped = true;
    }
  } catch {}

  return result;
}

export function truncateSessionFileAtMessage(
  workspacePath: string,
  sdkSessionId: string | null | undefined,
  messageUuid: string
): { truncated: boolean; linesRemoved: number } {
  const filePath = resolveSDKSessionFilePath(workspacePath, sdkSessionId);
  if (!filePath) {
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
    rewriteSessionFile(filePath, newContent);

    return { truncated: true, linesRemoved };
  } catch {
    return { truncated: false, linesRemoved: 0 };
  }
}

export function messageUuidExistsInSessionFile(
  workspacePath: string,
  sdkSessionId: string | null | undefined,
  messageUuid: string
): boolean {
  const messageUuids = readMessageUuidsFromSessionFile(workspacePath, sdkSessionId);
  return messageUuids?.has(messageUuid) ?? false;
}

function readMessageUuidsFromSessionFile(
  workspacePath: string,
  sdkSessionId: string | null | undefined
): Set<string> | null {
  const filePath = resolveSDKSessionFilePath(workspacePath, sdkSessionId);
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
  sdkSessionId: string | null | undefined
): string | null {
  if (!sdkSessionId) return null;
  const filePath = getSDKSessionFilePath(workspacePath, sdkSessionId);
  return existsSync(filePath) ? filePath : null;
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
