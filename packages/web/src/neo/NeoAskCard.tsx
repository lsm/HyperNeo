import type { NeoAskItem, NeoAskSessionView } from '@hyperneo/shared/types/neo-snapshot';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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
import {
  type NeoAskItemAction,
  type NeoAskOutcome,
  type NeoAskView,
  isNeoAskQuestionItem,
  neoAskItemActions,
  neoAskOpenTarget,
} from './neo-asks.ts';
import type { NeoScene, NeoSceneCards } from './neo-scenes.ts';
import { neoAppLabel, neoAppLogo, neoSessionLink } from './work-driver.ts';
import { isNeoSummarized } from './neo-ask-detail.ts';
import type { NeoQuote } from './neo-intake.ts';
import { neoQuestionReply } from './reply-context.ts';

const tones = {
  attention: 'text-warning bg-warning/10',
  running: 'text-accent bg-accent/10',
  achieved: 'text-success bg-success/10',
  ended: 'text-fg-muted bg-fill-soft',
};

function stepGlyph(scene: NeoScene, done: boolean): { mark: string; color: string } {
  if (done) return { mark: '✓', color: 'text-success' };
  if (scene.group === 'attention') return { mark: '!', color: 'text-warning' };
  if (scene.group === 'running') return { mark: '●', color: 'text-accent' };
  if (scene.receipt.kind === 'work' && scene.receipt.status === 'cancelled')
    return { mark: '–', color: 'text-fg-faint' };
  return { mark: '!', color: 'text-warning' };
}

function StepRow({
  scene,
  done,
  control,
}: {
  scene: NeoScene;
  done: boolean;
  control?: ComponentChildren;
}) {
  const glyph = stepGlyph(scene, done);
  const title = scene.receipt.kind === 'work' ? scene.receipt.title : scene.label;
  return (
    <div
      data-ask-step={scene.ref.id}
      data-neo-work={scene.ref.id}
      class="flex min-w-0 items-baseline gap-2 text-sm"
    >
      <span aria-hidden="true" class={`w-3 shrink-0 text-center text-xs ${glyph.color}`}>
        {glyph.mark}
      </span>
      <span class="min-w-0 flex-1">
        <span class="line-clamp-2 break-words" title={title}>
          {title}
        </span>
        <span class="block break-words text-xs text-fg-faint">{scene.label}</span>
      </span>
      {control}
    </div>
  );
}

const sessionStates: Record<NeoAskSessionView['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  needs_you: 'Needs you',
  done: 'Idle',
  failed: 'Failed',
  stopped: 'Stopped',
};

function SessionRow({
  session,
  onOpenSession,
}: {
  session: NeoAskSessionView;
  onOpenSession?: (sessionId: string, title: string) => void;
}) {
  const state =
    session.kind === 'needs_you'
      ? 'Needs you'
      : session.kind === 'failed'
        ? 'Failed'
        : sessionStates[session.status];
  const local = session.open.sessionId && !session.open.daemon ? session.open.sessionId : null;
  const link = local ? null : neoSessionLink(session.open.link, session.open.daemon);
  const body = (
    <>
      <NeoAppMark logo={neoAppLogo(session.adapter)} />
      <span class="min-w-0 flex-1">
        <span class="line-clamp-2 break-words" title={session.title}>
          {session.title}
        </span>
        <span
          class={`block truncate text-xs ${
            session.kind === 'needs_you'
              ? 'text-warning'
              : session.kind === 'failed'
                ? 'text-danger'
                : 'text-fg-faint'
          }`}
        >
          {neoAppLabel(session.adapter)} · {state}
        </span>
      </span>
    </>
  );
  const rowClass = 'flex w-full min-w-0 items-start gap-2 text-left text-sm';
  if (local && onOpenSession)
    return (
      <button
        type="button"
        data-ask-session={session.key}
        class={`${rowClass} hover:text-accent`}
        aria-label={`Open ${session.title}`}
        onClick={() => onOpenSession(local, session.title)}
      >
        {body}
      </button>
    );
  return link ? (
    <a
      data-ask-session={session.key}
      href={link}
      class={`${rowClass} hover:text-accent`}
      aria-label={`Open ${session.title}`}
    >
      {body}
    </a>
  ) : (
    <div data-ask-session={session.key} class={rowClass}>
      {body}
    </div>
  );
}

const itemGlyphs: Record<NeoAskItem['state'], { mark: string; color: string }> = {
  met: { mark: '✓', color: 'text-success' },
  needs_you: { mark: '!', color: 'text-warning' },
  reported: { mark: '?', color: 'text-warning' },
  pending: { mark: '○', color: 'text-fg-faint' },
};

