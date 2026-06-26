/**
 * Unit tests for applyReviewerContractMigrationOverride +
 * reviewerPromptNeedsMigrationOverride.
 *
 * Verifies the override is applied only when the persisted Reviewer prompt is
 * stale (predates the no-shell migration), and skipped for fresh seeds or
 * user-customised rows that happen to retain the templateName.
 */

import { describe, expect, it } from 'bun:test';
import {
  applyReviewerContractMigrationOverride,
  reviewerPromptNeedsMigrationOverride,
} from '../../../../src/lib/space/agents/reviewer-contract-migration';
import { REVIEWER_SYSTEM_CONTRACT } from '../../../../src/lib/space/agents/system-contracts';

describe('reviewerPromptNeedsMigrationOverride', () => {
  it('returns true when prompt contains a retired shell procedure marker', () => {
    expect(reviewerPromptNeedsMigrationOverride('Use `gh pr review` to post feedback.')).toBe(true);
    expect(reviewerPromptNeedsMigrationOverride('Inspect via `gh pr diff`/`gh pr view`.')).toBe(
      true
    );
    expect(reviewerPromptNeedsMigrationOverride('Run `gh api graphql` to inspect threads.')).toBe(
      true
    );
    expect(
      reviewerPromptNeedsMigrationOverride(
        'Use `gh api repos/{owner}/{repo}/issues/{number}/reactions`.'
      )
    ).toBe(true);
    expect(reviewerPromptNeedsMigrationOverride('run tests if uncertain')).toBe(true);
  });

  it('returns false when prompt already contains the current no-shell contract marker', () => {
    expect(reviewerPromptNeedsMigrationOverride(REVIEWER_SYSTEM_CONTRACT)).toBe(false);
    expect(
      reviewerPromptNeedsMigrationOverride(
        'Reviewer contract.\n\nRead-only rule: do not run tests/scripts/shell.'
      )
    ).toBe(false);
  });

  it('returns false when prompt lacks both current marker and retired markers', () => {
    expect(reviewerPromptNeedsMigrationOverride('User-customised reviewer prompt.')).toBe(false);
    expect(reviewerPromptNeedsMigrationOverride('')).toBe(false);
  });
});

describe('applyReviewerContractMigrationOverride', () => {
  it('appends override when templateName is Reviewer and prompt is stale', () => {
    const result = applyReviewerContractMigrationOverride(
      'Old shell-based procedure: run `gh pr diff`.',
      'Reviewer'
    );

    expect(result).toContain('## Updated Reviewer Contract (migration override');
    expect(result).toContain('Reviewer System Contract');
    expect(result).toContain('Old shell-based procedure');
  });

  it('skips override when templateName is Reviewer but prompt is already current', () => {
    const result = applyReviewerContractMigrationOverride(REVIEWER_SYSTEM_CONTRACT, 'Reviewer');

    // No duplicate appended.
    expect(result).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(result).not.toContain('## Updated Reviewer Contract (migration override');
  });

  it('skips override when templateName is Reviewer but prompt lacks shell markers', () => {
    const userPrompt = 'Be a kind reviewer. Focus on clarity.';
    const result = applyReviewerContractMigrationOverride(userPrompt, 'Reviewer');

    expect(result).toBe(userPrompt);
  });

  it('skips override when templateName is not a read-only preset', () => {
    const result = applyReviewerContractMigrationOverride(
      'Old procedure with `gh pr diff`.',
      'Coder'
    );

    expect(result).toBe('Old procedure with `gh pr diff`.');
  });

  it('skips override when templateName is null/undefined', () => {
    const stale = 'Use `gh pr review`.';
    expect(applyReviewerContractMigrationOverride(stale, null)).toBe(stale);
    expect(applyReviewerContractMigrationOverride(stale, undefined)).toBe(stale);
  });

  it('returns just the contract when prompt is empty but stale markers absent', () => {
    // Empty prompt has no shell markers and no current marker, so the helper
    // skips the override. Reviewer with no prompt is an edge case the seeder
    // does not produce; the test documents the no-op behaviour.
    expect(applyReviewerContractMigrationOverride('', 'Reviewer')).toBe('');
  });
});
