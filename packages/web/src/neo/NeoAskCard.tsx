import type {
  NeoAskItem,
  NeoAskSessionView,
  NeoCardView,
} from '@hyperneo/shared/types/neo-snapshot';
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

function stepGlyph(
  scene: NeoScene,
  done: boolean,
  card?: NeoCardView
): { mark: string; color: string } {
  if (scene.receipt.kind === 'work' && scene.receipt.status === 'proposed')
    return { mark: '○', color: 'text-fg-faint' };
  if (done) return { mark: '✓', color: 'text-success' };
  if (scene.group === 'attention') return { mark: '!', color: 'text-warning' };
  if (scene.group === 'running' && card && ['running', 'checking', 'pr_open'].includes(card.phase))
    return { mark: '●', color: 'text-accent' };
  return { mark: '○', color: 'text-fg-faint' };
}

function StepRow({
  scene,
  done,
  control,
  todos,
  cards,
}: {
  scene: NeoScene;
  done: boolean;
  control?: ComponentChildren;
  todos: readonly NeoAskItem[];
  cards?: NeoSceneCards;
}) {
  const owned = todos.filter((item) => !item.removed && item.deliveredBy === scene.ref.id);
  const glyph = stepGlyph(
    scene,
    owned.length ? owned.every((item) => item.state === 'met') : done,
    cards?.get(scene.ref.id)
  );
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
      <div class="min-w-0 flex-1">
        <span class="line-clamp-2 break-words" title={title}>
          {title}
        </span>
        <span class="block break-words text-xs text-fg-faint">
          {scene.receipt.kind === 'work' && scene.receipt.status === 'proposed'
            ? '等你决定'
            : scene.label}
        </span>
        <Checklist
          items={todos}
          step={{ id: scene.ref.id, title }}
          label={`做完 = ${title}`}
          cards={cards}
        />
      </div>
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
  reported: { mark: '○', color: 'text-fg-faint' },
  pending: { mark: '○', color: 'text-fg-faint' },
};

