import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { parseGitHubRefUrl, parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { NeoRef, NeoRefState, NeoRefStateReader } from './ask-prs.ts';
import type { NeoWorkPrReader } from './work-prs.ts';

type Failure = { ok: false; reason: string };
type PrIdentity = { kind: 'pr'; url: string };
type RefTarget = NeoRefState | PrIdentity;
type PrTarget = { ok: true } & PrIdentity;
export type NeoGithubReaders = { readRefStates: NeoRefStateReader; readPrs: NeoWorkPrReader };

export const NeoGithubReadResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    kind: z.literal('pr'),
    url: z.string(),
    state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
    checks: z.enum(['pending', 'failing', 'passing', 'none']).nullable(),
    review: z.enum(['approved', 'changes_requested', 'none']).nullable(),
    blockers: z.array(z.string()),
    title: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal('issue'),
    url: z.string(),
    state: z.enum(['OPEN', 'CLOSED']),
    closedAs: z.enum(['completed', 'not_planned', 'duplicate']).nullable(),
    closedBy: z.string().nullable(),
    parent: z.string().nullable(),
  }),
]);
export type NeoGithubReadResult = z.infer<typeof NeoGithubReadResult>;

export function requireNeoGithubRef(url: string): { value: NeoRef } | { reason: Failure } {
  const ref = parseGitHubRefUrl(url);
  return ref
    ? { value: ref }
    : { reason: { ok: false, reason: 'not_a_ref: pass a GitHub pull request or issue URL.' } };
}

export function requireNeoRefRead(
  found: { states: RefTarget[] },
  url: string
): { value: RefTarget } | { reason: Failure } {
  const [state] = found.states;
  return state
    ? { value: state }
    : {
        reason: {
          ok: false,
          reason: `unreadable: ${url} could not be read from GitHub just now (missing, private, or gh failed); try again later.`,
        },
      };
}

export function presentNeoRefRead(state: RefTarget): { value: NeoGithubReadResult | PrTarget } {
  if (state.kind === 'pr')
    return {
      value: {
        ok: true,
        kind: 'pr',
        url: state.url,
      },
    };
  const closed = state.state === 'CLOSED';
  return {
    value: {
      ok: true,
      kind: 'issue',
      url: state.url,
      state: state.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
      closedAs: !closed
        ? null
        : state.done
          ? 'completed'
          : state.duplicate
            ? 'duplicate'
            : 'not_planned',
      closedBy: state.closedBy,
      parent: state.parent?.url ?? null,
    },
  };
}

export function presentNeoPrRead(
  read: NeoGithubReadResult | PrTarget,
  detail: { prs: NeoWorkPr[] | null }
): { value: NeoGithubReadResult } | { reason: Failure } {
  const pr = detail.prs?.[0];
  if (!pr)
    return {
      reason: {
        ok: false,
        reason: `unreadable: the checks and review of ${read.ok ? read.url : 'this pull request'} could not be read from GitHub just now; try again later.`,
      },
    };
  return read.ok && read.kind === 'pr'
    ? {
        value: {
          ...read,
          url: pr.url,
          state: pr.state,
          checks: pr.checks,
          review: pr.review,
          blockers: pr.blockers ?? [],
          title: pr.title ?? null,
        },
      }
    : { value: read };
}

export const readNeoGithubRef = (superpipe({})('neo-github-read') as PipelineAPI)
  .input(['readers', 'url'])
  .pipe(requireNeoGithubRef, 'url', 'result:read')
  .pipe(
    async (readers: NeoGithubReaders, read: NeoRef, url: string) => ({
      states: parsePrUrl(url)
        ? [{ kind: 'pr' as const, url }]
        : await readers.readRefStates([read]),
    }),
    ['readers', 'read', 'url'],
    'found'
  )
  .pipe(requireNeoRefRead, ['found', 'url'], 'result:read')
  .pipe((read: RefTarget) => ({ state: read }), 'read', 'held')
  .pipe(presentNeoRefRead, 'read', 'result:read')
  .pipe((held: { state: RefTarget }) => held.state.kind === 'issue', 'held', 'issue')
  .pipe('!issue')
  .pipe(
    async (readers: NeoGithubReaders, held: { state: RefTarget }) => ({
      prs: await readers.readPrs([held.state.url]),
    }),
    ['readers', 'held'],
    'detail'
  )
  .pipe(presentNeoPrRead, ['read', 'detail'], 'result:read')
  .endAsync('read') as (readers: NeoGithubReaders, url: string) => Promise<NeoGithubReadResult>;
