import type { NeoAskItem, NeoAskSessionView } from '@hyperneo/shared/types/neo-snapshot';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { neoCardOpenLabel } from './card-view.ts';
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
  neoAskApproval,
  neoAskApprovalBadge,
  neoAskItemActions,
  neoAskOpenTarget,
  neoAskOutcomeCount,
} from './neo-asks.ts';
import type { NeoScene, NeoSceneCards } from './neo-scenes.ts';
import { neoAppLabel, neoAppLogo, neoSessionLink } from './work-driver.ts';
import { isNeoSummarized } from './neo-ask-detail.ts';

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

function StepRow({ scene, done }: { scene: NeoScene; done: boolean }) {
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
        <span class="block truncate text-xs text-fg-faint">{scene.label}</span>
      </span>
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

function ItemRow({ item, above }: { item: NeoAskItem; above?: NeoAskItemAction['kind'] }) {
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
        {above && (
          <button
            type="button"
            class="ml-2 text-xs text-accent hover:underline"
            onClick={(event) =>
              event.currentTarget
                .closest('[data-ask]')
                ?.querySelector(`[data-ask-needs-you] [data-ask-item="${item.id}"]`)
                ?.scrollIntoView({ block: 'nearest' })
            }
          >
            {above === 'confirm' ? 'Confirm above' : 'Answer above'}
          </button>
        )}
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
  answerable,
}: {
  items: readonly NeoAskItem[];
  label: string;
  answerable?: ReadonlyMap<string, NeoAskItemAction['kind']>;
}) {
  return (
    <ul aria-label={label} class="space-y-1.5">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} above={answerable?.get(item.id)} />
      ))}
    </ul>
  );
}

function ActionRow({
  action,
  onDone,
  onAnswer,
  disabled,
}: {
  action: NeoAskItemAction;
  onDone?: (itemId: string) => void;
  onAnswer?: (itemId: string, choice: string) => void;
  disabled?: boolean;
}) {
  const text = action.kind === 'confirm' ? action.step : (action.step ?? action.question);
  const question = action.kind === 'answer' && action.step ? action.question : null;
  return (
    <li data-ask-item={action.itemId} class="flex min-w-0 items-baseline gap-2 text-sm">
      <span aria-hidden="true" class="w-3 shrink-0 text-center text-xs text-warning">
        !
      </span>
      <span class="min-w-0 flex-1">
        <span class="break-words text-fg">{text}</span>
        {question && <span class="block break-words text-xs text-fg-muted">{question}</span>}
        {action.kind === 'answer' && onAnswer && (
          <span class="mt-1.5 flex flex-wrap gap-1.5">
            {action.options.map((option) => (
              <button
                key={option}
                type="button"
                class={`${neoSecondaryClass} max-w-full whitespace-normal break-words text-left`}
                disabled={disabled}
                aria-label={`Answer ${question ?? text}: ${option}`}
                onClick={() => onAnswer(action.itemId, option)}
              >
                {option}
              </button>
            ))}
          </span>
        )}
      </span>
      {action.kind === 'confirm' && onDone && (
        <button
          type="button"
          class={`${neoSecondaryClass} shrink-0`}
          disabled={disabled}
          aria-label={`Confirm: ${text}`}
          onClick={() => onDone(action.itemId)}
        >
          Confirm
        </button>
      )}
    </li>
  );
}

