import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { withBusyRetry } from '../../../../storage/busy-retry.ts';
import type { ConnectorOutcome } from '../../../github/connectors/connector.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { CodingPollFactsRepository } from './poll-facts.ts';

const Pr = z.object({
  url: z.string().url(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.string().min(1),
});
type Subject = Parameters<CodingPollFactsRepository['read']>[0];
type Target = { facts: CodingPollFactsRepository; subject: Subject };

function target(
  getDatabase: () => Database,
  url: string
): { value: Target } | { reason: ConnectorOutcome } {
  const pr = parsePrUrl(url.toLowerCase());
  if (!pr) return { reason: { ok: false, error: 'Unable to parse GitHub PR URL' } };
  const allowed = (process.env.GH_HOST || 'github.com').toLowerCase();
  if (pr.host !== 'github.com' && pr.host !== allowed)
    return { reason: { ok: false, error: `PR host ${pr.host} is not allowed for GitHub lookups` } };
  const db = getDatabase();
  const repo = `${pr.owner}/${pr.repo}`;
  const alias =
    pr.host === 'github.com'
      ? (db.prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?').get(repo) as {
          canonical: string;
        } | null)
      : null;
  return {
    value: {
      facts: new CodingPollFactsRepository(db),
      subject: {
        credentialId: 'github-connector',
        url: `https://${pr.host}/${alias?.canonical.toLowerCase() ?? repo}/pull/${pr.number}`,
        accept: 'application/vnd.hyperneo.pr-basic+json',
        apiVersion: 'v1',
      },
    },
  };
}

async function acquire(target: Target, workspacePath: string, spawn: SpawnFn, now: () => number) {
  const { facts, subject } = target;
  const before = facts.read(subject, now(), Infinity);
  const response = await facts.acquire(subject, null, async () => {
    const outcome = await runGhJson(
      ['gh', 'pr', 'view', subject.url, '--json', 'url,state,mergeable,mergeStateStatus'],
      workspacePath || '/tmp',
      spawn,
      { resourceHint: 'graphql' }
    );
    const parsed = outcome.ok ? Pr.safeParse(outcome.data) : null;
    const identity = parsed?.success ? parsePrUrl(parsed.data.url.toLowerCase()) : null;
    const matches =
      identity &&
      `https://${identity.host}/${identity.owner}/${identity.repo}/pull/${identity.number}` ===
        subject.url;
    const value = parsed?.success && matches ? parsed.data : null;
    const observation = value
      ? { value, etag: null, next: null }
      : { reason: outcome.ok ? ('partial' as const) : ('failed' as const) };
    const recorded = withBusyRetry(() =>
      facts.record(subject, observation, now(), before.observationRevision)
    );
    const result: ConnectorOutcome = !recorded
      ? { ok: false, error: 'GitHub connector PR observation superseded' }
      : !outcome.ok
        ? outcome
        : value
          ? { ok: true, data: value }
          : { ok: false, error: 'GitHub connector PR facts unavailable: partial' };
    return Response.json({ result, revision: before.observationRevision + 1 });
  });
  return { ...((await response.json()) as { result: ConnectorOutcome; revision: number }), target };
}

function project(
  acquired: Awaited<ReturnType<typeof acquire>>,
  now: () => number
): ConnectorOutcome {
  if (!acquired.result.ok) return acquired.result;
  const { facts, subject } = acquired.target;
  const current = facts.read(subject, now(), Infinity);
  return current.observationRevision === acquired.revision && current.page.status === 'known'
    ? { ok: true, data: current.page.value }
    : { ok: false, error: 'GitHub connector PR observation superseded' };
}

export function createCodingConnectorPrReader(
  getDatabase: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
): (url: string, workspacePath: string) => Promise<ConnectorOutcome> {
  return (superpipe({ getDatabase, spawn, now })('coding-ledger-connector-pr-read') as PipelineAPI)
    .input(['url', 'workspacePath'])
    .pipe(target, ['getDatabase', 'url'], 'result:outcome')
    .pipe(acquire, ['outcome', 'workspacePath', 'spawn', 'now'], 'acquired')
    .pipe(project, ['acquired', 'now'], 'outcome')
    .endAsync('outcome') as (url: string, workspacePath: string) => Promise<ConnectorOutcome>;
}
