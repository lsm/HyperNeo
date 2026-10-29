import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { CodingPrLedgerRepository, CodingMergePolicy } from './pr-ledger.ts';
import type { CodingPrEventRepository } from './pr-events.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';
import { readCodingDaemonMergeFacts } from './daemon-merge-facts.ts';
import { decideCodingDaemonMerge } from './daemon-merge-gates.ts';

type Receipt = ReturnType<CodingPrLedgerRepository['daemonMerge']>[number];
type Candidate = { url: string; head: string; policy: CodingMergePolicy };
type Observed = Candidate & { facts: Awaited<ReturnType<typeof readCodingDaemonMergeFacts>> };
const admit = (observed: Observed) => {
  const decision = decideCodingDaemonMerge(observed.facts, observed.policy);
  return decision.kind === 'merge' && decision.head === observed.head
    ? { value: observed }
    : { reason: decision.kind };
};

export function createCodingDaemonMergeSweep(
  database: () => Database,
  ledger: CodingPrLedgerRepository,
  events: CodingPrEventRepository,
  delivery: CodingSweepDeps,
  spawn: SpawnFn = spawnProcess
) {
  const record = (change: Parameters<CodingPrLedgerRepository['daemonMerge']>[0]) =>
    ledger.write('daemonMerge', change);
  const read = (url: string) => readCodingDaemonMergeFacts(database(), url, spawn);
  const notify = async (receipt: Receipt, now: number) => {
    const pr = parsePrUrl(receipt.url)!;
    const route = { repo: `${pr.owner}/${pr.repo}`, number: Number(pr.number) };
    const { owner } = await events.routeLater(route);
    const key = `coding-daemon-merged:${receipt.url}:${receipt.head}`;
    const text = `${receipt.url} merged by ${receipt.actor} on head ${receipt.head} at ${new Date(receipt.mergedAt!).toISOString()} (${receipt.mergeCommit}).`;
    const told = owner && (await delivery.tell(owner, key, text).catch(() => false));
    if (told || (await delivery.wake(key, text).catch(() => false)))
      await record({ ...receipt, kind: 'notified', at: now });
  };
  const finish = async (receipt: Receipt, facts: Observed['facts'], now: number) => {
    if (!facts.ok || facts.head !== receipt.head || facts.state !== 'MERGED' || !facts.mergeCommit)
      return;
    const [completed] = await record({
      ...receipt,
      kind: 'finish',
      commit: facts.mergeCommit,
      at: now,
    });
    if (completed) await notify(completed, now);
  };
  const merge = (superpipe({})('coding.sweep-daemon-merge') as PipelineAPI)
    .input(['observed', 'now'])
    .pipe(admit, 'observed', 'result:result')
    .pipe(
      async (observed: Observed, now: number) => {
        const { url, head } = observed;
        const [receipt] = await record({
          kind: 'begin',
          url,
          head,
          actor: 'daemon:coding-sweep',
          at: now,
        });
        return receipt ? { value: receipt } : { reason: 'already_attempted' };
      },
      ['result', 'now'],
      'result:result'
    )
    .pipe(
      async (receipt: Receipt, now: number) => {
        await runGhJson(
          ['gh', 'pr', 'merge', receipt.url, '--squash', '--match-head-commit', receipt.head],
          homedir(),
          spawn
        ).catch(() => {});
        const facts = await read(receipt.url);
        await finish(receipt, facts, now);
        return facts.ok ? 'attempted' : 'read_failure';
      },
      ['result', 'now'],
      'result'
    )
    .endAsync('result') as (observed: Observed, now: number) => Promise<unknown>;
  const sweep = async (now: number): Promise<void> => {
    const rows = (await ledger.read('list')).filter(
      (row) => row.closedAt === null && row.state === 'approved_green'
    );
    const observed = await Promise.all(
      rows.map(async (row) => ({
        url: `https://github.com/${row.repo}/pull/${row.number}`.toLowerCase(),
        head: row.head,
        policy: (await ledger.pollContextCurrent(row.repo)).policy,
      }))
    );
    const candidates = observed.filter(
      (row) => row.policy.mergeBy === 'daemon' && row.policy.mergePolicy !== 'human'
    );
    const receipts = await record({ kind: 'list' });
    const pending = [...new Set([...candidates, ...receipts].map(({ url }) => url))];
    const facts = new Map(
      await Promise.all(pending.map(async (url) => [url, await read(url)] as const))
    );
    if ([...facts.values()].some((fact) => !fact.ok)) return;
    for (const receipt of receipts) {
      if (receipt.mergeCommit) await notify(receipt, now);
      else await finish(receipt, facts.get(receipt.url)!, now);
    }
    for (const candidate of candidates) {
      const observed = { ...candidate, facts: facts.get(candidate.url)! };
      const outcome = await merge(observed, now);
      if (outcome === 'read_failure') return;
      if (outcome === 'needs_human_signoff')
        await delivery.wake(
          `coding-daemon-signoff:${candidate.url}:${candidate.head}`,
          `${candidate.url} requires human sign-off; daemon merge is held.`
        );
    }
  };
  let running = Promise.resolve();
  return (now: number) => {
    const next = running.then(() => sweep(now));
    running = next.catch(() => {});
    return next;
  };
}