export function NeoAskCard({
  view,
  cards,
  disabled = false,
  onSettle,
  onDone,
  onAnswer,
  onAnswerInChat,
  onApprove,
  onRetry,
  onOpen,
  onOpenSession,
  onExpand,
  renderCard,
}: {
  view: NeoAskView;
  cards?: NeoSceneCards;
  disabled?: boolean;
  onSettle?: (outcome: NeoAskOutcome) => void;
  onDone?: (itemId: string) => void;
  onAnswer?: (itemId: string, choice: string) => void;
  onAnswerInChat?: (question: string) => void;
  onApprove?: () => void;
  onRetry?: (workId: string) => void;
  onOpen?: (workId: string) => void;
  onOpenSession?: (sessionId: string, title: string) => void;
  onExpand?: () => void;
  renderCard?: (scene: NeoScene) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const { ask } = view;
  const tone =
    view.group === 'attention'
      ? 'attention'
      : ask.status === 'achieved'
        ? 'achieved'
        : view.group === 'outcomes'
          ? 'ended'
          : 'running';
  const steps = view.scenes.length;
  const single = steps === 1 ? view.scenes[0] : undefined;
  const itemActions = neoAskItemActions(view);
  const canApprove = view.humanActions.some((action) => action.kind === 'start');
  const approveAgain = view.humanActions.some((action) => action.kind === 'approve');
  const retries = view.humanActions.flatMap((action) => {
    if (action.kind !== 'retry') return [];
    const scene = view.scenes.find((item) => item.ref.id === action.workId);
    const title = scene?.receipt.kind === 'work' ? scene.receipt.title : (scene?.label ?? '');
    return [{ workId: action.workId, title }];
  });
  const approval = neoAskApproval(ask, view.humanActions);
  const badge = neoAskApprovalBadge(ask, view.humanActions);
  const count = neoAskOutcomeCount(view.items);
  const outcomes = view.items.filter((item) => !isNeoAskQuestionItem(item));
  const questions = view.items.filter(isNeoAskQuestionItem);
  const answerable = new Map(itemActions.map((action) => [action.itemId, action.kind]));
  const answeredAbove = itemActions.some(
    (action) =>
      action.kind === 'answer' && action.itemId === view.answer?.itemId && action.options.length > 0
  );
  const target = neoAskOpenTarget(view, cards);
  const openName = `Open ${ask.title}`;
  const openControl =
    target &&
    (target.link ? (
      <a href={target.link} class={neoSecondaryClass} aria-label={openName}>
        <NeoAppMark logo={neoAppLogo(target.card?.adapter)} />
        {neoCardOpenLabel(target.card)}
      </a>
    ) : (
      onOpen && (
        <button
          type="button"
          class={neoSecondaryClass}
          aria-label={openName}
          onClick={() => onOpen(target.work.id)}
        >
          <NeoChatMark />
          Open chat
        </button>
      )
    ));
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
        {!view.settled && badge && (
          <span
            class={`shrink-0 text-xs ${badge.label === 'Approved' ? 'text-fg-muted' : 'text-warning'}`}
            title={badge.title}
          >
            {badge.label}
          </span>
        )}
        {!view.settled && count && (
          <span class="shrink-0 text-xs text-fg-muted">
            {count.verified} of {count.total} outcomes verified
          </span>
        )}
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
                onDone={onDone}
                onAnswer={onAnswer}
                disabled={disabled}
              />
            ))}
          </ul>
        </div>
      )}
      {steps > 0 && (
        <div class="mt-3 space-y-2 border-l-2 border-line pl-3">
          {view.scenes.map((scene) =>
            scene.group === 'attention' ? (
              renderCard?.(scene)
            ) : (
              <StepRow key={scene.ref.id} scene={scene} done={view.doneIds.has(scene.ref.id)} />
            )
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
          {isNeoSummarized(ask) && (
            <p role="status" class="text-xs text-fg-faint">
              Loading details…
            </p>
          )}
          <div class="text-sm text-fg-muted" hidden={isNeoSummarized(ask)}>
            <p class="text-xs font-medium text-fg-faint">Done when</p>
            {outcomes.length > 0 ? (
              <div class="mt-1.5">
                <Checklist items={outcomes} label="Done when" />
              </div>
            ) : (
              <p class="mt-1 whitespace-pre-wrap break-words">{ask.doneWhen}</p>
            )}
          </div>
          {questions.length > 0 && (
            <div class="text-sm text-fg-muted">
              <p class="text-xs font-medium text-fg-faint">Questions</p>
              <div class="mt-1.5">
                <Checklist items={questions} label="Questions" answerable={answerable} />
              </div>
            </div>
          )}
          {!view.settled && approval && (
            <div class="text-sm text-fg-muted">
              <p class="text-xs font-medium text-fg-faint">Approval</p>
              <p class="mt-1">{approval.line}</p>
            </div>
          )}
          {ask.outcome && ask.outcome.trim() !== view.summary && (
            <div class="text-sm text-fg-muted">
              <p class="text-xs font-medium text-fg-faint">Outcome</p>
              <p class="mt-1 whitespace-pre-wrap break-words">{ask.outcome}</p>
            </div>
          )}
          {single && single.group !== 'attention' && renderCard?.(single)}
        </div>
      )}
      <div class={neoFooterClass}>
        {view.answer && onAnswerInChat && !answeredAbove ? (
          <button
            type="button"
            class={neoPrimaryClass}
            disabled={disabled}
            onClick={() => onAnswerInChat(view.answer?.question ?? '')}
          >
            <NeoChatMark />
            {view.answer.label}
          </button>
        ) : (
          openControl
        )}
        {onRetry &&
          retries.map((retry) => (
            <button
              key={retry.workId}
              type="button"
              class={neoPrimaryClass}
              disabled={disabled}
              aria-label={`Retry ${retry.title}`}
              title="This step failed before it started. Retry sends the same instruction again."
              onClick={() => onRetry(retry.workId)}
            >
              Retry
            </button>
          ))}
        {approveAgain && onApprove && (
          <button
            type="button"
            class={neoPrimaryClass}
            disabled={disabled}
            title={badge?.title}
            onClick={onApprove}
          >
            Approve again
          </button>
        )}
        {canApprove && onApprove && (
          <button
            type="button"
            class={neoPrimaryClass}
            disabled={disabled}
            title="Let Neo start this ask's steps without asking for each one. Deploys and destructive steps still ask you."
            onClick={onApprove}
          >
            Approve all steps
          </button>
        )}
        <span class="flex-1" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            if (!open) onExpand?.();
            setOpen(!open);
          }}
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
