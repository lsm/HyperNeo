import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SpaceWorkspaceRepository } from '../../../storage/repositories/space-workspace-repository.ts';
import { Logger } from '../../logger.ts';
import { slugify, validateSlug } from '../slug.ts';
import type { Space, CreateSpaceParams, UpdateSpaceParams } from '@hyperneo/shared';

const execAsync = promisify(exec);
const log = new Logger('SpaceManager');

export class SpaceManager {
  private spaceRepo: SpaceRepository;
  private onSpaceResumedCallbacks: Array<(spaceId: string) => void> = [];
  private onSpacePausedCallbacks: Array<(spaceId: string) => void> = [];
  private onSpaceStoppedCallbacks: Array<(spaceId: string) => void> = [];

  private workspaceRepo: SpaceWorkspaceRepository;

  constructor(private db: BunDatabase) {
    this.spaceRepo = new SpaceRepository(db);
    this.workspaceRepo = new SpaceWorkspaceRepository(db);
  }

  onSpaceResumedRegister(cb: (spaceId: string) => void): () => void {
    this.onSpaceResumedCallbacks.push(cb);
    return () => {
      this.onSpaceResumedCallbacks = this.onSpaceResumedCallbacks.filter((c) => c !== cb);
    };
  }

  onSpacePausedRegister(cb: (spaceId: string) => void): () => void {
    this.onSpacePausedCallbacks.push(cb);
    return () => {
      this.onSpacePausedCallbacks = this.onSpacePausedCallbacks.filter((c) => c !== cb);
    };
  }

  onSpaceStoppedRegister(cb: (spaceId: string) => void): () => void {
    this.onSpaceStoppedCallbacks.push(cb);
    return () => {
      this.onSpaceStoppedCallbacks = this.onSpaceStoppedCallbacks.filter((c) => c !== cb);
    };
  }

  async createSpace(params: CreateSpaceParams): Promise<Space> {
    const resolvedPath = await this.resolveAndValidatePath(params.workspacePath);
    const isGit = await this.isGitRepository(resolvedPath);

    const space = this.db.transaction(() => {
      const existing = this.spaceRepo.getSpaceByPath(resolvedPath);
      if (existing) {
        throw new Error(
          `A space already exists for workspace path: ${resolvedPath} (space id: ${existing.id})`
        );
      }

      const existingWorkspace = this.workspaceRepo.findOwnerByPath(resolvedPath);
      if (existingWorkspace) {
        throw new Error(
          `Workspace path is already claimed by space ${existingWorkspace.spaceId}: ${resolvedPath}`
        );
      }

      const existingSlugs = this.spaceRepo.getAllSlugs();
      const slug = slugify(params.name, existingSlugs);

      const newSpace = this.spaceRepo.createSpace({
        ...params,
        workspacePath: resolvedPath,
        slug,
      });

      this.workspaceRepo.create({
        spaceId: newSpace.id,
        path: resolvedPath,
        label: this.deriveLabel(resolvedPath),
        isPrimary: true,
      });

      return newSpace;
    })();

    if (!isGit) {
      log.warn(`workspace path is not a git repository: ${resolvedPath}`);
    }

    return space;
  }

  async getSpace(id: string): Promise<Space | null> {
    return this.spaceRepo.getSpace(id);
  }

  async listSpaces(includeArchived = false): Promise<Space[]> {
    return this.spaceRepo.listSpaces(includeArchived);
  }

