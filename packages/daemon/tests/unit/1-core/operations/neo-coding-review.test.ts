import { describe, expect, mock, test } from 'bun:test';
import { runCodingReview } from '../../../../src/lib/neo/packs/coding/review.ts';

const head = 'latest-head';
const review = (login: string, oid = head, state = 'APPROVED') => ({
  author: { login },
  commit: { oid },
  state,
});

describe('coding review routing', () => {
  test.each(['repo-review-app', 'another-review-service'])(
    'configured %s supplies review without starting a reviewer session',
    async (reviewBot) => {
      const startReviewer = mock(async () => 'separate-reviewer');
      const result = await runCodingReview(
        { reviewBot, head, reviews: [review(reviewBot)] },
        { startReviewer }
      );
      expect(result).toEqual({ kind: 'bot', head, login: reviewBot, approved: true });
      expect(startReviewer).not.toHaveBeenCalled();
    }
  );

  test.each([undefined, ''])(
    'no configured bot (%s) starts a reviewer session',
    async (reviewBot) => {
      const startReviewer = mock(async () => 'separate-reviewer');
      const result = await runCodingReview(
        { reviewBot, head, reviews: [review('unconfigured-app')] },
        { startReviewer }
      );
      expect(result).toEqual({ kind: 'session', head, sessionId: 'separate-reviewer' });
      expect(startReviewer).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    [],
    [review('repo-review-app', 'old-head')],
    [review('another-review-service')],
    [review('repo-review-app', head, 'CHANGES_REQUESTED')],
    [review('repo-review-app'), review('repo-review-app', head, 'DISMISSED')],
    [{ author: null, commit: { oid: head }, state: 'APPROVED' }],
    [{ author: { login: 'repo-review-app' }, commit: null, state: 'APPROVED' }],
  ])('pending or ineligible bot review never falls back to a session: %j', async (...reviews) => {
    const startReviewer = mock(async () => 'forbidden-reviewer');
    const result = await runCodingReview(
      { reviewBot: 'repo-review-app', head, reviews },
      { startReviewer }
    );
    expect(result).toEqual({ kind: 'bot', head, login: 'repo-review-app', approved: false });
    expect(startReviewer).not.toHaveBeenCalled();
  });

  test('matches login without case sensitivity and ignores other actors and heads', async () => {
    const startReviewer = mock(async () => 'forbidden-reviewer');
    expect(
      await runCodingReview(
        {
          reviewBot: 'Repo-Review-App',
          head,
          reviews: [
            review('repo-review-app'),
            review('repo-review-app', 'old-head', 'CHANGES_REQUESTED'),
            review('another-review-service', head, 'CHANGES_REQUESTED'),
          ],
        },
        { startReviewer }
      )
    ).toEqual({ kind: 'bot', head, login: 'Repo-Review-App', approved: true });
    expect(startReviewer).not.toHaveBeenCalled();
  });
});
