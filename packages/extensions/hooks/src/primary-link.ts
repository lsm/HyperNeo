import type { HookContext } from '@hyperneo/shared/types/workflow-hooks';
import { parsePrLink } from './github';

/**
 * The engine-reserved artifact key the `pr_ready` hook stamps the run's
 * authoritative reviewed-PR identity under. `save_artifact` rejects `__`-prefixed
 * keys, so only the engine can write this. Exported so every reader/writer of
 * the validated identity (pr-ready, this module, the daemon's
 * coding-artifact-profile) shares one literal instead of scattering it.
 */
export const VALIDATED_PR_ARTIFACT_KEY = '__pr_validated__';

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
    if (artifact.artifactType !== 'link' || artifact.artifactKey !== VALIDATED_PR_ARTIFACT_KEY)
      continue;
    const data = artifact.data as Record<string, unknown> | undefined;
    const link = data?.link ?? data?.url;
    if (typeof link === 'string') value = link;
  }
  return value;
}

/**
 * Compare two PR links by identity (host/owner/repo/number) rather than raw
 * string equality. Raw `!==` is safe against swaps but false-negatives on
 * equivalent spellings (trailing slash, `/files` suffix, host casing), which
 * would fail a gate closed on a link the human considers the same PR. Falls
 * back to raw equality when either side does not parse as a PR link.
 */
export function samePrLink(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parsePrLink(a);
  const pb = parsePrLink(b);
  if (!pa || !pb) return false;
  return (
    pa.host.toLowerCase() === pb.host.toLowerCase() &&
    pa.owner === pb.owner &&
    pa.repo === pb.repo &&
    pa.number === pb.number
  );
}
