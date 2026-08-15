/**
 * @hyperneo/extensions-hooks — built-in workflow hook definitions.
 *
 * Each hook is a v2 {@link Hook}: `id` + `requiredData` (the input contract,
 * data) + `run` (the rule, code). The daemon loads these by id when a
 * {@link HookBinding} references them; the engine invokes `run` with a
 * daemon-implemented {@link HookContext}. This package depends only on
 * @hyperneo/shared — no daemon internals.
 *
 * The barrel is intentionally narrow: it exposes only what the daemon consumes
 * (the registry, the workspace PR-view helper, and the validated-PR artifact
 * key). The GitHub helpers and extractors stay package-private to the modules
 * that use them.
 *
 * See `docs/features/workflow-hooks-v2.md`.
 */

import type { Hook } from '@hyperneo/shared/types/workflow-hooks';
import { codexReviewApprovedHook } from './hooks/codex-review-approved';
import { postApprovalOnlyHook } from './hooks/post-approval-only';
import { prMergedHook } from './hooks/pr-merged';
import { prReadyHook } from './hooks/pr-ready';
import { reviewPostedHook } from './hooks/review-posted';
import { fetchPrView } from './github';
export { samePrLink, VALIDATED_PR_ARTIFACT_KEY } from './primary-link';
export { GH_INFRA_ERROR_PREFIX } from './github';
// Test seams: substituting the gh/GraphQL transports (used by daemon and
// hook tests to exercise the built-ins' GitHub flows without spawning gh).
export { setGhRunnerForTests, setGraphqlRunnerForTests } from './github';

/** The built-in hook registry. The daemon loads these by id. */
export const BUILT_IN_HOOKS: readonly Hook[] = [
  prReadyHook,
  reviewPostedHook,
  postApprovalOnlyHook,
  prMergedHook,
  codexReviewApprovedHook,
];

export { fetchPrView };
