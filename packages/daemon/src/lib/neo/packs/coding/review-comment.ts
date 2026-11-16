import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';
import type { CodingStageFact } from './stage-facts.ts';

export type CodingGithubApi = (host: string, args: string[]) => Promise<unknown>;

export const codingGithubApi: CodingGithubApi = async (host, args) => {
  const result = await runGhJson(
    ['gh', 'api', '--hostname', host, ...args],
    homedir(),
    spawnProcess,
    { stripGHRepo: true }
  );
  if (!result.ok) throw new Error(result.error);
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

const Pages = z.array(z.array(z.object({ body: z.string().nullable().optional() })));

export async function postCodingReviewComment(api: CodingGithubApi, fact: CodingStageFact) {
  const pr = parsePrUrl(fact.url);
  if (!pr) return false;
  const path = `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
  const { marker, body } = planCodingReviewComment(fact);
  const pages = Pages.parse(
    await api(pr.host, [path, '--paginate', '--slurp', '-f', 'per_page=100', '--method', 'GET'])
  );
  if (pages.flat().some((comment) => comment.body?.includes(marker))) return false;
  await api(pr.host, [path, '--method', 'POST', '-f', `body=${body}`]);
  return true;
}
