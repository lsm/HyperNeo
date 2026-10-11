import { describe, expect, test } from 'bun:test';
import { isPrSubscription } from '../../../../src/lib/external-events/session-subscription-close';

describe('isPrSubscription', () => {
  const pr = { owner: 'acme', repo: 'widgets', prNumber: '7' };
  test.each([
    ['github/ACME/widgets/pull_request/7.*', true],
    ['github/acme/widgets/pull_request/7.closed', true],
    ['github/acme/widgets/pull_request/70.*', false],
    ['github/acme/widgets/pull_request/*.closed', false],
    ['github/*/widgets/pull_request/7.*', false],
    ['github/acme/widgets/repo/7.*', false],
  ] as const)('%s', (pattern, expected) => {
    expect(isPrSubscription(pattern, pr)).toBe(expected);
  });
});