function ItemRow({ item, waitingForPr }: { item: NeoAskItem; waitingForPr?: boolean }) {
  const glyph = itemGlyphs[item.state];
  const tags = [
    item.removed && 'removed',
    item.addedAt !== null && !item.removed && 'added',
    item.state === 'met' && item.metBy === 'daemon' && 'verified',
    item.state === 'met' && item.metBy === 'human' && 'confirmed by you',
    item.state === 'met' && item.metBy === 'neo' && 'Neo says done, not verified',
    item.state === 'needs_you' && 'needs you',
    item.state === 'reported' && 'reported, not verified',
  ].filter(Boolean);
  return (
    <li data-ask-item={item.id} class="flex min-w-0 items-baseline gap-2 text-sm">
      <span aria-hidden="true" class={`w-3 shrink-0 text-center text-xs ${glyph.color}`}>
        {glyph.mark}
      </span>
      <span class="min-w-0 flex-1">
        <span
          class={`break-words ${item.removed ? 'text-fg-faint line-through' : item.state === 'met' ? 'text-fg-muted' : 'text-fg'}`}
        >
          {item.text}
        </span>
        {tags.length > 0 && <span class="ml-2 text-xs text-fg-faint">{tags.join(' · ')}</span>}
        {waitingForPr && <span class="block text-xs text-fg-faint">等 PR 开出来</span>}
        {item.removed && item.removedReason && (
          <span class="block break-words text-xs text-fg-faint">{item.removedReason}</span>
        )}
        {item.evidence && (item.state === 'met' || item.state === 'reported') && (
          <span class="block truncate text-xs text-fg-faint" title={item.evidence}>
            {item.evidence}
          </span>
        )}
      </span>
    </li>
  );
}

function Checklist({
  items,
  label,
  cards,
}: {
  items: readonly NeoAskItem[];
  label: string;
  cards?: NeoSceneCards;
}) {
  return (
    <ul aria-label={label} class="space-y-1.5">
      {items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          waitingForPr={
            !item.removed &&
            item.state !== 'met' &&
            item.check === 'coding.pr_merged' &&
            !item.watch?.length &&
            !cards?.get(item.deliveredBy ?? '')?.pr
          }
        />
      ))}
    </ul>
  );
}

