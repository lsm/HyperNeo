import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  NEO_WORK_CONTINUE_LIMIT,
  type NeoWorkContinue,
  type NeoWorkDriverReceipt,
  type NeoWorkGoal,
  type NeoWorkPrReceipt,
} from '@hyperneo/shared/types/neo-snapshot';
import { useMemo } from 'preact/hooks';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import {
  NeoAppMark,
  NeoChatMark,
  NeoMoreIcon,
  NeoStatusChip,
  neoCardClass,
  neoFooterClass,
  neoPlainClass,
  neoPrimaryClass,
  neoSecondaryClass,
} from './NeoCardParts.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoWorkQuestion } from './NeoWorkQuestion.tsx';
import { neoWorkMeta, neoWorkPrimaryAction } from './work-actions.ts';
import { neoWorkDriverLabel, neoWorkDriverLogo } from './work-driver.ts';
import { neoWorkPrInProgress, neoWorkPrLabel, neoWorkPrSetback } from './work-prs.ts';

const labels: Record<NeoWork['status'], string> = {
  proposed: 'Your call',
  queued: 'Handed to HyperNeo',
  reported: 'Response ready',
  failed: 'Failed',
  cancelled: 'Stopped',
};

const tones = {
  success: 'text-success bg-success/10',
  warning: 'text-warning bg-warning/10',
  accent: 'text-accent bg-accent/10',
};

function neoWorkTone(
  work: NeoWork,
  driver: NeoWorkDriverReceipt | undefined,
  waiting: boolean,
  prs?: NeoWorkPrReceipt
): keyof typeof tones {
  const status = work.status === 'queued' ? driver?.status : null;
  if (work.status === 'reported') {
    if (neoWorkPrInProgress(prs)) return 'accent';
    return neoWorkPrSetback(prs) ? 'warning' : 'success';
  }
  if (
    (work.status === 'queued' && waiting) ||
    work.status === 'failed' ||
    work.status === 'cancelled' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'needs_you'
  )
    return 'warning';
  return 'accent';
}

const interactive =
  'button, a, summary, details, input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="button"]';

export type NeoWorkAction = 'start' | 'cancel' | 'done' | 'close' | 'retry';

export function sceneOpenSelector(id: string): string {
  return `[data-scene-open="${id.replace(/["\\]/g, '\\$&')}"]`;
}

function insideUserSelection(scope: Element): boolean {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  return (!!anchorNode && scope.contains(anchorNode)) || (!!focusNode && scope.contains(focusNode));
}

