import {
  CODING_DAEMON_MERGE_MAX_ATTEMPTS,
  planCodingMergeAttempt,
  runCodingMergeAttempt,
} from './daemon-merge-attempt.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { CodingPrLedgerRepository, CodingMergePolicy } from './pr-ledger.ts';
import type { CodingPrEventRepository } from './pr-events.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';
import { readCodingDaemonMergeFacts } from './daemon-merge-facts.ts';
import { decideCodingDaemonMerge } from './daemon-merge-gates.ts';

const log = new Logger('CodingDaemonMerge');

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
      : decision.kind === 'skip' || decision.kind === 'read_failure'
        ? decision.reason
        : decision.kind;
  return decision.kind === 'merge' && decision.head === observed.head && observed.approvedGreen
    ? { value: observed }
    : { reason: decision.kind === 'merge' ? 'ledger_head_or_approval_changed' : reason };
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
  const read = async (url: string) => {
    const facts = await readCodingDaemonMergeFacts(database(), url, spawn);
    if (!facts.ok) log.warn('Daemon merge held', { url, reason: facts.reason });
    return facts;
  };
  const notify = async (receipt: Receipt, now: number) => {
    if (!receipt.mergeCommit && receipt.heldNotifiedAt) return true;
    const { owner: org, repo, number } = parsePrUrl(receipt.url)!;
    const { owner } = await events.routeLater({ repo: `${org}/${repo}`, number: +number });
    const key = `coding-daemon-${receipt.mergeCommit ? 'merged' : 'held'}:${receipt.url}:${receipt.head}`;
    const text = receipt.mergeCommit
      ? `Merge confirmed: ${receipt.url} head ${receipt.head}, commit ${receipt.mergeCommit}. Receipt executor ${receipt.actor}; confirmation sweep ${new Date(receipt.mergedAt!).toISOString()}.`
      : `Daemon merge held: ${receipt.url} head ${receipt.head}. No merge confirmed; automatic retries are held. Inspect GitHub/auth status and the receipt before manual action.`;
    const told = owner && (await delivery.tell(owner, key, text).catch(() => false));
    const notified = told || (await delivery.wake(key, text).catch(() => false));
    if (notified)
      await record({ ...receipt, kind: receipt.mergeCommit ? 'notified' : 'held', at: now });
    return notified;
  };
  const retryLimit = async (url: string, head: string) => {
    const [failure] = await record({ kind: 'failures', url, head });
    if (!failure || (failure.failures ?? 0) < CODING_DAEMON_MERGE_MAX_ATTEMPTS) return false;
    await delivery
      .wake(
        `coding-daemon-retry-limit:${url}:${head}`,
        `Daemon merge stopped after ${failure.failures} failed attempts: ${url} head ${head}. Last error: ${failure.error}. Inspect GitHub and resolve the failure before manual action.`
      )
      .catch(() => false);
    return true;
  };
  const finish = async (
    receipt: Receipt,
    pr: Observed['facts'],
    now: number,
    error: string | null = null
  ) => {
    const outcome = planCodingMergeAttempt(receipt.head, pr, error ?? receipt.error ?? null);
    if (!pr.ok && error)
      await record({ ...receipt, kind: 'uncertain', at: receipt.startedAt, error });
    if (error) log.warn('Daemon merge held', { url: receipt.url, reason: error });
    if (outcome.kind === 'retry') {
      if (!error) log.warn('Daemon merge held', { url: receipt.url, reason: outcome.error });
      await record({ ...receipt, kind: 'failed', at: receipt.startedAt, error: outcome.error });
      await record({ ...receipt, kind: 'void', at: receipt.startedAt });
      await retryLimit(receipt.url, receipt.head);
      return;
    }
    if (outcome.kind === 'confirmed') {
      const [merged] = await record({
        ...receipt,
        kind: 'finish',
        commit: outcome.commit,
        at: now,
      });
      if (merged) await notify(merged, now);
    } else if (pr.ok && (await notify(receipt, now)) && pr.state !== 'OPEN') {
      await record({ ...receipt, kind: 'retired', at: now });
    }
  };
  const merge = (superpipe({})('coding.sweep-daemon-merge') as PipelineAPI)
    .input(['observed', 'now'])
    .pipe(admit, 'observed', 'result:result')
    .pipe(
      async (observed: Observed, now: number) => {
        const { url, head } = observed;
        const [receipt] = await record({ kind: 'begin', url, head, actor, at: now });
        return receipt
          ? { value: receipt }
          : { reason: (await retryLimit(url, head)) ? 'retry_limit_reached' : 'already_attempted' };
      },
      ['result', 'now'],
      'result:result'
    )
    .pipe(
      async (receipt: Receipt, observed: Observed, now: number) => {
        const { owner, repo } = parsePrUrl(receipt.url)!;
        let admitted = false;
        try {
          observed = { ...observed, facts: await read(receipt.url) };
          const fresh = admit({ ...observed, policy: ledger.policy(`${owner}/${repo}`) });
          if ('reason' in fresh) return fresh.reason;
          admitted = true;
        } finally {
          if (!admitted) await record({ ...receipt, kind: 'void', at: receipt.startedAt });
        }
        // oxlint-disable-next-line no-warning-comments -- TODO(#9458): accepted final-read/in-flight-writer race.
        const error = await runCodingMergeAttempt(receipt.url, receipt.head, spawn);
        const facts = await read(receipt.url);
        await finish(receipt, facts, now, error);
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
    for (const receipt of receipts) {
      if (!facts.get(receipt.url)!.ok) continue;
      if (receipt.mergeCommit) await notify(receipt, now);
      else await finish(receipt, facts.get(receipt.url)!, now);
    }
    for (const candidate of candidates) {
      if (!facts.get(candidate.url)!.ok) continue;
      const outcome = await merge({ ...candidate, facts: facts.get(candidate.url)! }, now);
      if (
        typeof outcome === 'string' &&
        !['attempted', 'read_failure', 'already_attempted'].includes(outcome)
      )
        log.warn('Daemon merge held', { url: candidate.url, reason: outcome });
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
