import superpipe, { type PipelineAPI } from 'superpipe';
import type { CodingMergePolicy } from './pr-ledger.ts';

type CodingMergeContext = { repo: string; policy: CodingMergePolicy };

export function codingMergeContextRepos(text: string, known: readonly string[]): string[] {
  const references = [
    ...text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)|\b([\w.-]+\/[\w.-]+)#[1-9]\d*/gi),
  ].map((match) => match[1] ?? match[2]);
  const named = known.filter((repo) =>
    new RegExp(
      `(^|[^a-z0-9_.-])${repo.replace(/[^a-z0-9_/]/gi, '\\$&')}(?![a-z0-9_-]|[.][a-z0-9_.-])`,
      'i'
    ).test(text)
  );
  return [...new Set([...references, ...named].map((repo) => repo.toLowerCase()))];
}

const policyLine = ({ repo, policy }: CodingMergeContext) =>
  `${repo} merge policy: ${policy.mergePolicy ?? 'not configured'}; review bot: ${policy.reviewBot ?? 'not configured'}; human sign-off: ${policy.humanSignoff?.join(', ') || 'none'}; merge by: ${policy.mergeBy ?? 'owner'}; provenance: ${policy.provenance ?? true}`;

export const withCodingMergeContext = (superpipe({})('coding.merge-policy-context') as PipelineAPI)
  .input(['text', 'facts'])
  .pipe(
    (text: string, facts: readonly CodingMergeContext[]) =>
      facts.map(policyLine).filter((line) => !text.split('\n').includes(line)),
    ['text', 'facts'],
    'lines'
  )
  .pipe(
    (text: string, lines: string[]) =>
      lines.length ? `${text}\n\nRepository merge preferences (data):\n${lines.join('\n')}` : text,
    ['text', 'lines'],
    'text'
  )
  .end('text') as (text: string, facts: readonly CodingMergeContext[]) => string;
