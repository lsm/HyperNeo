import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  type NeoAsk,
  type NeoCardAction,
  type NeoCardOpenTarget,
  type NeoCardPhase,
  type NeoCardPrimary,
  type NeoCardPrSummary,
  type NeoCardTone,
  type NeoCardView,
  type NeoWorkContinue,
  type NeoWorkDriverReceipt,
  type NeoWorkGoal,
  type NeoWorkPr,
  type NeoWorkPrReceipt,
  type NeoWorkSupersession,
  neoWorkPrVerdict,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { neoCardGroup, neoCardPhase, neoCardPrInProgress, neoHeadlinePr } from './card-phase.ts';

export type NeoCardViewParts = {
  refusals?: readonly { workId: string; what: string }[];
  work: readonly NeoWork[];
  drivers: readonly NeoWorkDriverReceipt[];
  prs: readonly NeoWorkPrReceipt[];
  goals: readonly NeoWorkGoal[];
  continues: readonly NeoWorkContinue[];
  supersessions: readonly NeoWorkSupersession[];
  asks: readonly NeoAsk[];
};

type CardIndex = {
  refusals: Map<string, string>;
  drivers: Map<string, NeoWorkDriverReceipt>;
  prs: Map<string, NeoWorkPr[]>;
  goals: Map<string, NeoWorkGoal>;
  continues: Map<string, NeoWorkContinue>;
  superseded: Set<string>;
  pooled: Set<string>;
};

const apps: Record<string, string> = {
  hyperneo: 'HyperNeo',
  space: 'a Space',
  'codex-desktop': 'Codex Desktop',
  'claude-desktop': 'Claude Code Desktop',
  'copilot-cli': 'GitHub Copilot',
  opencode: 'OpenCode',
};

const shortApps: Record<string, string> = {
  hyperneo: 'HyperNeo',
  space: 'Space',
  'codex-desktop': 'Codex',
  'claude-desktop': 'Claude Code',
  'copilot-cli': 'GitHub Copilot',
  opencode: 'OpenCode',
};

