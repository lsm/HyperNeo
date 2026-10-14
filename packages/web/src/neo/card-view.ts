import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import { getRelativeTime } from '../lib/utils.ts';
import type { NeoWorkPrimary } from './work-actions.ts';
import { neoAppLabel } from './work-driver.ts';

const checkedPhases = new Set<NeoCardView['phase']>(['handed', 'running', 'needs_you', 'checking']);

export function neoCardLabel(card: NeoCardView): string {
  if (!card.uncheckedSince || !checkedPhases.has(card.phase)) return card.label;
  const time = new Date(card.uncheckedSince).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${card.label} · not checked since ${time}`;
}

export function neoContinuedLabel(count: number): string {
  return `Neo continued it ${count === 1 ? 'once' : `${count} times`}`;
}

export function neoCardOpenLabel(card: NeoCardView | undefined): string {
  const app = neoAppLabel(card?.adapter ?? 'hyperneo');
  return app === 'HyperNeo' ? 'Open chat' : `Open in ${app}`;
}

export function neoCardPrimaryAction(
  card: NeoCardView,
  work: NeoWork,
  { waiting = false, chat = false }: { waiting?: boolean; chat?: boolean } = {}
): NeoWorkPrimary {
  const { kind, label, link } = card.primary;
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
