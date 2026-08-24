import { registerBuiltInValidator } from '../built-in-validator-registry.ts';
import {
  createCodexApprovalValidator,
  createPrMergedValidator,
  createReviewPostedValidator,
} from '../connectors/presets.ts';
import { createPostApprovalOnlyValidator } from './post-approval-only-validator.ts';
import { createPrReadyValidator } from './pr-ready-validator.ts';

export function registerProductionBuiltInValidators(): void {
  registerBuiltInValidator('pr_ready', createPrReadyValidator());
  registerBuiltInValidator('pr_merged', createPrMergedValidator());
  registerBuiltInValidator('review_posted', createReviewPostedValidator());
  registerBuiltInValidator('post_approval_only', createPostApprovalOnlyValidator());
  registerBuiltInValidator('codex_review_approved', createCodexApprovalValidator());
}

registerProductionBuiltInValidators();
