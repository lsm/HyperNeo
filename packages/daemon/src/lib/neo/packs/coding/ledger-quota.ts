import { homedir } from 'node:os';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { runGhJson, type GhResponseQuota } from '../../../github/gh-lookup-helpers.ts';
import type { ConnectorOutcome } from '../../../github/connectors/connector.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';
import { isRateLimitError } from '../../../session/rate-limit-detector.ts';
import { CODING_LEDGER_MIN_RATE } from './pr-ledger.ts';

export type LedgerQuota = GhResponseQuota & {
  credentialBucket?: string | null;
  retryAt?: number;
  deferred?: boolean;
  identityRefused?: boolean;
};
export type LedgerQuotaRun = (
  args: string[],
  resource: 'core' | 'graphql'
) => Promise<ConnectorOutcome & { quota?: LedgerQuota }>;
export async function runCodingGh(
  args: string[],
  resourceHint: 'core' | 'graphql'
): ReturnType<LedgerQuotaRun> {
  let quota: GhResponseQuota | undefined;
  const result = await runGhJson(args, homedir(), spawnProcess, {
    resourceHint,
    onResponse: (value) => {
      quota = value;
    },
  });
  return { ...result, quota };
}
const Account = z.object({ id: z.number(), url: z.string().url() });
const projectQuota = (superpipe({})('coding-ledger-credential-quota') as PipelineAPI)
  .input(['result', 'bucket', 'now'])
  .pipe(
    (result: Awaited<ReturnType<LedgerQuotaRun>>, bucket: string | null, now: number) => {
      if (!result.quota) return undefined;
      const quota: LedgerQuota = { ...result.quota, credentialBucket: bucket };
      const limited = !result.ok && isRateLimitError(result.error);
      const delay = quota.retryAfterMs ?? (limited && !result.ok ? result.retryAfterMs : undefined);
      const retryAt =
        delay !== undefined
          ? now + delay
          : quota.remaining !== null &&
              quota.remaining < (quota.resource === 'graphql' ? CODING_LEDGER_MIN_RATE : 1)
            ? quota.resetAt
            : null;
      if (retryAt && retryAt > now) quota.retryAt = retryAt;
      return quota;
    },
    ['result', 'bucket', 'now'],
    'quota'
  )
  .end('quota') as (
  result: Awaited<ReturnType<LedgerQuotaRun>>,
  bucket: string | null,
  now: number
) => LedgerQuota | undefined;

type ScopedQuotaRead = (
  args: string[] | undefined,
  resource: 'core' | 'graphql',
  previous?: LedgerQuota
) => ReturnType<LedgerQuotaRun>;
export function createCodingQuotaReader(run: LedgerQuotaRun): ScopedQuotaRead & {
  preflight: (resource: 'core' | 'graphql', previous?: LedgerQuota) => ReturnType<LedgerQuotaRun>;
} {
  let identityAt = -Infinity,
    bucket: string | null = null;
  const cooldowns = new Map<string, LedgerQuota>();
  let identityFailure: LedgerQuota | undefined;
  const defer = (quota: LedgerQuota): Awaited<ReturnType<LedgerQuotaRun>> => ({
    ok: false,
    error: 'GitHub acquisition cooldown',
    retryAfterMs: quota.retryAt! - Date.now(),
    quota: { ...quota, deferred: true },
  });
  const read: ScopedQuotaRead = async (args, resource, previous) => {
    const now = Date.now();
    const refused = identityFailure ?? (previous?.identityRefused ? previous : undefined);
    if (refused?.retryAt && refused.retryAt > now) return defer(refused);
    if (identityFailure) {
      identityFailure = undefined;
      identityAt = -Infinity;
    }
    if (now - identityAt >= 5 * 60_000) {
      const account = await run(['gh', 'api', 'user'], 'core');
      const parsed = Account.safeParse(account.ok ? account.data : null);
      bucket = parsed.success ? `${new URL(parsed.data.url).host}:user:${parsed.data.id}` : null;
      identityAt = now;
      if (
        !account.ok &&
        (isRateLimitError(account.error) ||
          account.quota?.remaining === 0 ||
          account.quota?.retryAfterMs != null ||
          account.quota?.status === 429)
      ) {
        const quota = projectQuota(
          {
            ...account,
            quota: account.quota ?? {
              status: null,
              resource: null,
              remaining: null,
              resetAt: null,
              requestId: null,
              retryAfterMs: Math.min(account.retryAfterMs ?? 60000, 60000),
            },
          },
          null,
          now
        );
        if (quota?.retryAt) {
          identityFailure = { ...quota, identityRefused: true };
          return defer(identityFailure);
        }
        return { ...account, quota };
      }
    }
    const key = bucket ? `${bucket}:${resource}` : null;
    if (
      key &&
      previous?.credentialBucket === bucket &&
      previous.resource === resource &&
      previous.retryAt &&
      previous.retryAt > (cooldowns.get(key)?.retryAt ?? 0)
    )
      cooldowns.set(key, previous);
    const paused = key ? cooldowns.get(key) : undefined;
    if (paused?.retryAt && paused.retryAt > now) return defer(paused);
    if (!args) return { ok: true, data: null };
    const result = await run(args, resource);
    const quota = projectQuota(result, bucket, now);
    if (!quota) return result;
    if (key && quota.resource === resource) {
      if (quota.retryAt) cooldowns.set(key, quota);
      else cooldowns.delete(key);
    }
    return { ...result, quota };
  };
  return Object.assign(read, {
    preflight: (resource: 'core' | 'graphql', previous?: LedgerQuota) =>
      read(undefined, resource, previous),
  });
}
