import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { Logger } from '../../../logger.ts';
import { RATE_LIMIT_MIN_BACKOFF_MS } from '../../../session/rate-limit-detector.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { codingLedgerReads, type CodingPrLedgerRepository } from './pr-ledger.ts';
import type { CodingStageFact } from './stage-facts.ts';

const log = new Logger('NeoCodingReviewComment');

export type CodingGithubApi = (host: string, args: string[]) => Promise<unknown>;

export const codingGithubApi = async (
  host: string,
  args: string[],
  spawn: SpawnFn = spawnProcess
) => {
  const result = await runGhJson(['gh', 'api', '--hostname', host, ...args], homedir(), spawn, {
    stripGHRepo: true,
    hostHint: host,
    resourceHint: 'core',
    timeoutMs: 60_000,
    maxBufferBytes: 64 * 1024 * 1024,
  });
  if (!result.ok)
    throw Object.assign(new Error(result.error), {
      retryAfterMs: result.retryAfterMs,
      rateLimited: result.rateLimited === true,
    });
  return result.data;
};

export function planCodingReviewComment(fact: CodingStageFact) {
  const key = createHash('sha256')
    .update(JSON.stringify([fact.url, fact.head, fact.actor, fact.verdict]))
    .digest('hex')
    .slice(0, 16);
  const marker = `<!-- hyperneo-review:${key} -->`;
  const reviewer =
    fact.actor.kind === 'agent' ? `\`${fact.actor.model}\` via ${fact.actor.harness}` : 'a human';
  return {
    marker,
    body: [
      `**HyperNeo recorded review: ${fact.verdict.toUpperCase()}**`,
      '',
      `- Reviewer: ${reviewer}`,
      `- Verdict: ${fact.verdict}`,
      `- Head: \`${fact.head}\``,
      '',
      'Posted once by the HyperNeo daemon from the review record its merge gate reads.',
      marker,
    ].join('\n'),
  };
}

const Page = z.array(z.object({ body: z.string().nullable().optional() }));
const PER_PAGE = 100;

export async function postCodingReviewComment(api: CodingGithubApi, fact: CodingStageFact) {
  const pr = parsePrUrl(fact.url);
  if (!pr) return false;
  const path = `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
  const { marker, body } = planCodingReviewComment(fact);
  const comments: z.infer<typeof Page> = [];
  for (let page = 1; ; page++) {
    const batch = Page.parse(
      await api(pr.host, [
        path,
        '-f',
        `per_page=${PER_PAGE}`,
        '-f',
        `page=${page}`,
        '--method',
        'GET',
      ])
    );
    comments.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  const newest = comments
    .flatMap((comment) => /<!-- hyperneo-review:[0-9a-f]{16} -->/.exec(comment.body ?? '') ?? [])
    .at(-1);
  if (newest === marker) return false;
  await api(pr.host, [path, '--method', 'POST', '-f', `body=${body}`]);
  return true;
}

const rateLimitHoldMs = (error: unknown) => {
  if (!(error instanceof Error) || !('rateLimited' in error) || error.rateLimited !== true)
    return null;
  return 'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
    ? error.retryAfterMs
    : RATE_LIMIT_MIN_BACKOFF_MS;
};

type CodingPostedReview = (fact: CodingStageFact, marker: string) => Promise<void>;

export function createCodingReviewComments(api: CodingGithubApi) {
  let heldUntil = 0;
  let queue = Promise.resolve();
  const post = async (
    read: () => Promise<readonly CodingStageFact[]>,
    posted: CodingPostedReview
  ) => {
    if (Date.now() < heldUntil) return;
    for (const fact of await read()) {
      try {
        await postCodingReviewComment(api, fact);
      } catch (error) {
        log.warn('review comment not posted', { url: fact.url, error: String(error) });
        const holdMs = rateLimitHoldMs(error);
        if (holdMs === null) continue;
        heldUntil = Date.now() + holdMs;
        return;
      }
      await posted(fact, planCodingReviewComment(fact).marker);
    }
  };
  return (read: () => Promise<readonly CodingStageFact[]>, posted: CodingPostedReview) =>
    (queue = queue
      .then(() => post(read, posted))
      .catch((error: unknown) => log.warn('review comments not read', { error: String(error) })));
}

export async function readCodingPostableReviews(db: Database, ledger: CodingPrLedgerRepository) {
  const open = (await ledger.read('list')).filter(
    (row) => row.state !== 'closed' && row.state !== 'merged'
  );
  const gateway = gatewayFor(db);
  const facts = await Promise.all(
    open.map(async (row) => {
      const url = `https://${process.env.GH_HOST ?? 'github.com'}/${row.repo}/pull/${row.number}`;
      const posted = await gateway.call(codingLedgerReads, 'readPostedReview', url);
      return (await gateway.call(codingLedgerReads, 'readStageFacts', url)).filter(
        (fact) =>
          fact.stage === 'review' &&
          fact.head === row.head &&
          planCodingReviewComment(fact).marker !== posted
      );
    })
  );
  return facts.flat();
}
