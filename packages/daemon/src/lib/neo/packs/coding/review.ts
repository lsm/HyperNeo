import superpipe, { type PipelineAPI } from 'superpipe';

type ReviewInput = {
  reviewBot?: string;
  head: string;
  reviews: readonly {
    author?: { login: string } | null;
    commit?: { oid: string } | null;
    state: string;
  }[];
};
type ReviewEffects = { startReviewer: () => Promise<string> };
type BotReview = { kind: 'bot'; head: string; login: string; approved: boolean };
type ReviewDecision = BotReview | { kind: 'session'; head: string };
type ReviewResult = BotReview | { kind: 'session'; head: string; sessionId: string };

export const runCodingReview = (superpipe({})('neo-coding-review') as PipelineAPI)
  .input(['input', 'effects'])
  .pipe(
    (input: ReviewInput): ReviewDecision => {
      if (!input.reviewBot) return { kind: 'session', head: input.head };
      const latest = input.reviews
        .filter(
          (review) =>
            review.commit?.oid === input.head &&
            review.author?.login.toLowerCase() === input.reviewBot!.toLowerCase()
        )
        .at(-1);
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
