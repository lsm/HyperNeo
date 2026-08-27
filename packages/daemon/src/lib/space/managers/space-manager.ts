import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository.ts';
import {
  SpaceWorkspaceRepository,
  type SpaceWorkspaceRecord,
} from '../../../storage/repositories/space-workspace-repository.ts';
import {
  buildRegistrySnapshot,
  SpaceWorkspaceManager,
  WorkspaceRegistrationError,
} from './space-workspace-manager.ts';
import {
  checkWorkspaceRegistryGates,
  nodeWorkspaceValidationIo,
  validateWorkspaceRegistration,
  type WorkspaceRegistrySnapshot,
  type WorkspaceValidationIo,
} from '../workspaces/workspace-validation-pipeline.ts';
import { Logger } from '../../logger.ts';
import { slugify, validateSlug } from '../slug.ts';
import type { Space, CreateSpaceParams, UpdateSpaceParams } from '@hyperneo/shared';

const execAsync = promisify(exec);
const log = new Logger('SpaceManager');

function deriveLabel(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/, '').trim();
  if (trimmed.length === 0) return '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

interface AdditionalWorkspacePlan {
  path: string;
  label?: string;
}

interface CreateSpaceCtx {
  db: BunDatabase;
  spaceRepo: SpaceRepository;
  workspaceRepo: SpaceWorkspaceRepository;
  params: CreateSpaceParams;
  io?: WorkspaceValidationIo;
  resolvedPath?: string;
  isGit?: boolean;
  space?: Space;
  additionalWorkspacePlans?: AdditionalWorkspacePlan[];
  error?: Error;
}

async function resolveAndValidatePath(ctx: CreateSpaceCtx): Promise<CreateSpaceCtx> {
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(ctx.params.workspacePath);
  } catch {
    return {
      ...ctx,
      error: new Error(`Workspace path does not exist: ${ctx.params.workspacePath}`),
    };
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return { ...ctx, error: new Error(`Workspace path is not a directory: ${resolvedPath}`) };
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('not a directory')) {
      return { ...ctx, error: err };
    }
    return { ...ctx, error: new Error(`Cannot access workspace path: ${resolvedPath}`) };
  }

  return { ...ctx, resolvedPath };
}

async function classifyGit(ctx: CreateSpaceCtx): Promise<CreateSpaceCtx> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: ctx.resolvedPath });
    return { ...ctx, isGit: true };
  } catch {
    return { ...ctx, isGit: false };
  }
}

function createSpaceAtomic(ctx: CreateSpaceCtx): CreateSpaceCtx {
  try {
    const space = ctx.db.transaction(() => {
      const existing = ctx.spaceRepo.getSpaceByPath(ctx.resolvedPath!);
      if (existing) {
        throw new Error(
          `A space already exists for workspace path: ${ctx.resolvedPath} (space id: ${existing.id})`
        );
      }

      const existingWorkspace = ctx.workspaceRepo.findOwnerByPath(ctx.resolvedPath!);
      if (existingWorkspace) {
        throw new Error(
          `Workspace path is already claimed by space ${existingWorkspace.spaceId}: ${ctx.resolvedPath}`
        );
      }

      const existingSlugs = ctx.spaceRepo.getAllSlugs();
      const slug = slugify(ctx.params.name, existingSlugs);

      const newSpace = ctx.spaceRepo.createSpace({
        ...ctx.params,
        workspacePath: ctx.resolvedPath!,
        slug,
      });

      ctx.workspaceRepo.create({
        spaceId: newSpace.id,
        path: ctx.resolvedPath!,
        label: deriveLabel(ctx.resolvedPath!),
        isPrimary: true,
      });

      return newSpace;
    })() as Space;
    return { ...ctx, space };
  } catch (err) {
    return { ...ctx, error: err as Error };
  }
}

function warnIfNotGit(ctx: CreateSpaceCtx): CreateSpaceCtx {
  if (ctx.isGit === false) {
    log.warn(`workspace path is not a git repository: ${ctx.resolvedPath}`);
  }
  return ctx;
}

async function validateAdditionalWorkspaces(ctx: CreateSpaceCtx): Promise<CreateSpaceCtx> {
  const secondaries = ctx.params.additionalWorkspaces ?? [];
  if (secondaries.length === 0 || !ctx.space) return ctx;
  const io = ctx.io ?? nodeWorkspaceValidationIo;
  try {
    let snapshot: WorkspaceRegistrySnapshot = buildRegistrySnapshot(
      ctx.spaceRepo,
      ctx.workspaceRepo,
      ctx.space.id
    );
    const plans: AdditionalWorkspacePlan[] = [];
    for (const secondary of secondaries) {
      const verdict = await validateWorkspaceRegistration(io, snapshot, {
        spaceId: ctx.space.id,
        rawPath: secondary.path,
      });
      if (!verdict.accepted) {
        return {
          ...ctx,
          error: new WorkspaceRegistrationError(verdict.message, verdict.reason, verdict),
        };
      }
      plans.push({ path: verdict.canonicalPath, label: secondary.label });
      snapshot = {
        claims: [
          ...snapshot.claims,
          { spaceId: ctx.space.id, path: verdict.canonicalPath, source: 'registered_workspace' },
        ],
        workspaceCountForSpace: snapshot.workspaceCountForSpace + 1,
      };
    }
    return { ...ctx, additionalWorkspacePlans: plans };
  } catch (err) {
    return { ...ctx, error: err as Error };
  }
}

