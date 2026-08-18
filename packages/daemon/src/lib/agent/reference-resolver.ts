import { join, normalize, relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { FileManager } from '../file-manager.ts';
import type {
  ReferenceMention,
  ResolvedReference,
  ResolvedFileReference,
  ResolvedFolderReference,
  ResolvedTaskReference,
  ResolvedGoalReference,
  ReferenceType,
  SpaceTask,
} from '@hyperneo/shared';
import type { NeoTask, RoomGoal } from '@hyperneo/shared/types/neo';
import { REFERENCE_PATTERN } from '@hyperneo/shared';
import { Logger } from '../logger.ts';

const log = new Logger('reference-resolver');

const MAX_FILE_SIZE = 50 * 1024;

const MAX_FOLDER_ENTRIES = 200;

const ROOM_TASK_PREFIX = 't-';
const SPACE_TASK_PREFIX = 'st-';

export interface TaskRepoLike {
  getTaskByShortId(roomId: string, shortId: string): NeoTask | null;
}

export interface GoalRepoLike {
  getGoalByShortId(roomId: string, shortId: string): RoomGoal | null;
}

export interface SpaceTaskRepoLike {
  getTask(id: string): SpaceTask | null;
}

export interface ReferenceResolverDeps {
  taskRepo?: TaskRepoLike;
  goalRepo?: GoalRepoLike;
  spaceTaskRepo?: SpaceTaskRepoLike;
}

export interface ResolutionContext {
  roomId?: string;
  spaceId?: string;
  workspacePath: string;
}

export class ReferenceResolver {
  private readonly taskRepo?: TaskRepoLike;
  private readonly goalRepo?: GoalRepoLike;
  private readonly spaceTaskRepo?: SpaceTaskRepoLike;

  constructor(deps: ReferenceResolverDeps = {}) {
    this.taskRepo = deps.taskRepo;
    this.goalRepo = deps.goalRepo;
    this.spaceTaskRepo = deps.spaceTaskRepo;
  }
  extractReferences(text: string): ReferenceMention[] {
    const mentions: ReferenceMention[] = [];
    const seen = new Set<string>();
    const pattern = new RegExp(REFERENCE_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const [fullMatch, typeRaw, id] = match;

      if (!this.isValidReferenceType(typeRaw)) {
        continue;
      }

      if (seen.has(fullMatch)) continue;
      seen.add(fullMatch);

      mentions.push({
        type: typeRaw as ReferenceType,
        id,
        displayText: fullMatch,
      });
    }

    return mentions;
  }

  async resolveReference(
    mention: ReferenceMention,
    context: ResolutionContext
  ): Promise<ResolvedReference | null> {
    switch (mention.type) {
      case 'file':
        return this.resolveFile(mention.id, context);
      case 'folder':
        return this.resolveFolder(mention.id, context);
      case 'task':
        return this.resolveTask(mention.id, context);
      case 'goal':
        return Promise.resolve(this.resolveGoal(mention.id, context));
      default: {
        const _exhaustive: never = mention.type;
        log.warn(`Unknown reference type: ${_exhaustive}`);
        return null;
      }
    }
  }

  async resolveAllReferences(
    text: string,
    context: ResolutionContext
  ): Promise<Record<string, ResolvedReference>> {
    const mentions = this.extractReferences(text);
    const result: Record<string, ResolvedReference> = {};

    for (const mention of mentions) {
      try {
        const resolved = await this.resolveReference(mention, context);
        if (resolved !== null) {
          result[mention.displayText] = resolved;
        }
      } catch (err) {
        log.warn(`Failed to resolve reference ${mention.displayText}: ${err}`);
      }
    }

    return result;
  }

  private validatePath(filePath: string): void {
    if (filePath === '' || filePath.trim() === '') {
      throw new Error('Path must not be empty');
    }

    if (isAbsolute(filePath)) {
      throw new Error(`Absolute paths are not allowed: ${filePath}`);
    }

    const segments = filePath.split(/[/\\]/);
    if (segments.includes('..')) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
  }

  private async checkSymlink(absolutePath: string, workspacePath: string): Promise<void> {
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(absolutePath);
    } catch {
      return;
    }

    let resolvedWorkspace: string;
    try {
      resolvedWorkspace = await realpath(workspacePath);
    } catch {
      resolvedWorkspace = normalize(workspacePath);
    }

    const rel = relative(resolvedWorkspace, resolvedPath);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Symlink points outside workspace: ${absolutePath} → ${resolvedPath}`);
    }
  }

  private async resolveFile(
    path: string,
    context: ResolutionContext
  ): Promise<ResolvedFileReference | null> {
    try {
      this.validatePath(path);
    } catch (err) {
      log.warn(`Path validation failed for file reference "${path}": ${err}`);
      return null;
    }

    const absolutePath = normalize(join(context.workspacePath, path));
    try {
      await this.checkSymlink(absolutePath, context.workspacePath);
    } catch (err) {
      log.warn(`Symlink validation failed for file reference "${path}": ${err}`);
      return null;
    }

    const fm = new FileManager(context.workspacePath);
    let utfResult: { path: string; content: string; encoding: string; size: number; mtime: string };

    try {
      utfResult = await fm.readFile(path, 'utf-8');
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.message.includes('File not found') ||
          err.message.includes('Path is a directory') ||
          err.message.includes('Path traversal')
        ) {
          return null;
        }
      }
      log.warn(`Unexpected error reading file "${path}": ${err}`);
      return null;
    }

    const isBinary = utfResult.content.includes('\x00');

    if (isBinary) {
      return {
        type: 'file',
        id: path,
        data: {
          path,
          content: null,
          binary: true,
          truncated: false,
          size: utfResult.size,
          mtime: utfResult.mtime,
        },
      };
    }

    const oversized = utfResult.size > MAX_FILE_SIZE;
    const content = oversized
      ? this.truncateAtLineBoundary(utfResult.content, MAX_FILE_SIZE)
      : utfResult.content;

    return {
      type: 'file',
      id: path,
      data: {
        path,
        content,
        binary: false,
        truncated: oversized,
        size: utfResult.size,
        mtime: utfResult.mtime,
      },
    };
  }

  private truncateAtLineBoundary(content: string, maxBytes: number): string {
    if (Buffer.byteLength(content, 'utf-8') <= maxBytes) {
      return content;
    }

    const lines = content.split('\n');
    let byteCount = 0;
    let lastValidLineIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1;
      if (byteCount + lineBytes > maxBytes) break;
      byteCount += lineBytes;
      lastValidLineIndex = i + 1;
    }

    if (lastValidLineIndex === 0) {
      const firstLine = lines[0];
      return Buffer.from(firstLine, 'utf-8').slice(0, maxBytes).toString('utf-8');
    }

    const joined = lines.slice(0, lastValidLineIndex).join('\n');
    return lastValidLineIndex < lines.length ? joined + '\n' : joined;
  }

  private async resolveFolder(
    path: string,
    context: ResolutionContext
  ): Promise<ResolvedFolderReference | null> {
    try {
      this.validatePath(path);
    } catch (err) {
      log.warn(`Path validation failed for folder reference "${path}": ${err}`);
      return null;
    }

    const absolutePath = normalize(join(context.workspacePath, path));
    try {
      await this.checkSymlink(absolutePath, context.workspacePath);
    } catch (err) {
      log.warn(`Symlink validation failed for folder reference "${path}": ${err}`);
      return null;
    }

    const fm = new FileManager(context.workspacePath);
    let files: Awaited<ReturnType<FileManager['listDirectory']>>;

    try {
      files = await fm.listDirectory(path);
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.message.includes('Directory not found') ||
          err.message.includes('Path is not a directory') ||
          err.message.includes('Path traversal')
        ) {
          return null;
        }
      }
      log.warn(`Unexpected error listing folder "${path}": ${err}`);
      return null;
    }

    const entries = files.slice(0, MAX_FOLDER_ENTRIES).map((f) => ({
      name: f.name,
      path: f.path,
      type: f.type,
    }));

    return {
      type: 'folder',
      id: path,
      data: {
        path,
        entries,
      },
    };
  }

  private resolveTask(id: string, context: ResolutionContext): ResolvedTaskReference | null {
    if (id.startsWith(SPACE_TASK_PREFIX)) {
      return this.resolveSpaceTask(id, context);
    }
    if (id.startsWith(ROOM_TASK_PREFIX)) {
      return this.resolveRoomTask(id, context);
    }
    log.warn(
      `Unrecognized task reference format: "${id}" (expected ${ROOM_TASK_PREFIX} or ${SPACE_TASK_PREFIX} prefix)`
    );
    return null;
  }

  private resolveRoomTask(
    shortId: string,
    context: ResolutionContext
  ): ResolvedTaskReference | null {
    if (!context.roomId) {
      log.warn(`Cannot resolve room task "${shortId}": session has no room context`);
      return null;
    }
    if (!this.taskRepo) {
      log.warn('Cannot resolve room task: TaskRepository not injected');
      return null;
    }
    const task = this.taskRepo.getTaskByShortId(context.roomId, shortId);
    if (!task) {
      log.warn(`Room task not found: "${shortId}" in room "${context.roomId}"`);
      return null;
    }
    if (task.roomId !== context.roomId) {
      log.warn(
        `Cross-room reference rejected: task "${shortId}" belongs to room "${task.roomId}", not "${context.roomId}"`
      );
      return null;
    }
    return { type: 'task', id: task.id, data: task };
  }

  private resolveSpaceTask(id: string, context: ResolutionContext): ResolvedTaskReference | null {
    if (!context.spaceId) {
      log.warn(`Cannot resolve space task "${id}": session has no space context`);
      return null;
    }
    if (!this.spaceTaskRepo) {
      log.warn('Cannot resolve space task: SpaceTaskRepository not injected');
      return null;
    }
    const uuid = id.slice(SPACE_TASK_PREFIX.length);
    const task = this.spaceTaskRepo.getTask(uuid);
    if (!task) {
      log.warn(`Space task not found: UUID "${uuid}" (from reference "${id}")`);
      return null;
    }
    if (task.spaceId !== context.spaceId) {
      log.warn(
        `Cross-space reference rejected: task "${id}" belongs to space "${task.spaceId}", not "${context.spaceId}"`
      );
      return null;
    }
    return { type: 'task', id: task.id, data: task };
  }

  private resolveGoal(shortId: string, context: ResolutionContext): ResolvedGoalReference | null {
    if (!context.roomId) {
      log.warn(`Cannot resolve goal "${shortId}": session has no room context`);
      return null;
    }
    if (!this.goalRepo) {
      log.warn('Cannot resolve goal: GoalRepository not injected');
      return null;
    }
    const goal = this.goalRepo.getGoalByShortId(context.roomId, shortId);
    if (!goal) {
      log.warn(`Goal not found: "${shortId}" in room "${context.roomId}"`);
      return null;
    }
    if (goal.roomId !== context.roomId) {
      log.warn(
        `Cross-room reference rejected: goal "${shortId}" belongs to room "${goal.roomId}", not "${context.roomId}"`
      );
      return null;
    }
    return { type: 'goal', id: goal.id, data: goal };
  }

  private isValidReferenceType(type: string): type is ReferenceType {
    return type === 'task' || type === 'goal' || type === 'file' || type === 'folder';
  }
}
