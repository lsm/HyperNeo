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
import { postApprovalOnlyHook } from './hooks/post-approval-only';

export { getPrimaryLink } from './primary-link';
export { postApprovalOnlyHook } from './hooks/post-approval-only';

/**
 * The built-in hook registry. The daemon loads these by id. More hooks
 * (pr_ready, review_posted, pr_merged, codex_review_approved) are ported in
 * subsequent commits.
 */
export const BUILT_IN_HOOKS: readonly Hook[] = [postApprovalOnlyHook];
