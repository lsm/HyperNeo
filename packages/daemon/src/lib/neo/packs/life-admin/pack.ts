import { NEO_PACK_LIFE_ADMIN_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoEvidence } from '../../evidence.ts';
import type { NeoPack, NeoPackBrief, NeoPackCheck } from '../types.ts';

export const LIFE_ADMIN_PACK_BRIEF: NeoPackBrief = {
  id: 'life-admin',
  describe:
    'Life admin: inbox, scheduling, orders, bookings, subscriptions, watches. Acts in the user’s own browser and accounts, proves results with confirmations.',
};

export const LIFE_ADMIN_CHECK_CONFIRMED = 'life-admin.confirmed';

export interface NeoLifeAdminConfirmation {
  key: string;
  from: string | null;
  date: string | null;
  subject: string | null;
  at: number | null;
}

const CONFIRMATION_LINE = /^[ \t]*(?:[-*\u2022][ \t]+)?`?Confirmation:[ \t]*(.+?)[ \t]*`?[ \t]*$/gm;
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseLifeAdminConfirmations(report: string): NeoLifeAdminConfirmation[] {
  const found: NeoLifeAdminConfirmation[] = [];
  for (const match of report.matchAll(CONFIRMATION_LINE)) {
    const fields = new Map<string, string>();
    for (const part of match[1].split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const value = part.slice(eq + 1).trim();
      if (value) fields.set(part.slice(0, eq).trim(), value);
    }
    const id = fields.get('id') ?? fields.get('event');
    if (!id) continue;
    const date = fields.get('date') ?? null;
    const at = date && ZONED_TIME.test(date) ? Date.parse(date) : Number.NaN;
    found.push({
      key: fields.has('id') ? `confirmation:${id}` : `confirmation:event:${id}`,
      from: fields.get('from') ?? null,
      date,
      subject: fields.get('subject') ?? null,
      at: Number.isNaN(at) ? null : at,
    });
  }
  return found;
}

export function lifeAdminConfirmationSummary(confirmation: NeoLifeAdminConfirmation): string {
  return [confirmation.from, confirmation.subject, confirmation.date]
    .filter((part): part is string => !!part)
    .join(' — ');
}

export function lifeAdminEvidence(
  confirmations: readonly NeoLifeAdminConfirmation[],
  startedAt: number
): NeoEvidence[] {
  return confirmations
    .filter((confirmation) => confirmation.at === null || confirmation.at >= startedAt)
    .map((confirmation) => ({
      key: confirmation.key,
      state: 'done',
      summary: lifeAdminConfirmationSummary(confirmation),
      blockers: [],
    }));
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'from',
  'with',
  'your',
  'you',
  'are',
  'was',
  'has',
  'have',
  'its',
  'their',
  'email',
  'mail',
  'inbox',
  'calendar',
  'confirmation',
  'confirmed',
  'confirm',
  'arrives',
  'arrived',
  'comes',
  'came',
  'notice',
  'sent',
  'send',
  'proof',
  'evidence',
  'done',
  'order',
  'orders',
  'booking',
  'bookings',
  'subscription',
  'subscriptions',
  'invoice',
  'payment',
  'receipt',
  'delivery',
  'shipment',
  'cancel',
  'cancelled',
  'cancellation',
  'renewal',
  'statement',
  'reservation',
  'appointment',
  'ticket',
  'purchase',
  'refund',
]);

export function lifeAdminItemTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

const DATE_SEGMENT = / \u2014 \d{4}-\d{2}-\d{2}.*$/;

const namesConfirmation = (tokens: readonly string[], entry: NeoEvidence): boolean => {
  const named = entry.summary.replace(DATE_SEGMENT, '').toLowerCase();
  return tokens.some((token) => new RegExp(`\\b${token.replace(/\./g, '\\.')}\\b`).test(named));
};

export const lifeAdminConfirmedCheck: NeoPackCheck = (item, evidence: readonly NeoEvidence[]) => {
  const tokens = lifeAdminItemTokens(item.text);
  const matched = evidence.filter(
    (entry) => entry.key.startsWith('confirmation:') && namesConfirmation(tokens, entry)
  );
  return matched.length
    ? { value: `Confirmed: ${matched.map((entry) => entry.summary).join(', ')}` }
    : { reason: 'not_confirmed' };
};

export function lifeAdminReportEvidence(work: NeoWork): NeoEvidence[] {
  return work.report
    ? lifeAdminEvidence(parseLifeAdminConfirmations(work.report), work.createdAt)
    : [];
}

export function createLifeAdminPack(): NeoPack {
  return {
    ...LIFE_ADMIN_PACK_BRIEF,
    instructions: () => NEO_PACK_LIFE_ADMIN_INSTRUCTIONS,
    workerMcpServers: ['chrome-devtools-user'],
    readEvidence: async (work: NeoWork) => {
      const evidence = lifeAdminReportEvidence(work);
      return evidence.length ? { evidence, read: { ok: true, okAt: Date.now() } } : null;
    },
    reportEvidence: lifeAdminReportEvidence,
    checks: { [LIFE_ADMIN_CHECK_CONFIRMED]: lifeAdminConfirmedCheck },
  };
}
