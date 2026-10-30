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
type Candidate = { url: string; head: string; policy: CodingMergePolicy; approvedGreen: boolean };
type Observed = Candidate & { facts: Awaited<ReturnType<typeof readCodingDaemonMergeFacts>> };
const admit = (observed: Observed) => {
  const decision = decideCodingDaemonMerge(observed.facts, observed.policy);
  const reason =
    decision.kind === 'skip' &&
    decision.reason === 'merge_policy_unresolved' &&
    observed.facts.ok &&
    observed.facts.state === 'OPEN'
      ? 'needs_human_signoff'
      : decision.kind;
  return decision.kind === 'merge' && decision.head === observed.head && observed.approvedGreen
    ? { value: observed }
    : { reason };
};

export function createCodingDaemonMergeSweep(
  database: () => Database,
  ledger: CodingPrLedgerRepository,
  events: CodingPrEventRepository,
  delivery: CodingSweepDeps,
  spawn: SpawnFn = spawnProcess
) {
  const actor = 'daemon:coding-sweep';
  const record = (change: Parameters<CodingPrLedgerRepository['daemonMerge']>[0]) =>
    ledger.write('daemonMerge', change);
  const read = (url: string) => readCodingDaemonMergeFacts(database(), url, spawn);
  const notify = async (receipt: Receipt, now: number) => {
    const { owner: org, repo, number } = parsePrUrl(receipt.url)!;
    const { owner } = await events.routeLater({ repo: `${org}/${repo}`, number: +number });
    const key = `coding-daemon-${receipt.mergeCommit ? 'merged' : 'held'}:${receipt.url}:${receipt.head}`;
    const text = receipt.mergeCommit
      ? `Merge confirmed: ${receipt.url} head ${receipt.head}, commit ${receipt.mergeCommit}. Receipt executor ${receipt.actor}; confirmation sweep ${new Date(receipt.mergedAt!).toISOString()}.`
      : `Daemon merge held: ${receipt.url} head ${receipt.head}. No merge confirmed; automatic retries are held. Inspect GitHub/auth status and the receipt before manual action.`;
    const told = owner && (await delivery.tell(owner, key, text).catch(() => false));
    const notified = told || (await delivery.wake(key, text).catch(() => false));
    if (receipt.mergeCommit && notified) await record({ ...receipt, kind: 'notified', at: now });
  };
  const finish = async (receipt: Receipt, pr: Observed['facts'], now: number) => {
    if (!pr.ok || pr.head !== receipt.head) return;
    if (pr.state !== 'MERGED' || !pr.mergeCommit) return notify(receipt, now);
    const [merged] = await record({ ...receipt, kind: 'finish', commit: pr.mergeCommit, at: now });
    if (merged) await notify(merged, now);
  };
  const merge = (superpipe({})('coding.sweep-daemon-merge') as PipelineAPI)
    .input(['observed', 'now'])
    .pipe(admit, 'observed', 'result:result')
    .pipe(
      async (observed: Observed, now: number) => {
        const { url, head } = observed;
        const [receipt] = await record({ kind: 'begin', url, head, actor, at: now });
        return receipt ? { value: receipt } : { reason: 'already_attempted' };
      },
      ['result', 'now'],
      'result:result'
    )
    .pipe(
      async (receipt: Receipt, observed: Observed, now: number) => {
        const { owner, repo } = parsePrUrl(receipt.url)!;
        const fresh = admit({ ...observed, policy: ledger.policy(`${owner}/${repo}`) });
        if ('reason' in fresh) return fresh.reason;
        // oxlint-disable-next-line no-warning-comments -- TODO(#9458): accepted final-read/in-flight-writer race.
        await runGhJson(
          ['gh', 'pr', 'merge', receipt.url, '--squash', '--match-head-commit', receipt.head],
          homedir(),
          spawn
        ).catch(() => {});
        const facts = await read(receipt.url);
        await finish(receipt, facts, now);
        return facts.ok ? 'attempted' : 'read_failure';
      },
      ['result', 'observed', 'now'],
      'result'
    )
    .endAsync('result') as (observed: Observed, now: number) => Promise<unknown>;
  const sweep = async (now: number): Promise<void> => {
    const rows = (await ledger.read('list')).filter(
      (row) => row.closedAt === null && ['approved_green', 'waiting_human'].includes(row.state)
    );
    const observed = await Promise.all(
      rows.map(async ({ repo, number, head, state }) => ({
        url: `https://${process.env.GH_HOST ?? 'github.com'}/${repo}/pull/${number}`.toLowerCase(),
        head,
        approvedGreen: state === 'approved_green',
        policy: (await ledger.pollContextCurrent(repo)).policy,
      }))
    );
    const candidates = observed.filter((row) => row.policy.mergeBy === 'daemon');
    const receipts = await record({ kind: 'list' });
    const pending = [...new Set([...candidates, ...receipts].map(({ url }) => url))];
    const facts = new Map(
      await Promise.all(pending.map(async (url) => [url, await read(url)] as const))
    );
    if ([...facts.values()].some((fact) => !fact.ok)) throw new Error(`Merge held: ${pending}`);
    for (const receipt of receipts) {
      if (receipt.mergeCommit) await notify(receipt, now);
      else await finish(receipt, facts.get(receipt.url)!, now);
    }
    for (const candidate of candidates) {
      const observed = { ...candidate, facts: facts.get(candidate.url)! };
      const outcome = await merge(observed, now);
      if (outcome === 'read_failure') throw new Error(`Merge held: ${candidate.url}`);
      if (outcome === 'needs_human_signoff')
        await delivery
          .wake(
            `coding-daemon-signoff:${candidate.url}:${candidate.head}`,
            `${candidate.url} requires human sign-off or a resolved merge policy; daemon merge is held.`
          )
          .catch(() => false);
    }
  };
  return (now: number) => events.exclusive(() => sweep(now));
}
