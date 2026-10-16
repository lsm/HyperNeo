import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoCardView, NeoCardWaiting } from '@hyperneo/shared/types/neo-snapshot';
import { getRelativeTime } from '../lib/utils.ts';
import type { NeoWorkPrimary } from './work-actions.ts';
import { neoAppLabel } from './work-driver.ts';

const checkedPhases = new Set<NeoCardView['phase']>(['handed', 'running', 'needs_you', 'checking']);

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const NEO_CARD_UNCERTAIN = 'It may have started already. Check it before starting it again.';

export function neoCardWaits(card: NeoCardView): readonly NeoCardWaiting[] {
  return card.phase === 'proposed' ? (card.waitingFor ?? []) : [];
}

export function neoCardAutoStarts(card: NeoCardView): boolean {
  return !!card.autoStart && neoCardWaits(card).length > 0;
}

export function neoCardWaitLine(wait: NeoCardWaiting): string {
  if (wait.reason === 'prerequisite_cancelled') return `${wait.title} was cancelled`;
  if (wait.reason === 'prerequisite_missing') return `${wait.title} no longer exists`;
  if (wait.reason === 'dependency_outcomes_missing')
    return `${wait.title} has no outcome to wait for`;
  return wait.items.length
    ? `${wait.title}: ${wait.items.map((item) => item.text).join(', ')}`
    : wait.title;
}

export function neoCardLabel(card: NeoCardView): string {
  const waits = neoCardWaits(card);
  if (waits.length)
    return `${neoCardAutoStarts(card) ? 'Starts by itself after' : 'Waits for'} ${waits
      .map((wait) => wait.title)
      .join(', ')}`;
  if (!checkedPhases.has(card.phase)) return card.label;
  if (card.uncheckedSince) return `${card.label} · not checked since ${clock(card.uncheckedSince)}`;
  return card.checkedAt ? `${card.label} · checked ${clock(card.checkedAt)}` : card.label;
}

export function neoContinuedLabel(count: number): string {
  return `Neo continued it ${count === 1 ? 'once' : `${count} times`}`;
}

export function neoCardOpenLabel(card: NeoCardView | undefined): string {
  const app = neoAppLabel(card?.adapter ?? 'hyperneo-sessions');
  return app === 'HyperNeo' ? 'Open chat' : `Open in ${app}`;
}

export function neoCardPrimaryAction(
  card: NeoCardView,
  work: NeoWork,
  { waiting = false, chat = false }: { waiting?: boolean; chat?: boolean } = {}
): NeoWorkPrimary {
  const { kind, label, link } = card.primary;
  if (card.uncertain)
    return card.open.link
      ? {
          kind: 'open',
          label: `Check in ${neoAppLabel(card.adapter ?? 'hyperneo-sessions')}`,
          link: card.open.link,
        }
      : work.sessionId && chat
        ? { kind: 'chat', label: 'Open chat' }
        : { kind: 'none' };
  if (kind === 'start' || kind === 'retry') return { kind, label: label ?? '' };
  if (kind === 'close') return { kind, label: label ?? 'Close', link };
  if (work.status === 'queued' && waiting && work.sessionId && chat)
    return { kind: 'answer', label: 'Answer in chat', link: null };
  if ((kind === 'answer' || kind === 'open') && link) return { kind, label: label ?? '', link };
  if (work.sessionId && chat) return { kind: 'chat', label: 'Open chat' };
  return { kind: 'none' };
}

export function neoCardTone(
  card: NeoCardView,
  work: NeoWork,
  waiting: boolean
): NeoCardView['tone'] {
  return work.status === 'queued' && waiting ? 'warning' : card.tone;
}

export function neoCardMeta(card: NeoCardView, work: NeoWork, now = Date.now()): string | null {
  if (card.pr) return `PR ${card.pr.number}`;
  if (work.status === 'proposed') return null;
  const when = getRelativeTime(work.createdAt, now);
  const neverStarted = !work.sessionId && (work.status === 'cancelled' || card.retryable);
  return neverStarted ? when : `Started ${when}`;
}