export function NeoWorkCard({
  work,
  driver,
  prs,
  goal,
  continued,
  busy,
  disabled,
  onAction,
  onOpen,
  presentation = 'detail',
  questionSlot,
  waiting = false,
  summary,
}: {
  work: NeoWork;
  driver?: NeoWorkDriverReceipt;
  prs?: NeoWorkPrReceipt;
  goal?: NeoWorkGoal;
  continued?: NeoWorkContinue;
  busy: boolean;
  disabled: boolean;
  onAction: (id: string, action: NeoWorkAction) => void;
  onOpen?: (id: string) => void;
  presentation?: 'detail' | 'summary';
  questionSlot?: (id: string, node: HTMLElement | null, previous: HTMLElement | null) => void;
  waiting?: boolean;
  summary?: string;
}) {
  const attachQuestion = useMemo(() => {
    let previous: HTMLElement | null = null;
    return (node: HTMLElement | null) => {
      questionSlot?.(work.id, node, previous);
      previous = node;
    };
  }, [work.id, questionSlot]);
  const label =
    work.status === 'queued' && driver
      ? neoWorkDriverLabel(driver)
      : (work.status === 'reported' && neoWorkPrLabel(prs)) || labels[work.status];
  const tone = neoWorkTone(work, driver, waiting, prs);
  const active = work.status === 'queued';
  const primary = neoWorkPrimaryAction(work, driver, { waiting, chat: !!onOpen });
  const answering = primary.kind === 'answer' && !primary.link;
  const meta = neoWorkMeta(work, prs);
  const note =
    work.status === 'proposed'
      ? work.instruction
      : summary || (work.status === 'failed' ? work.report : null);
  const chip = (
    <NeoStatusChip
      tone={tone}
      colors={tones[tone]}
      label={answering ? 'Waiting for your answer' : label}
      pulse={active}
    />
  );
  const metaText = meta && <span class="shrink-0 text-xs text-fg-faint">{meta}</span>;
  const link =
    (primary.kind === 'open' || primary.kind === 'answer') && primary.link ? (
      <a
        href={primary.link}
        class={primary.kind === 'answer' ? neoPrimaryClass : neoSecondaryClass}
        aria-label={`Open ${work.title}`}
      >
        <NeoAppMark logo={neoWorkDriverLogo(driver)} />
        {primary.label}
      </a>
    ) : null;
  if (presentation === 'summary' && onOpen)
    return (
      <div class="rounded-2xl border border-line bg-surface hover:border-accent/40">
        <button
          type="button"
          data-scene-open={work.id}
          disabled={!work.sessionId}
          onClick={() => onOpen(work.id)}
          class={`grid w-full gap-2 px-4 pt-3.5 text-left focus-visible:outline-accent disabled:cursor-default${
            link ? '' : ' pb-3.5'
          }`}
          aria-label={work.sessionId ? `Open chat for ${work.title}` : work.title}
        >
          <span class="flex min-w-0 items-center">{chip}</span>
          <span class="line-clamp-3 break-words text-[15px] font-semibold leading-snug">
            {work.title}
          </span>
          {note && <span class="line-clamp-2 break-words text-sm text-fg-muted">{note}</span>}
          {!link && (work.sessionId || meta) && (
            <span class="mt-1 flex items-center gap-2 border-t border-line pt-3">
              {work.sessionId && (
                <span class={neoSecondaryClass}>
                  <NeoChatMark />
                  {answering ? 'Answer in chat' : 'Open chat'}
                </span>
              )}
              <span class="flex-1" />
              {metaText}
            </span>
          )}
        </button>
        {link && (
          <div class="mx-4 mb-3.5 mt-3 flex items-center gap-2 border-t border-line pt-3">
            {link}
            <span class="flex-1" />
            {metaText}
          </div>
        )}
      </div>
    );
  const openable = !!onOpen && !!work.sessionId && work.status !== 'proposed' && !answering;
  const closable = presentation === 'detail' && !answering && (active || work.status === 'failed');
  const chatButton = onOpen && work.sessionId && (
    <button type="button" onClick={() => onOpen(work.id)} class={neoSecondaryClass}>
      <NeoChatMark />
      Open chat
    </button>
  );
  const lead =
    primary.kind === 'retry' ? (
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => onAction(work.id, 'retry')}
        class={neoPrimaryClass}
      >
        <NeoIcon name="retry" class="!h-3.5 !w-3.5" />
        {busy ? 'Retrying…' : primary.label}
      </button>
    ) : answering ? (
      <button type="button" onClick={() => onOpen!(work.id)} class={neoPrimaryClass}>
        <NeoIcon name="external" class="!h-3.5 !w-3.5" />
        Answer in chat
      </button>
    ) : (
      link || (primary.kind === 'chat' && chatButton)
    );
  const footer =
    primary.kind === 'start' ? (
      <div class={neoFooterClass}>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => onAction(work.id, 'cancel')}
          class={`${neoPlainClass} hover:!bg-danger/10 hover:!text-danger`}
        >
          {busy ? 'Declining…' : 'Decline'}
        </button>
        <span class="flex-1" />
        {chatButton}
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => onAction(work.id, 'start')}
          class={neoPrimaryClass}
        >
          <NeoIcon name="arrow" class="!h-3.5 !w-3.5" />
          {busy ? 'Starting…' : primary.label}
        </button>
      </div>
    ) : (
      (lead || meta) && (
        <div class={neoFooterClass}>
          {lead}
          <span class="flex-1" />
          {metaText}
        </div>
      )
    );
  return (
    <article
      aria-label={work.title}
      data-scene-open={openable ? work.id : undefined}
      tabIndex={openable ? 0 : undefined}
      class={`${neoCardClass}${openable ? ' cursor-pointer transition-colors hover:border-accent/40' : ''}`}
      onClick={
        openable
          ? (event) => {
              const target = event.target as Element | null;
              if (!target || target.closest?.(interactive)) return;
              if (insideUserSelection(event.currentTarget as Element)) return;
              onOpen!(work.id);
            }
          : undefined
      }
      onKeyDown={
        openable
          ? (event) => {
              if (event.key === 'Enter' && event.target === event.currentTarget) onOpen!(work.id);
            }
          : undefined
      }
    >
      <div class="flex min-h-7 items-center gap-2">
        {chip}
        <span class="flex-1" />
        {closable && (
          <Dropdown
            position="right"
            items={[
              {
                label: 'Mark done',
                onClick: () => onAction(work.id, 'done'),
                disabled: disabled || busy,
              },
              {
                label: 'Cancel work',
                onClick: () => onAction(work.id, 'close'),
                danger: true,
                disabled: disabled || busy,
              },
            ]}
            trigger={
              <IconButton title="Card actions" size="sm" class="text-fg-faint">
                <NeoMoreIcon />
              </IconButton>
            }
          />
        )}
      </div>
      <h3 class="mt-2 line-clamp-3 break-words text-base font-semibold leading-snug">
        {work.title}
      </h3>
      {note && (
        <p
          class={`mt-1.5 line-clamp-2 break-words text-sm text-fg-muted${
            work.status === 'proposed' ? ' whitespace-pre-wrap' : ''
          }`}
        >
          {note}
        </p>
      )}
      {presentation === 'detail' && goal?.goal && (
        <p class="mt-2 break-words text-sm text-fg-soft">
          <span class="text-fg-muted">Goal: </span>
          {goal.goal}
        </p>
      )}
      {presentation === 'detail' && continued && (
        <p class="mt-1 text-xs text-fg-muted" title={continued.lastMessage}>
          Neo continued it {continued.count}/{NEO_WORK_CONTINUE_LIMIT}
        </p>
      )}
      {presentation === 'detail' && goal?.doneWhen && (
        <details class="mt-1 text-sm text-fg-muted">
          <summary class="cursor-pointer select-none">Done when</summary>
          <p class="mt-1 whitespace-pre-wrap break-words">{goal.doneWhen}</p>
        </details>
      )}
      {active &&
        work.sessionId &&
        (questionSlot ? (
          <div ref={attachQuestion} />
        ) : (
          <NeoWorkQuestion key={work.id} work={work} />
        ))}
      {footer}
    </article>
  );
}
