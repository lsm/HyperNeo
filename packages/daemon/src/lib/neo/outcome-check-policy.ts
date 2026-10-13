import { neoDaemonTickPath } from './needs-you.ts';

type Outcome = { text: string; check?: string | null };
type Check = 'coding.pr_merged' | 'coding.deployed';

function requiredCheck(item: Outcome): Check | null {
  const path = neoDaemonTickPath({ text: item.text, check: null, watch: [] });
  if (path === 'needs_deploy_check') return 'coding.deployed';
  return /\bmerged\b|\bmerge[ds]?\s+(?:to|into)\s+(?:dev|main|master|the\s+target\s+branch)\b/i.test(
    item.text
  )
    ? 'coding.pr_merged'
    : null;
}

function requireChecks<T extends Outcome>(
  items: readonly T[]
): { value: readonly T[] } | { reason: { ok: false; reason: string } } {
  const missing = items.flatMap((item) => {
    const check = requiredCheck(item);
    return check && item.check !== check ? [{ text: item.text, check }] : [];
  });
  return missing.length
    ? {
        reason: {
          ok: false,
          reason: `outcome_check_required: ${missing.map(({ text, check }) => `${JSON.stringify(text)} requires check ${check}`).join('; ')}. Keep the outcome pending; the daemon reads the check.`,
        },
      }
    : { value: items };
}

export const neoOutcomeCheckPolicy = { requiredCheck, requireChecks };
