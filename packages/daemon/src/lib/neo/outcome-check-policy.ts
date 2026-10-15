import type { NeoAskItemOutcomeKind } from '@hyperneo/shared/types/neo-snapshot';
import { neoDaemonTickPath } from './needs-you.ts';

type Outcome = {
  text: string;
  check?: string | null;
  outcomeKind?: NeoAskItemOutcomeKind;
  deliveredBy?: string | null;
};
type Check = 'coding.pr_merged' | 'coding.deployed';

function requiredCheck(item: Outcome): Check | null {
  if (item.outcomeKind === 'answer') return null;
  const path = neoDaemonTickPath({ text: item.text, check: null, watch: [] });
  if (path === 'needs_deploy_check') return 'coding.deployed';
  const mergesPr =
    /\bmerg(?:e[ds]?|ing)\b/i.test(item.text) &&
    /\bPRs?\b|\bpull requests?\b|github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b/i.test(item.text);
  const mergesToBranch =
    /\bmerg(?:e[ds]?|ing)\s+(?:to|into)\s+(?:dev|main|master|the\s+target\s+branch)\b/i.test(
      item.text
    );
  return mergesPr || mergesToBranch ? 'coding.pr_merged' : null;
}

const BEYOND_OPENED = /\b(merg\w*|deploy\w*|releas\w*|ship\w*|land\w*|tested|tests? pass\w*|CI)\b/i;

function requireOpenedOnly<T extends Outcome>(
  items: readonly T[]
): { value: readonly T[] } | { reason: { ok: false; reason: string } } {
  const beyond = items.filter(
    (item) =>
      item.check === 'coding.pr_opened' && (BEYOND_OPENED.test(item.text) || !!item.deliveredBy)
  );
  return beyond.length
    ? {
        reason: {
          ok: false,
          reason: `opened_check_too_weak: ${beyond.map(({ text }) => JSON.stringify(text)).join('; ')} asks for more than an open pull request or is bound to a card; coding.pr_opened only fits an unbound outcome that a pull request is open.`,
        },
      }
    : { value: items };
}

function requireChecks<T extends Outcome>(
  items: readonly T[]
): { value: readonly T[] } | { reason: { ok: false; reason: string } } {
  const opened = requireOpenedOnly(items);
  if ('reason' in opened) return opened;
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