function insertAdditionalWorkspaces(ctx: CreateSpaceCtx): CreateSpaceCtx {
  const plans = ctx.additionalWorkspacePlans ?? [];
  if (ctx.error || plans.length === 0) return ctx;
  try {
    ctx.db.transaction(() => {
      const spaceId = ctx.space!.id;
      let snapshot = buildRegistrySnapshot(ctx.spaceRepo, ctx.workspaceRepo, spaceId);
      for (const plan of plans) {
        const verdict = checkWorkspaceRegistryGates(snapshot, {
          spaceId,
          canonicalPath: plan.path,
        });
        if (!verdict.accepted) {
          throw new WorkspaceRegistrationError(verdict.message, verdict.reason, verdict);
        }
        ctx.workspaceRepo.create({
          spaceId,
          path: plan.path,
          label: plan.label,
          isPrimary: false,
        });
        snapshot = {
          claims: [
            ...snapshot.claims,
            { spaceId, path: plan.path, source: 'registered_workspace' },
          ],
          workspaceCountForSpace: snapshot.workspaceCountForSpace + 1,
        };
      }
    }, 'immediate')();
  } catch (err) {
    return { ...ctx, error: err as Error };
  }
  return ctx;
}

function rollbackFailedCreate(ctx: CreateSpaceCtx): CreateSpaceCtx {
  if (!ctx.error || !ctx.space) return ctx;
  const spaceId = ctx.space.id;
  try {
    ctx.db.transaction(() => {
      for (const record of ctx.workspaceRepo.listBySpace(spaceId)) {
        ctx.workspaceRepo.delete(spaceId, record.id);
      }
      ctx.spaceRepo.deleteSpace(spaceId);
    })();
    return { ...ctx, space: undefined };
  } catch (err) {
    log.error(`failed to roll back space creation for ${spaceId}`, err);
    return ctx;
  }
}

const runCreateSpace = (
  superpipe({
    hasError: (ctx: CreateSpaceCtx) => ctx.error !== undefined,
    hasResolvedPath: (ctx: CreateSpaceCtx) => ctx.resolvedPath !== undefined,
    hasSpace: (ctx: CreateSpaceCtx) => ctx.space !== undefined,
  })('space-creation') as PipelineAPI
)
  .input(['ctx'])
  .pipe(resolveAndValidatePath, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe('hasResolvedPath', 'ctx')
  .pipe(classifyGit, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createSpaceAtomic, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe('hasSpace', 'ctx')
  .pipe(validateAdditionalWorkspaces, 'ctx', 'ctx')
  .pipe(insertAdditionalWorkspaces, 'ctx', 'ctx')
  .pipe(rollbackFailedCreate, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(warnIfNotGit, 'ctx', 'ctx')
  .endAsync('ctx') as (input: CreateSpaceCtx) => Promise<CreateSpaceCtx>;

export class SpaceManager {
  private spaceRepo: SpaceRepository;
  private workspaceRepo: SpaceWorkspaceRepository;
  private taskRepo: SpaceTaskRepository;
  private goalRepo: SpaceGoalRepository;
  private workspaceManager: SpaceWorkspaceManager;
  private onSpaceResumedCallbacks: Array<(spaceId: string) => void> = [];
  private onSpacePausedCallbacks: Array<(spaceId: string) => void> = [];
  private onSpaceStoppedCallbacks: Array<(spaceId: string) => void> = [];

  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {
    this.spaceRepo = new SpaceRepository(db);
    this.workspaceRepo = new SpaceWorkspaceRepository(db, reactiveDb);
    this.taskRepo = new SpaceTaskRepository(db);
    this.goalRepo = new SpaceGoalRepository(db);
    this.workspaceManager = new SpaceWorkspaceManager({
      spaces: this.spaceRepo,
      workspaces: this.workspaceRepo,
      sessionReferences: new SessionRepository(db),
      transaction: <T>(fn: () => T) => db.transaction(fn, 'immediate')(),
      taskReferences: {
        countActiveTasksByWorkspacePath: (spaceId, workspacePath) =>
          this.taskRepo.countNonArchivedByWorkspacePath(spaceId, workspacePath),
      },
      goalReferences: {
        countActiveGoalsByWorkspacePath: (spaceId, workspacePath) =>
          this.goalRepo.countNonArchivedByWorkspacePath(spaceId, workspacePath),
      },
    });
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
    const result = await runCreateSpace({
      db: this.db,
      spaceRepo: this.spaceRepo,
      workspaceRepo: this.workspaceRepo,
      params,
    });

    if (result.error) {
      throw result.error;
    }
    return result.space!;
  }

  registerWorkspace(
    spaceId: string,
    rawPath: string,
    label?: string
  ): Promise<SpaceWorkspaceRecord> {
    return this.workspaceManager.registerWorkspace(spaceId, rawPath, label);
  }

  removeWorkspace(spaceId: string, workspaceId: string): boolean {
    return this.workspaceManager.removeWorkspace(spaceId, workspaceId);
  }

  listWorkspaces(spaceId: string): SpaceWorkspaceRecord[] {
    return this.workspaceManager.listWorkspaces(spaceId);
  }

  async resolveRegisteredWorkspacePath(spaceId: string, rawPath: string): Promise<string> {
    return this.workspaceManager.resolveRegisteredWorkspacePath(spaceId, rawPath);
  }

  updateWorkspaceLabel(spaceId: string, workspaceId: string, label: string): boolean {
    return this.workspaceManager.updateWorkspaceLabel(spaceId, workspaceId, label);
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

    const deleted = this.spaceRepo.deleteSpace(id);
    if (deleted) {
      this.reactiveDb?.notifyChange('space_workspaces', { spaceId: id });
    }
    return deleted;
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
}
