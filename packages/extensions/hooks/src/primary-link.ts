import type { HookContext } from '@hyperneo/shared/types/workflow-hooks';

/**
 * Read the run's authoritative primary link from its artifacts.
 *
 * This is the v2 replacement for the old engine-injected `frozenPrUrl`. which
 * was PR-business baked into a generic context type. The `pr_ready` hook stamps
 * this link as an artifact; other hooks (e.g. `post_approval_only`) compare a
 * caller-supplied link against it to stop a PR-swap. The business knowledge of
 * which artifact is the run's reviewed PR lives HERE in the extensions layer,
 * not in the daemon or the shared meta type.
 *
 * `link` is the v2 field name; `url` is tolerated while the broader url→link
 * rename finishes (steps 4–5).
 */
export function getPrimaryLink(ctx: HookContext): string | undefined {
  // ctx.readArtifacts() is freshest-first; the OLDEST validated stamp is the
  // immutable identity (a later same-key stamp from another node must not swap
  // it), so take the last match rather than the first.
  let value: string | undefined;
  for (const artifact of ctx.readArtifacts()) {
    if (artifact.artifactType !== 'link' || artifact.artifactKey !== '__pr_validated__') continue;
    const data = artifact.data as Record<string, unknown> | undefined;
    const link = data?.link ?? data?.url;
    if (typeof link === 'string') value = link;
  }
  return value;
}