function ItemRow({
  item,
  waitingForPr,
  goal,
  progress,
}: {
  item: NeoAskItem;
  waitingForPr?: boolean;
  goal?: boolean;
  progress?: string;
}) {
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
          {goal && <span class="text-fg-faint">做完 = </span>}
          {item.text}
        </span>
        {tags.length > 0 && <span class="ml-2 text-xs text-fg-faint">{tags.join(' · ')}</span>}
        {waitingForPr && <span class="block text-xs text-fg-faint">等 PR 开出来</span>}
        {progress && <span class="block text-xs text-fg-faint">{progress}</span>}
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

function AnsweredQuestion({ item }: { item: NeoAskItem }) {
  const answer = item.answer;
  return (
    <li data-ask-answer={item.id} class="flex min-w-0 flex-wrap gap-x-2 text-sm text-fg-muted">
      <span>{answer?.choice ?? '选择未记录'}</span>
      {answer?.at != null ? (
        <time dateTime={new Date(answer.at).toISOString()} class="text-xs text-fg-faint">
          {new Date(answer.at).toLocaleString()}
        </time>
      ) : (
        <span class="text-xs text-fg-faint">时间未记录</span>
      )}
    </li>
  );
}

function Checklist({
  items,
  label,
  cards,
  step,
}: {
  items: readonly NeoAskItem[];
  label: string;
  cards?: NeoSceneCards;
  step?: { id: string; title: string };
}) {
  const listed = step ? items.filter((item) => item.deliveredBy === step.id) : items;
  if (!listed.length) return null;
  return (
    <ul aria-label={label} class="space-y-1.5">
      {listed.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          goal={!!step}
          progress={
            item.state !== 'met' && item.check === 'coding.pr_merged'
              ? cards?.get(item.deliveredBy ?? '')?.pr?.label
              : undefined
          }
          waitingForPr={
            !item.removed &&
            item.state !== 'met' &&
            item.check === 'coding.pr_merged' &&
            !item.watch?.some((url) => /\/pull\/\d+/i.test(url)) &&
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
  outcomes,
  cards,
}: {
  action: NeoAskItemAction;
  reply: NeoQuote;
  onReply?: (quote: NeoQuote) => void;
  onAnswer?: (itemId: string, choice: string) => void;
  disabled?: boolean;
  outcomes: readonly NeoAskItem[];
  cards?: NeoSceneCards;
}) {
  const todos = (step: { id: string; title: string }) => (
    <Checklist items={outcomes} label={`做完 = ${step.title}`} step={step} cards={cards} />
  );
  return (
    <li id={reply.anchor} data-ask-item={action.itemId} class="min-w-0 text-sm">
      <p class="break-words font-medium text-fg">{action.question}</p>
      {action.steps && action.steps.length > 1 && (
        <ol aria-label="待开始步骤" class="mt-2 list-decimal space-y-1 pl-5">
          {action.steps.map((step) => (
            <li key={step.id} data-question-step={step.id} class="break-words">
              {step.title}
              {todos(step)}
            </li>
          ))}
        </ol>
      )}
      {action.steps?.length === 1 && todos(action.steps[0])}
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
  const itemActions = [...view.humanActions];
  const questioned = new Set(
    itemActions.flatMap((action) => action.steps?.map((step) => step.id) ?? [])
  );
  const scenes = view.scenes.filter(
    (scene) =>
      scene.receipt.kind !== 'work' ||
      scene.receipt.status !== 'proposed' ||
      !questioned.has(scene.ref.id)
  );
  const outcomes = view.items.filter((item) => !isNeoAskQuestionItem(item));
  const visibleSteps = new Set([...scenes.map((scene) => scene.ref.id), ...questioned]);
  const unassigned = outcomes.filter(
    (item) => !item.deliveredBy || !visibleSteps.has(item.deliveredBy)
  );
  const questions = view.items.filter((item) => isNeoAskQuestionItem(item) && item.state === 'met');
  const openControl = (scene: NeoScene) => {
    const target = neoAskOpenTarget({ ...view, scenes: [scene] }, cards);
    if (!target) return null;
    const name = `打开 ${target.work.title}`;
    return target.link ? (
      <a href={target.link} class={neoSecondaryClass} aria-label={name}>
        <NeoAppMark logo={neoAppLogo(target.card?.adapter)} />
        打开
      </a>
    ) : onOpen ? (
      <button
        type="button"
        class={neoSecondaryClass}
        aria-label={name}
        onClick={() => onOpen(target.work.id)}
      >
        <NeoChatMark />
        打开
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
                outcomes={outcomes}
                cards={cards}
              />
            ))}
          </ul>
        </div>
      )}
      {scenes.length > 0 && (
        <div class="mt-3 space-y-2 border-l-2 border-line pl-3">
          {scenes.map((scene) => (
            <StepRow
              key={scene.ref.id}
              scene={scene}
              done={view.doneIds.has(scene.ref.id)}
              control={openControl(scene)}
              todos={outcomes}
              cards={cards}
            />
          ))}
        </div>
      )}
      {!summarized && (unassigned.length > 0 || !view.items.length) && (
        <div class="mt-3 text-sm text-fg-muted">
          <p class="text-xs font-medium text-fg-faint">还要</p>
          {unassigned.length > 0 ? (
            <Checklist items={unassigned} label="还要" cards={cards} />
          ) : (
            <p class="mt-1 whitespace-pre-wrap break-words">{ask.doneWhen}</p>
          )}
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
              <p class="text-xs font-medium text-fg-faint">已回答</p>
              <ul class="mt-1.5 space-y-1.5" aria-label="已回答">
                {questions.map((item) => (
                  <AnsweredQuestion key={item.id} item={item} />
                ))}
              </ul>
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
