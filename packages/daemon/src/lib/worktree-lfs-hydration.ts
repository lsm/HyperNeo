import superpipe, { type PipelineAPI } from 'superpipe';
import { worktreeDeclaresLfsAttributes } from './worktree-lfs.ts';

export const LFS_PULL_TIMEOUT_MS = 1_800_000;

export interface WorktreeLfsHydrationDeps {
  listLfsTrackedFiles(): Promise<string>;
  listAttrLfsPaths(): Promise<string>;
  indexHasLfsPointer(): Promise<boolean>;
  pullLfsObjects(): Promise<void>;
}

export type WorktreeLfsHydrationOutcome =
  | { action: 'pulled' }
  | { action: 'clean' }
  | { action: 'skipped'; cause: string }
  | { action: 'failed'; cause: string };

interface WorktreeLfsHydrationCtx {
  deps: WorktreeLfsHydrationDeps;
  listing?: string;
  probeError?: unknown;
  needPull?: boolean;
  outcome?: WorktreeLfsHydrationOutcome;
}

function probeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeListing(ctx: WorktreeLfsHydrationCtx): Promise<WorktreeLfsHydrationCtx> {
  try {
    return { ...ctx, listing: await ctx.deps.listLfsTrackedFiles() };
  } catch (err) {
    return { ...ctx, probeError: err };
  }
}

function decideNeedPull(ctx: WorktreeLfsHydrationCtx): WorktreeLfsHydrationCtx {
  if (!ctx.probeError && (ctx.listing ?? '').trim().length > 0) {
    return { ...ctx, needPull: true };
  }
  return ctx;
}

async function evaluateFailedProbe(ctx: WorktreeLfsHydrationCtx): Promise<WorktreeLfsHydrationCtx> {
  if (!ctx.probeError) return ctx;
  const declared = await worktreeDeclaresLfsAttributes(
    () => ctx.deps.listAttrLfsPaths(),
    () => ctx.deps.indexHasLfsPointer()
  );
  const cause = probeCause(ctx.probeError);
  if (declared) {
    return { ...ctx, outcome: { action: 'failed', cause } };
  }
  return { ...ctx, outcome: { action: 'skipped', cause } };
}

function decideClean(ctx: WorktreeLfsHydrationCtx): WorktreeLfsHydrationCtx {
  if (!ctx.needPull) {
    return { ...ctx, outcome: { action: 'clean' } };
  }
  return ctx;
}

async function pullObjects(ctx: WorktreeLfsHydrationCtx): Promise<WorktreeLfsHydrationCtx> {
  await ctx.deps.pullLfsObjects();
  return { ...ctx, outcome: { action: 'pulled' } };
}

function hasOutcome(ctx: WorktreeLfsHydrationCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (superpipe({ hasOutcome })('worktree-lfs-hydration') as PipelineAPI)
  .input(['ctx'])
  .pipe(probeListing, 'ctx', 'ctx')
  .pipe(decideNeedPull, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(evaluateFailedProbe, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(decideClean, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(pullObjects, 'ctx', 'ctx')
  .endAsync('ctx') as (input: WorktreeLfsHydrationCtx) => Promise<WorktreeLfsHydrationCtx>;

export function runWorktreeLfsHydration(
  deps: WorktreeLfsHydrationDeps
): Promise<WorktreeLfsHydrationOutcome> {
  return run({ deps }).then(
    (ctx) => ctx.outcome ?? { action: 'failed', cause: 'hydration ended without an outcome' }
  );
}
