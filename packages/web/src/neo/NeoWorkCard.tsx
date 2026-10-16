import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import { useMemo } from 'preact/hooks';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import {
  neoCardLabel,
  neoCardMeta,
  neoCardOpenLabel,
  neoCardTone,
  neoCardAutoStarts,
  neoCardWaitLine,
  neoCardWaits,
  NEO_CARD_UNCERTAIN,
  neoContinuedLabel,
} from './card-view.ts';
import {
  NeoAppMark,
  NeoChatMark,
  NeoMoreIcon,
  NeoStatusChip,
  neoCardClass,
  neoFooterClass,
  neoSecondaryClass,
} from './NeoCardParts.tsx';
import { NeoWorkQuestion } from './NeoWorkQuestion.tsx';
import { neoAppLogo } from './work-driver.ts';

const tones = {
  success: 'text-success bg-success/10',
  warning: 'text-warning bg-warning/10',
  accent: 'text-accent bg-accent/10',
};

const interactive =
  'button, a, summary, details, input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="button"]';

export type NeoWorkAction = 'start' | 'cancel' | 'done' | 'close' | 'retry';

function insideUserSelection(scope: Element): boolean {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  return (!!anchorNode && scope.contains(anchorNode)) || (!!focusNode && scope.contains(focusNode));
}

export function NeoWorkCard({
  work,
  card,
  busy,
  disabled,
  onAction,
  onOpen,
  onOpenWork,
  canOpenWork,
  presentation = 'detail',
  questionSlot,
  waiting = false,
  summary,
}: {
  work: NeoWork;
  card: NeoCardView;
  busy: boolean;
  disabled: boolean;
  onAction: (id: string, action: NeoWorkAction) => void;
  onOpen?: (id: string) => void;
  onOpenWork?: (id: string) => void;
  canOpenWork?: (id: string) => boolean;
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
  const label = neoCardLabel(card);
  const waits = neoCardWaits(card);
  const autoStart = neoCardAutoStarts(card);
  const tone = neoCardTone(card, work, waiting);
  const active = work.status === 'queued';
  const openLink = work.sessionId ? null : card.open.link;
  const answering = (waiting || card.primary.kind === 'answer') && !openLink;
  const meta = neoCardMeta(card, work);
  const configuration = [card.model, card.effort && `${card.effort} effort`]
    .filter(Boolean)
    .join(' · ');
  const logo = neoAppLogo(card.adapter);
  const goalText = card.goal;
  const doneWhen = card.doneWhen;
  const continuedCount = card.continued;
  const note =
    work.status === 'proposed'
      ? work.instruction
      : summary || (work.status === 'failed' ? work.report : null);
  const dependency = (
    <>
      {card.uncertain && (
        <p data-neo-uncertain class="mt-2 text-sm text-warning">
          {NEO_CARD_UNCERTAIN}
        </p>
      )}
      {waits.length > 0 && (
        <div data-neo-waits class="mt-2 text-sm">
          <p class="text-xs font-medium text-fg-faint">
            {autoStart ? 'Starts by itself once these are done' : 'Waits for'}
          </p>
          <ul class="mt-1 space-y-1">
            {waits.map((wait) => (
              <li key={wait.workId}>
                {onOpenWork && (canOpenWork?.(wait.workId) ?? true) ? (
                  <button
                    type="button"
                    class="break-words text-left text-fg-muted hover:text-accent"
                    onClick={() => onOpenWork(wait.workId)}
                  >
                    {neoCardWaitLine(wait)}
                  </button>
                ) : (
                  <span class="break-words text-fg-muted">{neoCardWaitLine(wait)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
  const chip = (
    <NeoStatusChip
      tone={tone}
      colors={tones[tone]}
      label={answering ? 'Waiting for your answer' : label}
      pulse={active}
    />
  );
  const metaText = meta && <span class="shrink-0 text-xs text-fg-faint">{meta}</span>;
  const link = openLink ? (
    <a href={openLink} class={neoSecondaryClass} aria-label={`Open ${work.title}`}>
      <NeoAppMark logo={logo} />
      {neoCardOpenLabel(card)}
    </a>
  ) : null;
  if (presentation === 'summary' && onOpen)
    return (
      <div
        data-neo-work={work.id}
        class="rounded-2xl border border-line bg-surface hover:border-accent/40"
      >
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
          {card.talk && (
            <span class="text-sm text-fg-muted">{card.talk} Open it and tell it yourself.</span>
          )}
          {note && <span class="line-clamp-2 break-words text-sm text-fg-muted">{note}</span>}
          {configuration && (
            <span class="break-words text-xs text-fg-muted">Started with {configuration}</span>
          )}
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
        {(waits.length > 0 || card.uncertain) && <div class="mx-4 mb-3">{dependency}</div>}
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
  const footer = (link || chatButton || meta) && (
    <div class={neoFooterClass}>
      {link || chatButton}
      <span class="flex-1" />
      {metaText}
    </div>
  );
  return (
    <article
      aria-label={work.title}
      data-neo-work={work.id}
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
                label: active ? 'Stop work' : 'Close work',
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
      {configuration && (
        <p class="mt-1 break-words text-xs text-fg-muted">Started with {configuration}</p>
      )}
      {dependency}
      {card.talk && (
        <p class="mt-2 text-sm text-fg-muted">{card.talk} Open it and tell it yourself.</p>
      )}
      {note && (
        <p
          class={`mt-1.5 line-clamp-2 break-words text-sm text-fg-muted${
            work.status === 'proposed' ? ' whitespace-pre-wrap' : ''
          }`}
        >
          {note}
        </p>
      )}
      {presentation === 'detail' && card.replyUnverified && (
        <p data-reply-unverified class="mt-1 break-words text-xs text-fg-muted">
          {card.replyUnverified}
        </p>
      )}
      {presentation === 'detail' && goalText && (
        <p class="mt-2 break-words text-sm text-fg-soft">
          <span class="text-fg-muted">Goal: </span>
          {goalText}
        </p>
      )}
      {presentation === 'detail' && continuedCount > 0 && (
        <p class="mt-1 text-xs text-fg-muted" title={card.continuedMessage ?? undefined}>
          {neoContinuedLabel(continuedCount)}
        </p>
      )}
      {presentation === 'detail' && doneWhen && (
        <details class="mt-1 text-sm text-fg-muted">
          <summary class="cursor-pointer select-none">Done when</summary>
          <p class="mt-1 whitespace-pre-wrap break-words">{doneWhen}</p>
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
