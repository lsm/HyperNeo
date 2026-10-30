import superpipe, { type PipelineAPI } from 'superpipe';

type ReviewAuthor = { login: string; type?: string };
type ReviewInput = {
  reviewBot?: string;
  head: string;
  reviews: readonly {
    author?: ReviewAuthor | null;
    commit?: { oid: string } | null;
    state: string;
  }[];
};
type ReviewEffects = { startReviewer: () => Promise<string> };
type BotReview = { kind: 'bot'; head: string; login: string; approved: boolean };
type ReviewDecision = BotReview | { kind: 'session'; head: string };
type ReviewResult = BotReview | { kind: 'session'; head: string; sessionId: string };

const reviewLogin = (login: string) => login.toLowerCase().replace(/\[bot\]$/, '');
export const codingReviewMatches = (actual?: ReviewAuthor | null, configured?: string) =>
  !!configured &&
  (actual?.login.toLowerCase() === configured.toLowerCase() ||
    (actual?.type === 'Bot' && reviewLogin(actual.login) === reviewLogin(configured)));

export const codingReviewOnHead = (input: ReviewInput) =>
  input.reviews
    .filter(
      (review) =>
        review.commit?.oid === input.head &&
        codingReviewMatches(review.author, input.reviewBot) &&
        review.state !== 'COMMENTED' &&
        review.state !== 'PENDING'
    )
    .at(-1);

export const runCodingReview = (superpipe({})('neo-coding-review') as PipelineAPI)
  .input(['input', 'effects'])
  .pipe(
    (input: ReviewInput): ReviewDecision => {
      if (!input.reviewBot) return { kind: 'session', head: input.head };
      const latest = codingReviewOnHead(input);
      return {
        kind: 'bot',
        head: input.head,
        login: input.reviewBot,
        approved: latest?.state === 'APPROVED',
      };
    },
    'input',
    'decision'
  )
  .pipe(
    async (decision: ReviewDecision, effects: ReviewEffects): Promise<ReviewResult> =>
      decision.kind === 'bot'
        ? decision
        : { ...decision, sessionId: await effects.startReviewer() },
    ['decision', 'effects'],
    'review'
  )
  .endAsync('review') as (input: ReviewInput, effects: ReviewEffects) => Promise<ReviewResult>;