function ActionRow({
  action,
  reply,
  onReply,
  onAnswer,
  disabled,
}: {
  action: NeoAskItemAction;
  reply: NeoQuote;
  onReply?: (quote: NeoQuote) => void;
  onAnswer?: (itemId: string, choice: string) => void;
  disabled?: boolean;
}) {
  return (
    <li id={reply.anchor} data-ask-item={action.itemId} class="min-w-0 text-sm">
      <p class="break-words font-medium text-fg">{action.question}</p>
      {action.options.length > 0 ? (
        <div class="mt-2 flex flex-wrap justify-end gap-2">
          {action.options.map((option, index) => (
            <button
              key={option}
              type="button"
              class={`${index === action.options.length - 1 ? neoPrimaryClass : neoSecondaryClass} max-w-full whitespace-normal break-words text-left`}
              disabled={disabled || !onAnswer}
              aria-label={`Answer ${action.question}: ${option}`}
              onClick={() => onAnswer?.(action.itemId, option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div class="mt-2 flex justify-end gap-2">
          <button
            type="button"
            class={neoSecondaryClass}
            disabled={disabled || !onReply}
            onClick={() => onReply?.(reply)}
          >
            <NeoChatMark />
            Reply in chat
          </button>
        </div>
      )}
    </li>
  );
}

export function NeoAskCard({
  view,
  cards,
  disabled = false,
  onSettle,
  onAnswer,
  onReply,
  onOpen,
  onOpenSession,
  onExpand,
  detailFailed = false,
  detailEpoch = 0,
}: {
  view: NeoAskView;
  cards?: NeoSceneCards;
  disabled?: boolean;
  onSettle?: (outcome: NeoAskOutcome) => void;
  onAnswer?: (itemId: string, choice: string) => void;
  onReply?: (quote: NeoQuote) => void;
  onOpen?: (workId: string) => void;
  onOpenSession?: (sessionId: string, title: string) => void;
  onExpand?: () => void;
  detailFailed?: boolean;
  detailEpoch?: number;
}) {
  const [open, setOpen] = useState(false);
  const { ask } = view;
  const summarized = isNeoSummarized(ask);
  const sceneStatuses = view.scenes
    .map((scene) => (scene.receipt.kind === 'work' ? scene.receipt.status : ''))
    .join();
  useEffect(() => {
    if (open && summarized) onExpand?.();
  }, [open, summarized, detailEpoch, ask.revision, sceneStatuses]);
  const tone =
    view.group === 'attention'
      ? 'attention'
      : ask.status === 'achieved'
        ? 'achieved'
        : view.group === 'outcomes'
          ? 'ended'
          : 'running';
  const itemActions = neoAskItemActions(view);
  const outcomes = view.items.filter((item) => !isNeoAskQuestionItem(item));
  const questions = view.items.filter((item) => isNeoAskQuestionItem(item) && item.state === 'met');
  const openControl = (scene: NeoScene) => {
    const target = neoAskOpenTarget({ ...view, scenes: [scene] }, cards);
    if (!target) return null;
    const name = `Open ${target.work.title}`;
    return target.link ? (
      <a href={target.link} class={neoSecondaryClass} aria-label={name}>
        <NeoAppMark logo={neoAppLogo(target.card?.adapter)} />
        Open
      </a>
    ) : onOpen ? (
      <button
        type="button"
        class={neoSecondaryClass}
        aria-label={name}
        onClick={() => onOpen(target.work.id)}
      >
        <NeoChatMark />
        Open
      </button>
    ) : null;
  };
  return (
    <article aria-label={ask.title} data-ask={ask.id} class={neoCardClass}>
      <div class="flex min-h-7 items-center gap-2">
        <NeoStatusChip
          tone={tone}
          colors={tones[tone]}
          label={view.label}
          pulse={tone === 'running'}
        />
        <span class="flex-1" />
        {onSettle && ask.status !== 'achieved' && ask.status !== 'abandoned' && (
          <Dropdown
            position="right"
            items={[
              { label: 'Mark done', onClick: () => onSettle('achieved'), disabled },
              {
                label: 'Drop this ask',
                onClick: () => onSettle('abandoned'),
                danger: true,
                disabled,
              },
            ]}
            trigger={
              <IconButton title="Ask actions" size="sm" class="text-fg-faint">
                <NeoMoreIcon />
              </IconButton>
            }
          />
        )}
      </div>
      {view.idleReason && <p class="mt-1 text-xs text-fg-muted">{view.idleReason}</p>}
      <h3 class="mt-2 line-clamp-3 break-words text-base font-semibold leading-snug">
        {ask.title}
      </h3>
      {view.summary && (
        <p class="mt-1.5 line-clamp-2 break-words text-sm text-fg-muted">{view.summary}</p>
      )}
      {itemActions.length > 0 && (
        <div data-ask-needs-you class="mt-3 rounded-lg bg-warning/10 px-3 py-2">
          <ul aria-label="Needs you" class="space-y-1.5">
            {itemActions.map((action) => (
              <ActionRow
                key={action.itemId}
                action={action}
                reply={neoQuestionReply(ask.id, action)}
                onReply={onReply}
                onAnswer={onAnswer}
                disabled={disabled}
              />
            ))}
          </ul>
        </div>
      )}
      <div class="mt-3 text-sm text-fg-muted" hidden={summarized}>
        <p class="text-xs font-medium text-fg-faint">To-dos</p>
        {outcomes.length > 0 ? (
          <div class="mt-1.5">
            <Checklist items={outcomes} label="To-dos" cards={cards} />
          </div>
        ) : (
          <p class="mt-1 whitespace-pre-wrap break-words">{ask.doneWhen}</p>
        )}
      </div>
      {view.scenes.length > 0 && (
        <div class="mt-3 space-y-2 border-l-2 border-line pl-3">
          {view.scenes.map((scene) => (
            <StepRow
              key={scene.ref.id}
              scene={scene}
              done={view.doneIds.has(scene.ref.id)}
              control={openControl(scene)}
            />
          ))}
        </div>
      )}
      {view.sessions.length > 0 && (
        <div class="mt-3 space-y-2 border-l-2 border-line pl-3" aria-label="Linked sessions">
          {view.sessions.map((session) => (
            <SessionRow key={session.key} session={session} onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
      {open && (
        <div data-ask-details class="mt-3 space-y-3">
          {summarized &&
            (detailFailed ? (
              <p role="status" class="text-xs text-fg-faint">
                Couldn’t load details.{' '}
                <button type="button" class={neoPlainClass} onClick={() => onExpand?.()}>
                  Retry
                </button>
              </p>
            ) : (
              <p role="status" class="text-xs text-fg-faint">
                Loading details…
              </p>
            ))}
          {questions.length > 0 && (
            <div class="text-sm text-fg-muted">
              <p class="text-xs font-medium text-fg-faint">Answered questions</p>
              <div class="mt-1.5">
                <Checklist items={questions} label="Answered questions" />
              </div>
            </div>
          )}
          {ask.outcome && ask.outcome.trim() !== view.summary && (
            <div class="text-sm text-fg-muted">
              <p class="text-xs font-medium text-fg-faint">Outcome</p>
              <p class="mt-1 whitespace-pre-wrap break-words">{ask.outcome}</p>
            </div>
          )}
        </div>
      )}
      <div class={neoFooterClass}>
        <span class="flex-1" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          class={neoPlainClass}
        >
          Details
          <NeoIcon
            name="chevron"
            class={`!h-3.5 !w-3.5 transition-transform${open ? '' : ' rotate-180'}`}
          />
        </button>
      </div>
    </article>
  );
}
