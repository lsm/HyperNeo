import { registerBuiltInValidator } from '../built-in-validator-registry';
import {
  createCodexApprovalValidator,
  createPrMergedValidator,
  createReviewPostedValidator,
} from '../connectors/presets';
import { createPostApprovalOnlyValidator } from './post-approval-only-validator';
import { createPrReadyValidator } from './pr-ready-validator';

export function registerProductionBuiltInValidators(): void {
  registerBuiltInValidator('pr_ready', createPrReadyValidator());
  registerBuiltInValidator('pr_merged', createPrMergedValidator());
  registerBuiltInValidator('review_posted', createReviewPostedValidator());
  registerBuiltInValidator('post_approval_only', createPostApprovalOnlyValidator());
  registerBuiltInValidator('codex_review_approved', createCodexApprovalValidator());
}

registerProductionBuiltInValidators();
