import type { SpaceTask } from '@hyperneo/shared';

export interface PrMergedGateDeps {
  resolvePrUrl: (task: SpaceTask) => string;
  requirePrUrl?: boolean;
  getPrState: (prUrl: string) => Promise<string>;
}

export function createPrMergedGate(
  deps: PrMergedGateDeps
): (task: SpaceTask) => Promise<{ ok: true } | { ok: false; error: string }> {
  const { resolvePrUrl, requirePrUrl = false, getPrState } = deps;
  return async (task) => {
    const prUrl = resolvePrUrl(task);
    if (!prUrl) {
      return requirePrUrl
        ? {
            ok: false,
            error:
              "mark_complete merge gate: could not resolve the run's PR URL. " +
              'The task stays approved until a PR link is available and its merge is confirmed.',
          }
        : { ok: true };
    }

    let state: string;
    try {
      state = await getPrState(prUrl);
    } catch (err) {
      return {
        ok: false,
        error:
          `mark_complete merge gate: could not verify the run's PR state for ${prUrl} ` +
          `(${err instanceof Error ? err.message : String(err)}). The task stays approved until the PR is confirmed merged.`,
      };
    }

    if (state === 'MERGED') return { ok: true };
    if (state === 'OPEN') {
      return {
        ok: false,
        error:
          `mark_complete merge gate: the run's PR is still OPEN (${prUrl}). ` +
          `Merge it before calling mark_complete (gh pr merge), then retry.`,
      };
    }
    return {
      ok: false,
      error:
        `mark_complete merge gate: the run's PR is ${state} (${prUrl}), not merged. ` +
        `The task stays approved; resolve the PR before calling mark_complete.`,
    };
  };
}
