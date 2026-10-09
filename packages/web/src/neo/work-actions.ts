import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkDriverReceipt, NeoWorkPrReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { getRelativeTime } from '../lib/utils.ts';
import { neoWorkDriverApp, neoWorkDriverLink } from './work-driver.ts';
import { neoWorkPrNumber } from './work-prs.ts';

export type NeoWorkPrimary =
  | { readonly kind: 'start'; readonly label: string }
  | { readonly kind: 'retry'; readonly label: string }
  | { readonly kind: 'answer'; readonly label: string; readonly link: string | null }
  | { readonly kind: 'open'; readonly label: string; readonly link: string }
  | { readonly kind: 'chat'; readonly label: string }
  | { readonly kind: 'none' };

const startFailure = 'Could not start the execution';

export function neoWorkOpenLabel(driver: NeoWorkDriverReceipt | undefined): string {
  const app = driver ? neoWorkDriverApp(driver) : 'HyperNeo';
  return app === 'HyperNeo' ? 'Open chat' : `Open in ${app}`;
}

export function neoWorkPrimaryAction(
  work: NeoWork,
  driver: NeoWorkDriverReceipt | undefined,
  { waiting = false, chat = false }: { waiting?: boolean; chat?: boolean } = {}
): NeoWorkPrimary {
  if (work.status === 'proposed') return { kind: 'start', label: 'Start work' };
  if (work.status === 'failed' && !work.sessionId && work.report?.startsWith(startFailure))
    return { kind: 'retry', label: 'Retry' };
  if (work.status === 'queued' && waiting && work.sessionId && chat)
    return { kind: 'answer', label: 'Answer in chat', link: null };
  const link = work.sessionId ? null : neoWorkDriverLink(driver);
  if (link && driver)
    return work.status === 'queued' && driver.status === 'needs_you'
      ? { kind: 'answer', label: `Answer in ${neoWorkDriverApp(driver)}`, link }
      : { kind: 'open', label: neoWorkOpenLabel(driver), link };
  if (work.sessionId && chat) return { kind: 'chat', label: 'Open chat' };
  return { kind: 'none' };
}

export function neoWorkPresentation(
  work: NeoWork,
  driver: NeoWorkDriverReceipt | undefined,
  { compact, attention }: { compact: boolean; attention: boolean }
): 'summary' | 'detail' {
  if (!compact || attention) return 'detail';
  return neoWorkPrimaryAction(work, driver).kind === 'retry' ? 'detail' : 'summary';
}

export function neoWorkMeta(
  work: NeoWork,
  prs: NeoWorkPrReceipt | undefined,
  now = Date.now()
): string | null {
  const pr = neoWorkPrNumber(prs);
  if (pr) return `PR ${pr}`;
  if (work.status === 'proposed') return null;
  const when = getRelativeTime(work.createdAt, now);
  const neverStarted =
    !work.sessionId &&
    (work.status === 'cancelled' ||
      (work.status === 'failed' && !!work.report?.startsWith(startFailure)));
  return neverStarted ? when : `Started ${when}`;
}