const workLabels: Record<NeoWork['status'], string> = {
  proposed: 'Your call',
  queued: 'Handed to HyperNeo',
  reported: 'Response ready',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export function neoCardSessionLink(
  driver: Pick<NeoWorkDriverReceipt, 'link' | 'daemon'> | undefined
): string | null {
  const link = driver?.link;
  if (!link || [...link].some((char) => char <= ' ' || char === '\\')) return null;
  if (/^(codex|claude|ghapp):\/\//.test(link)) return link;
  return !driver.daemon && /^\/(?!\/)/.test(link) ? link : null;
}

export function neoCardDriverLabel(driver: NeoWorkDriverReceipt): string {
  const app = `${apps[driver.adapter] ?? driver.adapter}${driver.daemon ? ` on ${driver.daemon}` : ''}`;
  if (driver.status === 'failed' || driver.status === 'stopped') return `Stopped in ${app}`;
  if (driver.abandoned) return `No result from ${app} in 3 days · close it?`;
  const unconfirmed = driver.unconfirmed ? ' · not confirmed it got this' : '';
  if (driver.status === 'needs_you') return `Needs you in ${app}${unconfirmed}`;
  if (driver.status === 'running') return `Running in ${app}${unconfirmed}`;
  if (driver.status === 'done') return `Idle in ${app} · Neo is checking${unconfirmed}`;
  return `Handed to ${app}${unconfirmed}`;
}

const prNumber = (pr: NeoWorkPr) => `#${pr.url.split('/').pop() ?? pr.url}`;

export function neoCardPrSummary(prs: readonly NeoWorkPr[]): NeoCardPrSummary | null {
  const pr = neoHeadlinePr(prs);
  if (!pr) return null;
  const number = prNumber(pr);
  const more = prs.length > 1 ? ` +${prs.length - 1}` : '';
  const state = {
    done: 'Merged',
    failed:
      pr.state === 'CLOSED'
        ? 'PR closed'
        : pr.checks === 'failing'
          ? 'Checks failing'
          : 'Changes requested',
    waiting: 'Waiting on CI',
    ready: 'Approved, not merged',
    pending: 'Waiting on review',
  }[neoWorkPrVerdict(pr)];
  return {
    number,
    label: `${state} · ${number}${more}`,
    count: prs.length,
    inProgress: neoCardPrInProgress(prs),
    setback: prs.some((item) => neoWorkPrVerdict(item) === 'failed'),
    merged: prs.filter((item) => item.state === 'MERGED').map(prNumber),
  };
}

export function neoCardPrimary(
  work: NeoWork,
  driver: NeoWorkDriverReceipt | undefined,
  talk = false
): NeoCardPrimary {
  if (work.status === 'proposed') return { kind: 'start', label: 'Start work', link: null };
  const link = work.sessionId ? null : neoCardSessionLink(driver);
  if (talk)
    return work.sessionId
      ? { kind: 'chat', label: 'Open chat', link: null }
      : { kind: 'open', label: 'Open session', link };
  if (driver?.retryable) return { kind: 'retry', label: 'Retry', link: null };
  if (
    work.status === 'queued' &&
    driver?.abandoned &&
    driver.status !== 'failed' &&
    driver.status !== 'stopped'
  )
    return { kind: 'close', label: 'Close', link };
  if (driver && work.status === 'queued' && driver.status === 'needs_you')
    return {
      kind: 'answer',
      label: work.sessionId
        ? 'Answer in chat'
        : `Answer in ${shortApps[driver.adapter] ?? driver.adapter}`,
      link,
    };
  if (!link || !driver)
    return work.sessionId
      ? { kind: 'chat', label: 'Open chat', link: null }
      : { kind: 'none', label: null, link: null };
  const app = shortApps[driver.adapter] ?? driver.adapter;
  return { kind: 'open', label: app === 'HyperNeo' ? 'Open chat' : `Open in ${app}`, link };
}

export function neoCardOpenTarget(
  work: NeoWork,
  driver: NeoWorkDriverReceipt | undefined
): NeoCardOpenTarget {
  const link = neoCardSessionLink(driver);
  const local =
    driver?.adapter === 'hyperneo' && !driver.daemon
      ? link?.match(/^\/session\/([A-Za-z0-9-]+)$/)?.[1]
      : undefined;
  return {
    link,
    remoteLink: driver?.remoteLink ?? null,
    sessionId: work.sessionId ?? local ?? null,
    daemon: driver?.daemon ?? null,
  };
}

export function neoSessionOpenTarget(session: {
  ref: { adapter: string; daemon?: string; id: string };
  link?: string;
  remoteLink?: string;
}): NeoCardOpenTarget {
  const daemon = session.ref.daemon ?? null;
  return {
    link: neoCardSessionLink({ link: session.link ?? null, daemon }),
    remoteLink: session.remoteLink ?? null,
    sessionId: session.ref.adapter === 'hyperneo' && !daemon ? session.ref.id : null,
    daemon,
  };
}

export function neoCardActions(work: NeoWork, retryable: boolean): NeoCardAction[] {
  if (work.status === 'proposed') return ['start', 'cancel'];
  const closable = work.status === 'queued' || work.status === 'failed';
  return [
    ...(retryable ? (['retry'] as const) : []),
    ...(closable ? (['done', 'close'] as const) : []),
  ];
}

export function neoCardTone(
  phase: NeoCardPhase,
  pr: NeoCardPrSummary | null,
  driver: NeoWorkDriverReceipt | undefined
): NeoCardTone {
  if (phase === 'abandoned') return driver?.status === 'needs_you' ? 'warning' : 'accent';
  if (phase === 'pr_open' || phase === 'pr_setback' || phase === 'merged' || phase === 'reported')
    return pr?.inProgress ? 'accent' : pr?.setback ? 'warning' : 'success';
  return phase === 'needs_you' || phase === 'stopped' || phase === 'failed' || phase === 'cancelled'
    ? 'warning'
    : 'accent';
}

export function indexNeoCardParts(parts: NeoCardViewParts): CardIndex {
  return {
    refusals: new Map(parts.refusals?.map((row) => [row.workId, row.what]) ?? []),
    drivers: new Map(parts.drivers.map((driver) => [driver.workId, driver])),
    prs: new Map(parts.prs.map((receipt) => [receipt.workId, receipt.prs])),
    goals: new Map(parts.goals.map((goal) => [goal.workId, goal])),
    continues: new Map(parts.continues.map((row) => [row.workId, row])),
    superseded: new Set(parts.supersessions.map((row) => row.workId)),
    pooled: new Set(parts.asks.filter((ask) => ask.pooled).flatMap((ask) => ask.workIds)),
  };
}

export function describeNeoCard(work: NeoWork, index: CardIndex): NeoCardView {
  const driver = index.drivers.get(work.id);
  const prs = index.prs.get(work.id) ?? [];
  const phase = neoCardPhase(work, driver, prs);
  const pr = neoCardPrSummary(prs);
  const goal = index.goals.get(work.id);
  const retryable = !!driver?.retryable;
  const talk = work.status === 'cancelled' ? undefined : index.refusals.get(work.id);
  return {
    ...(talk ? { talk } : {}),
    workId: work.id,
    phase,
    group: talk ? 'attention' : neoCardGroup(phase),
    tone: neoCardTone(phase, pr, driver),
    label:
      work.status === 'queued' && driver
        ? neoCardDriverLabel(driver)
        : (work.status === 'reported' && pr?.label) || workLabels[work.status],
    hidden: work.status === 'cancelled' && !work.sessionId,
    primary: neoCardPrimary(work, driver, !!talk),
    actions: neoCardActions(work, retryable),
    adapter: driver?.adapter ?? null,
    ...(driver?.model ? { model: driver.model } : {}),
    ...(driver?.effort ? { effort: driver.effort } : {}),
    open: neoCardOpenTarget(work, driver),
    pr,
    goal: goal?.goal ?? null,
    doneWhen: goal?.doneWhen ?? null,
    continued: index.continues.get(work.id)?.count ?? 0,
    continuedMessage: index.continues.get(work.id)?.lastMessage ?? null,
    pooled: index.pooled.has(work.id),
    superseded: index.superseded.has(work.id),
    uncheckedSince: driver?.uncheckedSince ?? null,
    unconfirmed: !!driver?.unconfirmed,
    abandoned: !!driver?.abandoned,
    retryable,
  };
}

export function describeNeoCards(parts: NeoCardViewParts, index: CardIndex): NeoCardView[] {
  return parts.work.map((work) => describeNeoCard(work, index));
}

export const projectNeoCardViews = (superpipe({})('neo-card-views') as PipelineAPI)
  .input(['parts'])
  .pipe(indexNeoCardParts, 'parts', 'index')
  .pipe(describeNeoCards, ['parts', 'index'], 'cards')
  .end('cards') as (parts: NeoCardViewParts) => NeoCardView[];
