import { test, expect } from '../../fixtures';

test.describe
  .skip('Post-approval merge rejected by human at autonomy level 1 (PENDING infra)', () => {
    test('reviewer session respects human rejection — PR is NOT merged; audit records rejection', async ({
      page,
    }) => {
      expect(page).toBeTruthy();
    });
  });