  async updateSpace(id: string, params: UpdateSpaceParams): Promise<Space> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      throw new Error(`Space not found: ${id}`);
    }

    const updated = this.spaceRepo.updateSpace(id, params);
    if (!updated) {
      throw new Error(`Failed to update space: ${id}`);
    }

    return updated;
  }

  async pauseSpace(id: string): Promise<Space> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      throw new Error(`Space not found: ${id}`);
    }
    if (space.paused) return space;

    const paused = this.spaceRepo.pauseSpace(id);
    if (!paused) {
      throw new Error(`Failed to pause space: ${id}`);
    }

    for (const cb of this.onSpacePausedCallbacks) {
      try {
        cb(id);
      } catch (err) {
        log.error('pauseSpace: paused hook failed (non-fatal)', err);
      }
    }

    return paused;
  }

  async resumeSpace(id: string): Promise<Space> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      throw new Error(`Space not found: ${id}`);
    }
    if (!space.paused) return space;

    const resumed = this.spaceRepo.resumeSpace(id);
    if (!resumed) {
      throw new Error(`Failed to resume space: ${id}`);
    }

    if (resumed.stopped) {
      return resumed;
    }

    for (const cb of this.onSpaceResumedCallbacks) {
      try {
        cb(id);
      } catch (err) {
        log.error('resumeSpace: schedule recovery hook failed (non-fatal)', err);
      }
    }

    return resumed;
  }

  async stopSpace(id: string): Promise<Space> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      throw new Error(`Space not found: ${id}`);
    }
    if (space.stopped) return space;

    const stopped = this.spaceRepo.stopSpace(id);
    if (!stopped) {
      throw new Error(`Failed to stop space: ${id}`);
    }

    for (const cb of this.onSpaceStoppedCallbacks) {
      try {
        cb(id);
      } catch (err) {
        log.error('stopSpace: stopped hook failed (non-fatal)', err);
      }
    }

    return stopped;
  }

  async startSpace(id: string): Promise<Space> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      throw new Error(`Space not found: ${id}`);
    }
    if (!space.stopped) return space;

    const started = this.spaceRepo.startSpace(id);
    if (!started) {
      throw new Error(`Failed to start space: ${id}`);
    }

    for (const cb of this.onSpaceResumedCallbacks) {
      try {
        cb(id);
      } catch (err) {
        log.error('startSpace: schedule recovery hook failed (non-fatal)', err);
      }
    }

    return started;
  }

  async archiveSpace(id: string): Promise<Space> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      throw new Error(`Space not found: ${id}`);
    }

    const archived = this.spaceRepo.archiveSpace(id);
    if (!archived) {
      throw new Error(`Failed to archive space: ${id}`);
    }

    return archived;
  }

  async deleteSpace(id: string): Promise<boolean> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      return false;
    }

    return this.spaceRepo.deleteSpace(id);
  }

  async addSession(spaceId: string, sessionId: string): Promise<Space> {
    const updated = this.spaceRepo.addSessionToSpace(spaceId, sessionId);
    if (!updated) {
      throw new Error(`Space not found: ${spaceId}`);
    }
    return updated;
  }

  async removeSession(spaceId: string, sessionId: string): Promise<Space> {
    const updated = this.spaceRepo.removeSessionFromSpace(spaceId, sessionId);
    if (!updated) {
      throw new Error(`Space not found: ${spaceId}`);
    }
    return updated;
  }

  async getSpaceBySlug(slug: string): Promise<Space | null> {
    return this.spaceRepo.getSpaceBySlug(slug);
  }

  async updateSlug(spaceId: string, newSlug: string): Promise<Space> {
    const space = this.spaceRepo.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    const validationError = validateSlug(newSlug);
    if (validationError) {
      throw new Error(`Invalid slug: ${validationError}`);
    }

    const existing = this.spaceRepo.getSpaceBySlug(newSlug);
    if (existing && existing.id !== spaceId) {
      throw new Error(`Slug already in use: ${newSlug}`);
    }

    const updated = this.spaceRepo.updateSlug(spaceId, newSlug);
    if (!updated) {
      throw new Error(`Failed to update slug for space: ${spaceId}`);
    }

    return updated;
  }

  private deriveLabel(workspacePath: string): string {
    const trimmed = workspacePath.replace(/[\\/]+$/, '').trim();
    if (trimmed.length === 0) return '';
    const parts = trimmed.split(/[\\/]/);
    return parts[parts.length - 1] ?? '';
  }

  private async resolveAndValidatePath(workspacePath: string): Promise<string> {
    let realPath: string;
    try {
      realPath = await fs.realpath(workspacePath);
    } catch {
      throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }

    try {
      const stat = await fs.stat(realPath);
      if (!stat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${realPath}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not a directory')) {
        throw err;
      }
      throw new Error(`Cannot access workspace path: ${realPath}`);
    }

    return realPath;
  }

  private async isGitRepository(dirPath: string): Promise<boolean> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: dirPath });
      return true;
    } catch {
      return false;
    }
  }
}
