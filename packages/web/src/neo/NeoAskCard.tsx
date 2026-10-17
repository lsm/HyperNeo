import type {
  NeoAskItem,
  NeoAskSessionView,
  NeoAskTodo,
} from '@hyperneo/shared/types/neo-snapshot';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import {
  NeoAppMark,
  NeoChatMark,
  NeoMoreIcon,
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
} from './neo-asks.ts';
import type { NeoSceneCards } from './neo-scenes.ts';
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

const todoMarks = {
  pending: ['○', 'text-fg-faint'],
  running: ['●', 'text-accent'],
  done: ['✓', 'text-success'],
  failed: ['✕', 'text-danger'],
  cancelled: ['', 'text-fg-faint'],
} as const;

function TodoRow({
  todo,
  control,
  number,
}: {
  todo: NeoAskTodo;
  control?: ComponentChildren;
  number?: number;
}) {
  const [mark, color] = todoMarks[todo.state];
  return (
    <div
      data-ask-todo={todo.id}
      data-neo-work={todo.workId ?? undefined}
      class={`flex min-w-0 items-start gap-2.5 text-sm ${number === undefined ? 'border-t border-line py-2' : 'py-1'}`}
    >
      <span aria-hidden="true" class={`w-4 shrink-0 text-center font-semibold ${color}`}>
        {number ?? mark}
      </span>
      <div class="min-w-0 flex-1">
        <span
          class={`break-words ${todo.state === 'cancelled' ? 'text-fg-faint line-through' : 'text-fg'}`}
        >
          {todo.title}
        </span>
        {todo.added && todo.state !== 'cancelled' && (
          <span class="ml-1.5 rounded border border-accent px-1 text-xs font-semibold text-accent">
            新
          </span>
        )}
        <span class="block break-words text-xs text-fg-muted">{todo.status}</span>
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

function AnsweredQuestion({ item }: { item: NeoAskItem }) {
  const answer = item.answer;
  return (
    <li data-ask-answer={item.id} class="flex min-w-0 flex-wrap gap-x-2 text-sm text-fg-muted">
      <span>
        {item.question ?? item.text} — <span>{answer?.choice ?? '选择未记录'}</span>
      </span>
      {answer?.at != null ? (
        <time dateTime={new Date(answer.at).toISOString()} class="text-xs text-fg-faint">
          · {new Date(answer.at).toLocaleString()}
        </time>
      ) : (
        <span class="text-xs text-fg-faint">时间未记录</span>
      )}
    </li>
  );
}

function ActionRow({
  action,
  reply,
  onReply,
  onAnswer,
  disabled,
  todos,
  control,
}: {
  action: NeoAskItemAction;
  reply: NeoQuote;
  onReply?: (quote: NeoQuote) => void;
  onAnswer?: (itemId: string, choice: string) => void;
  disabled?: boolean;
  todos: readonly NeoAskTodo[];
  control: (todo: NeoAskTodo) => ComponentChildren;
}) {
  return (
    <li id={reply.anchor} data-ask-item={action.itemId} class="min-w-0 text-sm">
      <p class="break-words font-medium text-fg">{action.question}</p>
      {action.steps && (
        <div aria-label="待开始 todo" class="mt-2">
          {action.steps.map((step, index) => {
            const todo = todos.find((todo) => todo.workId === step.id) ?? {
              id: step.id,
              workId: step.id,
              title: step.title,
              state: 'pending' as const,
              status: '等你开始',
              added: false,
            };
            return <TodoRow key={step.id} todo={todo} number={index + 1} control={control(todo)} />;
          })}
        </div>
      )}
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
            在聊天里回复
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
  const itemActions = view.humanActions.slice(-1);
  const questioned = new Set(
    itemActions.flatMap((action) => action.steps?.map((step) => step.id) ?? [])
  );
  const todos = view.todos.filter((todo) => !todo.workId || !questioned.has(todo.workId));
  const questions = view.items.filter((item) => isNeoAskQuestionItem(item) && item.state === 'met');
  const openControl = (todo: NeoAskTodo) => {
    if (!todo.workId || todo.state === 'cancelled') return null;
    const card = cards?.get(todo.workId);
    const target = todo.open ?? card?.open;
    const scene = view.scenes.find((scene) => scene.ref.id === todo.workId);
    const sessionId =
      target?.sessionId ?? (scene?.receipt.kind === 'work' ? scene.receipt.sessionId : null);
    const link = sessionId ? null : neoSessionLink(target?.link ?? null, target?.daemon);
    const name = `打开 ${todo.title}`;
    return link ? (
      <a href={link} class={neoSecondaryClass} aria-label={name}>
        打开
      </a>
    ) : sessionId && (onOpen || onOpenSession) ? (
      <button
        type="button"
        class={neoSecondaryClass}
        aria-label={name}
        onClick={() =>
          onOpenSession ? onOpenSession(sessionId, todo.title) : onOpen?.(todo.workId!)
        }
      >
        打开
      </button>
    ) : null;
  };
  return (
    <article aria-label={ask.title} data-ask={ask.id} class={neoCardClass}>
      <div class="flex min-h-7 items-center gap-2">
        <span
          data-tone={tone}
          class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}
        >
          {view.label}
        </span>
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
      <h3 class="mt-2 line-clamp-3 break-words text-base font-semibold leading-snug">
        {ask.title}
      </h3>
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
                todos={view.todos}
                control={openControl}
              />
            ))}
          </ul>
        </div>
      )}
      {todos.length > 0 && (
        <div class="mt-3" aria-label="Todos">
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} control={openControl(todo)} />
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
          {view.idleReason && <p class="text-xs text-fg-muted">{view.idleReason}</p>}
          {view.sessions
            .filter(
              (session) =>
                !view.todos.some(
                  (todo) =>
                    todo.workId &&
                    ((session.open.sessionId &&
                      cards?.get(todo.workId)?.open.sessionId === session.open.sessionId) ||
                      (session.open.link &&
                        cards?.get(todo.workId)?.open.link === session.open.link))
                )
            )
            .map((session) => (
              <SessionRow key={session.key} session={session} onOpenSession={onOpenSession} />
            ))}
          {view.settled && ask.outcome && ask.outcome.trim() && (
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
