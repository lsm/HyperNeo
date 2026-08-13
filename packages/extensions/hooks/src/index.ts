/**
 * @hyperneo/extensions-hooks — built-in workflow hook definitions.
 *
 * Each export is a v2 {@link Hook}: `id` + `requiredData` (the input contract,
 * data) + `run` (the rule, code). The daemon loads these by id when a
 * {@link HookBinding} references them; the engine invokes `run` with a
 * daemon-implemented {@link HookContext}. This package depends only on
 * @hyperneo/shared — no daemon internals.
 *
 * See `docs/features/workflow-hooks-v2.md`.
 */

import type { Hook } from '@hyperneo/shared/types/workflow-hooks';
import { codexReviewApprovedHook } from './hooks/codex-review-approved';
import { postApprovalOnlyHook } from './hooks/post-approval-only';
import { prMergedHook } from './hooks/pr-merged';
import { prReadyHook } from './hooks/pr-ready';
import { reviewPostedHook } from './hooks/review-posted';

export { dataOf, readDataString } from './action';
export { getPrimaryLink } from './primary-link';
export {
  ghGetPr,
  ghGetUnresolvedReviewThreads,
  ghGetReviewEvidence,
  ghGetCodexApproval,
  githubFailureToFlow,
  parsePrLink,
  type GithubResult,
  type GithubPrView,
  type GithubReviewEvidence,
  type GithubCodexApproval,
  type ParsedPrLink,
} from './github';
export { postApprovalOnlyHook } from './hooks/post-approval-only';
export { prMergedHook } from './hooks/pr-merged';
export { prReadyHook } from './hooks/pr-ready';
export { reviewPostedHook } from './hooks/review-posted';
export { codexReviewApprovedHook } from './hooks/codex-review-approved';

/** The built-in hook registry. The daemon loads these by id. */
export const BUILT_IN_HOOKS: readonly Hook[] = [
  prReadyHook,
  reviewPostedHook,
  postApprovalOnlyHook,
  prMergedHook,
  codexReviewApprovedHook,
];
