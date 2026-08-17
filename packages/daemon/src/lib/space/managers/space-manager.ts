/**
 * SpaceManager - Space management with workspace path validation
 *
 * Handles:
 * - Creating spaces with workspace path validation (symlink resolution, existence check, uniqueness)
 * - Listing, updating, archiving, and deleting spaces
 * - Session association
 */

import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import { SpaceRepository } from '../../../storage/repositories/space-repository';
import { Logger } from '../../logger';
import { slugify, validateSlug } from '../slug';
import type { Space, CreateSpaceParams, UpdateSpaceParams } from '@hyperneo/shared';

const execAsync = promisify(exec);
const log = new Logger('SpaceManager');

export class SpaceManager {
  private spaceRepo: SpaceRepository;
  private onSpaceResumedCallbacks: Array<(spaceId: string) => void> = [];
  private onSpacePausedCallbacks: Array<(spaceId: string) => void> = [];
  private onSpaceStoppedCallbacks: Array<(spaceId: string) => void> = [];

  constructor(private db: BunDatabase) {
    this.spaceRepo = new SpaceRepository(db);
  }

  /**
   * Register a callback invoked after a space transitions back to an active
   * runtime (resume from paused or start from stopped). Used to re-seed task
   * schedules whose fire jobs were skipped during the inactive window so they
   * can resume firing without a daemon restart. Multiple callbacks are allowed.
   *
   * Returns an unsubscribe function that removes the callback; runtimes should
   * call it on stop() to avoid stale callbacks dispatching through a stopped
   * instance.
   */
  onSpaceResumedRegister(cb: (spaceId: string) => void): () => void {
    this.onSpaceResumedCallbacks.push(cb);
    return () => {
      this.onSpaceResumedCallbacks = this.onSpaceResumedCallbacks.filter((c) => c !== cb);
    };
  }

  /**
   * Register a callback invoked after a space is paused. Used by the runtime to
   * maintain a sync cache of paused spaces so it can defer (not inject) external
   * events for paused spaces without an async lookup in the delivery hot path.
   */
  onSpacePausedRegister(cb: (spaceId: string) => void): () => void {
    this.onSpacePausedCallbacks.push(cb);
    return () => {
      this.onSpacePausedCallbacks = this.onSpacePausedCallbacks.filter((c) => c !== cb);
    };
  }

  /**
   * Register a callback invoked after a space is stopped. Used by the runtime
   * to keep stopped spaces in its sync "hold" cache so it can defer (not inject)
   * external events for stopped spaces without an async lookup in the delivery
   * hot path — stopped spaces must not reactivate completed tasks on a
   * check_failed the way a paused space defers and a live space would.
   */
  onSpaceStoppedRegister(cb: (spaceId: string) => void): () => void {
    this.onSpaceStoppedCallbacks.push(cb);
    return () => {
      this.onSpaceStoppedCallbacks = this.onSpaceStoppedCallbacks.filter((c) => c !== cb);
    };
  }

  /**
   * Create a new space.
   * Validates the workspace path: resolves symlinks, checks existence, ensures uniqueness.
   * Warns (but does not fail) if the path is not a git repository.
   */
  async createSpace(params: CreateSpaceParams): Promise<Space> {
    const resolvedPath = await this.resolveAndValidatePath(params.workspacePath);

    // Check uniqueness across active spaces
    const existing = this.spaceRepo.getSpaceByPath(resolvedPath);
    if (existing) {
      throw new Error(
        `A space already exists for workspace path: ${resolvedPath} (space id: ${existing.id})`
      );
    }

    // Warn if not a git repository (non-fatal)
    const isGit = await this.isGitRepository(resolvedPath);
    if (!isGit) {
      log.warn(`workspace path is not a git repository: ${resolvedPath}`);
    }

    // Auto-generate slug from space name
    const existingSlugs = this.spaceRepo.getAllSlugs();
    const slug = slugify(params.name, existingSlugs);

    return this.spaceRepo.createSpace({ ...params, workspacePath: resolvedPath, slug });
  }

  /**
   * Get a space by ID
   */
  async getSpace(id: string): Promise<Space | null> {
    return this.spaceRepo.getSpace(id);
  }

  /**
   * List spaces
   */
  async listSpaces(includeArchived = false): Promise<Space[]> {
    return this.spaceRepo.listSpaces(includeArchived);
  }

  /**
   * Update a space
   */
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

  /**
   * Pause a space (stops runtime task scheduling without archiving)
   */
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

  /**
   * Resume a paused space
   */
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

    // If the space is still stopped (pause + stop coexistence), do not fire
    // resume callbacks — the space remains inactive and the delivery hold must
    // stay so events are not injected into a stopped space.
    if (resumed.stopped) {
      return resumed;
    }

    // Re-seed any active schedules whose fire jobs were skipped while the
    // space was paused so they pick up forward progress.
    for (const cb of this.onSpaceResumedCallbacks) {
      try {
        cb(id);
      } catch (err) {
        log.error('resumeSpace: schedule recovery hook failed (non-fatal)', err);
      }
    }

    return resumed;
  }

  /**
   * Stop a space (marks stopped=true and pauses scheduling; the runtime
   * quiesce the RPC handler invokes after this — stopActiveWork —
   * interrupts active agent sessions non-destructively. Task/run statuses are
   * preserved; no auto-start on daemon restart)
   */
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

  /**
   * Start (or restart) a stopped space
   */
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

  /**
   * Archive a space
   */
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

  /**
   * Delete a space by ID
   */
  async deleteSpace(id: string): Promise<boolean> {
    const space = this.spaceRepo.getSpace(id);
    if (!space) {
      return false;
    }

    return this.spaceRepo.deleteSpace(id);
  }

  /**
   * Add a session to a space
   */
  async addSession(spaceId: string, sessionId: string): Promise<Space> {
    const updated = this.spaceRepo.addSessionToSpace(spaceId, sessionId);
    if (!updated) {
      throw new Error(`Space not found: ${spaceId}`);
    }
    return updated;
  }

  /**
   * Remove a session from a space
   */
  async removeSession(spaceId: string, sessionId: string): Promise<Space> {
    const updated = this.spaceRepo.removeSessionFromSpace(spaceId, sessionId);
    if (!updated) {
      throw new Error(`Space not found: ${spaceId}`);
    }
    return updated;
  }

  /**
   * Get a space by slug
   */
  async getSpaceBySlug(slug: string): Promise<Space | null> {
    return this.spaceRepo.getSpaceBySlug(slug);
  }

  /**
   * Update a space's slug with validation and uniqueness check.
   */
  async updateSlug(spaceId: string, newSlug: string): Promise<Space> {
    const space = this.spaceRepo.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    // Validate slug format
    const validationError = validateSlug(newSlug);
    if (validationError) {
      throw new Error(`Invalid slug: ${validationError}`);
    }

    // Check uniqueness (allow the space to keep its own slug)
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

  /**
   * Resolve symlinks and validate the workspace path exists and is a directory.
   * Returns the real (resolved) absolute path.
   */
  private async resolveAndValidatePath(workspacePath: string): Promise<string> {
    // Resolve symlinks to get the canonical real path
    let realPath: string;
    try {
      realPath = await fs.realpath(workspacePath);
    } catch {
      throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }

    // Verify it is accessible and is a directory
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

  /**
   * Check if the given path is inside a git repository (non-fatal check)
   */
  private async isGitRepository(dirPath: string): Promise<boolean> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: dirPath });
      return true;
    } catch {
      return false;
    }
  }
}
