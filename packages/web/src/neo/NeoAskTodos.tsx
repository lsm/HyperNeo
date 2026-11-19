import {
  previewLinkedReferenceCandidates,
  previewLinkedReferenceSpans,
} from '@hyperneo/shared/types/artifact-reference';
import type {
  NeoAskEntry,
  NeoQuestionAnswer,
  NeoQuestionEntry,
  NeoTodoEntry,
  NeoTodoPriority,
} from '@hyperneo/shared/types/neo-ask';
import { workerEngine } from '@hyperneo/shared/types/worker-identity';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArtifactCards } from '../components/artifacts/ArtifactCards.tsx';
import { FileReferenceCards } from '../components/artifacts/FileReferenceCards.tsx';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { openArtifactPreview } from '../lib/artifact-preview-store.ts';
import { locale, type MessageKey, t } from '../lib/i18n/index.ts';
import { copyToClipboard } from '../lib/utils.ts';
import {
  NeoMoreIcon,
  NeoSessionMark,
  NeoSessionOpen,
  neoCardClass,
  neoFooterClass,
  neoPlainClass,
  neoPrimaryClass,
  neoSecondaryClass,
} from './NeoCardParts.tsx';
import { NeoTime } from './NeoTime.tsx';
import { type NeoDoneTodosPage, neoDonePageMerge } from './neo-asks.ts';
import { neoNow, neoRelativeTime } from './neo-time.ts';
import {
  NEO_TODO_PRIORITIES,
  type NeoTodoControl,
  neoTodoControllable,
  neoTodoHoldable,
} from './todo-controls.ts';
import {
  neoQuestionOption,
  neoQuestionText,
  neoTodoDetail,
  neoTodoHasMore,
  neoTodoNextAction,
  neoTodoStatus,
} from './todo-status.ts';
import { neoTopicColor } from './topic-color.ts';
import { neoSessionKind } from './work-driver.ts';

const states = {
  waiting: ['ask.state.waiting', 'text-warning', 'font-semibold'],
  doing: ['ask.state.doing', 'text-[var(--neo-teal)]', ''],
  done: ['ask.state.done', 'text-success', ''],
  dropped: ['ask.state.dropped', 'text-fg-faint', ''],
  todo: ['ask.state.todo', 'text-fg-faint', ''],
} as const;

const marks = {
  todo: ['○', 'text-fg-faint'],
  doing: ['●', 'text-accent'],
  blocked: ['●', 'text-warning'],
  done: ['✓', 'text-success'],
  removed: ['', 'text-fg-faint'],
} as const;

const choiceClass =
  'flex min-w-0 max-w-full items-start gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-xs font-semibold text-fg [overflow-wrap:anywhere] hover:border-accent/40 hover:text-accent focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';

function ChoiceOptionText({
  question,
  option,
  index,
}: {
  question: NeoQuestionEntry;
  option: string;
  index: number;
}) {
  const detail = question.optionDetails?.[option];
  return (
    <>
      <span data-choice-number aria-hidden="true" class="shrink-0 tabular-nums text-fg-muted">
        {question.optionLabels?.[index] ?? String(index + 1)}
      </span>
      <span class="min-w-0">
        {neoQuestionOption(question, option)}
        {question.recommended === option && (
          <span class="ml-1.5 rounded border border-line px-1 py-px text-[11px] font-medium text-fg-muted">
            {t('question.recommended')}
          </span>
        )}
        {detail && <span class="block font-normal text-fg-muted">{detail}</span>}
      </span>
    </>
  );
}

export function neoQuestionAnswerLabel(question: NeoQuestionEntry, todos: readonly NeoTodoEntry[]) {
  const answer = question.answer;
  if (answer === null) return '';
  if (question.kind === 'yesno' && question.answeredBy === 'button')
    return (answer === 'yes' ? question.yesLabel : question.noLabel) ?? String(answer);
  return Array.isArray(answer)
    ? answer
        .map((value) => todos.find((todo) => todo.id === value)?.title ?? value)
        .join(t('list.separator')) || t('question.none')
    : answer;
}

function readExpanded(key: string): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function useExpandedTodos(sessionId: string, askId: string) {
  const key = `neo.todoDetails:${JSON.stringify([sessionId, askId])}`;
  const [stored, setStored] = useState(() => ({ key, ids: readExpanded(key) }));
  const expanded = stored.key === key ? stored.ids : readExpanded(key);
  const setExpanded = (ids: string[]) => {
    setStored({ key, ids });
    try {
      sessionStorage.setItem(key, JSON.stringify(ids));
    } catch {}
  };
  return { expanded, setExpanded };
}

function CardFileText({
  text,
  kind,
  id,
  onOpen,
}: {
  text: string;
  kind: 'todo' | 'question';
  id: string;
  onOpen?: () => void;
}) {
  const spans = useMemo(() => previewLinkedReferenceSpans(text), [text]);
  let cursor = 0;
  const pieces = spans.flatMap(({ start, end, reference }) => {
    const before = text.slice(cursor, start);
    cursor = end;
    const open = () => {
      onOpen?.();
      openArtifactPreview({ kind: 'reference', source: { kind, id }, reference });
    };
    return [
      before,
      <span
        key={start}
        role="link"
        tabIndex={0}
        class="pointer-events-auto cursor-pointer text-accent underline decoration-dotted underline-offset-2 focus-visible:outline-accent"
        aria-label={t('artifact.openNamed', { name: reference })}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            open();
          }
        }}
      >
        {text.slice(start, end)}
      </span>,
    ];
  });
  return (
    <>
      {pieces}
      {text.slice(cursor)}
    </>
  );
}

const PLAIN_STATUS = new Set(['todo.doing', 'todo.done', 'todo.notStarted']);

function NeoDesktopIcon() {
  return (
    <svg
      class="h-5 w-5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

const PRIORITY_LABELS: Record<NeoTodoPriority, MessageKey> = {
  urgent: 'todo.priority.urgent',
  high: 'todo.priority.high',
  normal: 'todo.priority.normal',
  low: 'todo.priority.low',
};

function TodoRow({
  todo,
  number,
  onOpen,
  expanded = false,
  anchorPrefix = '',
  onToggle,
  onControl,
  disabled,
  onDesktopControl,
}: {
  todo: NeoTodoEntry;
  onControl?: (control: NeoTodoControl) => Promise<void>;
  disabled?: boolean;
  onDesktopControl?: (todoId: string, on: boolean) => void;
  expanded?: boolean;
  anchorPrefix?: string;
  onToggle?: () => void;
  number?: number;
  onOpen?: (link: string, title: string) => void;
}) {
  const [mark, color] = todo.statusCodes?.some((code) =>
    ['todo.held', 'todo.paused'].includes(code.code)
  )
    ? (['‖', 'text-warning'] as const)
    : marks[todo.state];
  const [controlError, setControlError] = useState<string | null>(null);
  const [confirmDesktopOff, setConfirmDesktopOff] = useState(false);
  const control = (choice: NeoTodoControl) => {
    setControlError(null);
    void onControl?.(choice).catch((cause: unknown) =>
      setControlError(cause instanceof Error ? cause.message : t('todo.controlFailed'))
    );
  };
  const controls = onControl && neoTodoControllable(todo);
  const detailId = `${anchorPrefix}neo-todo-detail-${todo.id}`;
  const detail = neoTodoDetail(todo);
  const nextAction = neoTodoNextAction(todo);
  const lifecycle = (
    [
      { at: todo.finishedAt, label: 'time.finished' },
      { at: todo.startedAt, label: 'time.started' },
      { at: todo.createdAt, label: 'time.created' },
    ] satisfies { at: number | null; label: MessageKey }[]
  ).find(({ at }) => neoRelativeTime(at, neoNow.peek(), locale.peek()));
  const plainStatus =
    number === undefined &&
    todo.statusCodes?.length === 1 &&
    PLAIN_STATUS.has(todo.statusCodes[0].code);
  const desktopEditable =
    number === undefined &&
    !!onDesktopControl &&
    !todo.worker?.daemon &&
    ['todo', 'doing', 'blocked'].includes(todo.state);
  const desktopOn = desktopEditable && todo.named?.desktopControl === true;
  const setDesktop = (on: boolean) => onDesktopControl?.(todo.id, on);
  const menu = [
    ...(desktopEditable
      ? [
          {
            label: t(desktopOn ? 'todo.desktopOff' : 'todo.desktopOn'),
            onClick: () => setDesktop(!desktopOn),
            disabled,
          },
          ...(controls ? [{ type: 'divider' as const }] : []),
        ]
      : []),
    ...(controls
      ? [
          { label: t('todo.markDone'), onClick: () => control({ kind: 'done' }), disabled },
          ...(neoTodoHoldable(todo)
            ? [
                {
                  label: t(todo.startedAt === null ? 'todo.hold' : 'todo.pause'),
                  onClick: () => control({ kind: 'hold' }),
                  disabled,
                },
              ]
            : []),
          { type: 'divider' as const },
          ...NEO_TODO_PRIORITIES.map((priority) => ({
            label: t('todo.priorityItem', { priority: t(PRIORITY_LABELS[priority]) }),
            icon: <span aria-hidden="true">{priority === todo.priority ? '✓' : ''}</span>,
            onClick: () =>
              priority === todo.priority ? undefined : control({ kind: 'priority', priority }),
            disabled,
          })),
          { type: 'divider' as const },
          {
            label: t('todo.cancel'),
            onClick: () => control({ kind: 'cancel' }),
            danger: true,
            disabled,
          },
        ]
      : []),
  ];
  const head = (
    <>
      <span
        class={`break-words ${todo.state === 'removed' ? 'text-fg-faint line-through' : 'font-medium text-fg'} ${number === undefined ? 'text-base' : ''}`}
      >
        <CardFileText text={todo.title} kind="todo" id={todo.id} />
      </span>
      {todo.priority !== 'normal' && neoTodoControllable(todo) && (
        <span
          data-todo-priority={todo.priority}
          class={`ml-1.5 rounded border border-current px-1 text-xs font-semibold ${todo.priority === 'low' ? 'text-fg-muted' : 'text-warning'}`}
        >
          {t(PRIORITY_LABELS[todo.priority])}
        </span>
      )}
      {todo.worker && (
        <span
          data-worker-label
          title={todo.worker.label}
          class="block break-words text-xs text-fg-muted"
        >
          {workerEngine(todo.worker.adapter)} · {todo.worker.daemon ?? t('worker.thisMachine')}
        </span>
      )}
      {!plainStatus && (
        <span
          data-todo-status
          class={`block ${onToggle && !expanded ? 'truncate' : 'break-words'} text-xs ${number === undefined && todo.state === 'blocked' ? 'text-warning' : 'text-fg-muted'}`}
        >
          <CardFileText
            kind="todo"
            id={todo.id}
            text={
              number === undefined
                ? neoTodoStatus(todo)
                : todo.doneWhen
                  ? t('todo.doneWhen', { doneWhen: todo.doneWhen })
                  : ''
            }
          />
        </span>
      )}
    </>
  );
  return (
    <div
      id={`${anchorPrefix}neo-ref-todo-${todo.id}`}
      data-ask-todo={todo.id}
      data-todo-state={todo.state}
      class={`${todo.state === 'done' ? 'opacity-60 ' : ''}grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2.5 text-sm ${number === undefined ? 'py-2.5' : 'py-1'}`}
    >
      <span
        aria-hidden="true"
        data-todo-mark
        class={`flex w-4 shrink-0 items-center justify-center font-semibold ${number === undefined ? 'h-6 text-xs' : 'h-5'} ${color}`}
      >
        {number ??
          (mark === '●' ? (
            <span class="h-2 w-2 rounded-full bg-current" />
          ) : mark === '○' ? (
            <span class="h-2 w-2 rounded-full border-[1.5px] border-current" />
          ) : (
            mark
          ))}
      </span>
      <div class="min-w-0 flex-1">
        {onToggle ? (
          <div class="relative min-w-0">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={t(expanded ? 'todo.hideDetails' : 'todo.showDetails', {
                title: todo.title,
              })}
              onClick={onToggle}
              class="absolute inset-0 block w-full rounded text-left focus-visible:outline-accent"
            />
            <div data-todo-head class="pointer-events-none relative min-w-0">
              {head}
            </div>
          </div>
        ) : (
          <div class="block w-full min-w-0 text-left">{head}</div>
        )}
        {(!onToggle || expanded) && (
          <div id={detailId} data-todo-details={onToggle ? '' : undefined} class="flow-root">
            {expanded && lifecycle && (
              <div class="neo-time-line">
                {t(lifecycle.label)} · <NeoTime at={lifecycle.at} label={lifecycle.label} />
              </div>
            )}
            <div class="contents [&>p:last-child]:inline [&>span:last-child]:inline">
              {onToggle &&
                detail.map((text) => (
                  <p key={text} class="mt-1 whitespace-pre-wrap break-words text-xs text-fg-muted">
                    <CardFileText text={text} kind="todo" id={todo.id} />
                  </p>
                ))}
              <ArtifactCards artifacts={todo.artifacts} />
              {number === undefined && nextAction && (
                <span data-todo-next-action class="block break-words text-xs text-fg-muted">
                  <CardFileText
                    text={t('todo.nextAction', { action: nextAction })}
                    kind="todo"
                    id={todo.id}
                  />
                </span>
              )}
            </div>
          </div>
        )}
        <FileReferenceCards
          source={{ kind: 'todo', id: todo.id }}
          ownerHome={todo.worker?.daemon ? null : undefined}
          text={[
            todo.title,
            number === undefined ? neoTodoStatus(todo) : todo.doneWhen,
            ...(onToggle && expanded ? detail : []),
            ...((!onToggle || expanded) && number === undefined ? [nextAction ?? ''] : []),
          ].join('\n')}
        />
        {controlError && (
          <p role="alert" data-todo-control-error class="mt-1 break-words text-xs text-danger">
            {controlError}
          </p>
        )}
      </div>
      {((todo.link && todo.state !== 'removed' && onOpen) || menu.length > 0 || desktopOn) && (
        <div class="flex shrink-0 items-center justify-end gap-2 self-start">
          {desktopOn && (
            <button
              type="button"
              data-todo-desktop
              title={t('todo.desktopOnTitle')}
              aria-label={t('todo.desktopOnTitle')}
              disabled={disabled}
              onClick={() => setConfirmDesktopOff(true)}
              class="inline-flex shrink-0 items-center rounded-lg border border-transparent px-1.5 py-1 text-[var(--neo-desktop-control)] hover:border-line focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <NeoDesktopIcon />
            </button>
          )}
          {confirmDesktopOff && (
            <ConfirmModal
              isOpen
              onClose={() => setConfirmDesktopOff(false)}
              onConfirm={() => {
                setConfirmDesktopOff(false);
                setDesktop(false);
              }}
              title={t('todo.desktopOffConfirmTitle')}
              message={t('todo.desktopOffConfirmBody', { title: todo.title })}
              confirmText={t('todo.desktopOffConfirm')}
              cancelText={t('artifact.cancel')}
              confirmButtonVariant="primary"
            />
          )}
          {todo.link && todo.state !== 'removed' && onOpen && (
            <NeoSessionOpen
              kind={neoSessionKind(todo.worker?.adapter, todo.link)}
              label={t('todo.openTitle', { title: todo.title })}
              onOpen={() => onOpen(todo.link!, todo.worker?.label ?? todo.title)}
            />
          )}
          {menu.length > 0 && (
            <Dropdown
              position="right"
              items={menu}
              trigger={
                <IconButton
                  title={t('todo.actions', { title: todo.title })}
                  size="sm"
                  class="text-fg-faint"
                >
                  <NeoMoreIcon />
                </IconButton>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function QuestionMarkdown({ question, content }: { question: NeoQuestionEntry; content: string }) {
  const references = useMemo(
    () =>
      previewLinkedReferenceCandidates(content)
        .filter((item) => item.kind === 'local')
        .map((item) => item.reference),
    [content]
  );
  return (
    <MarkdownRenderer
      referenceHome={question.sourceSession?.daemon ? null : undefined}
      content={content}
      references={references}
      onReference={(reference) =>
        openArtifactPreview({
          kind: 'reference',
          source: { kind: 'question', id: question.id },
          reference,
        })
      }
      class="neo-markdown neo-markdown-assistant min-w-0 text-sm leading-relaxed"
    />
  );
}

function SettledQuestionBody({ question }: { question: NeoQuestionEntry }) {
  const text = neoQuestionText(question);
  const preview = text.match(/^.{0,300}/su)?.[0] ?? '';
  const clipped = preview.length < text.length;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <QuestionMarkdown question={question} content={clipped ? `${preview.trimEnd()} …` : text} />
      {clipped && (
        <button
          ref={trigger}
          type="button"
          class={neoPlainClass}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {t('question.readAll')}
        </button>
      )}
      {open && (
        <Modal isOpen onClose={close} title={t('question.readAll')} size="xl">
          <QuestionMarkdown question={question} content={text} />
        </Modal>
      )}
      <QuestionDocument question={question} />
      <FileReferenceCards
        source={{ kind: 'question', id: question.id }}
        ownerHome={question.sourceSession?.daemon ? null : undefined}
        text={[neoQuestionText(question), question.document ?? ''].join('\n')}
      />
      <ArtifactCards
        artifacts={question.artifacts}
        source={{ kind: 'question', id: question.id }}
      />
    </>
  );
}

function QuestionDocument({ question }: { question: NeoQuestionEntry }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  if (!question.document) return null;
  const label = t(question.confirm ? 'question.document' : 'question.report');
  return (
    <>
      <button ref={trigger} type="button" class={neoPlainClass} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Modal isOpen={open} onClose={close} title={label} size="xl">
        <pre class="whitespace-pre-wrap break-words text-sm text-fg">
          <CardFileText text={question.document} kind="question" id={question.id} onOpen={close} />
        </pre>
      </Modal>
    </>
  );
}

export function QuestionBox({
  question,
  disabled,
  onAnswer,
  onDesktopAllow,
  onReply,
  onOpen,
  hold,
}: {
  question: NeoQuestionEntry;
  disabled?: boolean;
  onDesktopAllow?: (question: NeoQuestionEntry) => void;
  onAnswer: (answer: NeoQuestionAnswer) => void;
  onReply?: () => void;
  onOpen?: (link: string, title: string) => void;
  hold?: { held: boolean; toggle: () => void };
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (value: string, on: boolean) =>
    setPicked((current) => (on ? [...current, value] : current.filter((item) => item !== value)));
  const reply = onReply && (
    <button type="button" class={neoPlainClass} disabled={disabled} onClick={onReply}>
      {t('question.reply')}
    </button>
  );
  return (
    <div
      id={`neo-ref-question-${question.id}`}
      data-ask-question={question.id}
      data-question-kind={question.kind}
      class="mt-3 rounded-lg bg-warning/10 px-3 py-2"
    >
      <div class="neo-time-line neo-question-time">
        <span>{t((hold ? hold.held : question.heldAt) ? 'queue.onHold' : 'time.waiting')}</span>
        <NeoTime at={question.createdAt} />
      </div>
      {question.sourceSession?.link && onOpen && (
        <div class="mb-2 flex justify-end" data-question-source>
          <button
            type="button"
            class={neoSecondaryClass}
            aria-label={t('question.openSessionTitle', {
              name: question.sourceSession.name ?? question.sourceSession.id,
            })}
            onClick={() => onOpen(question.sourceSession!.link!, question.sourceSession!.label)}
          >
            <NeoSessionMark
              kind={neoSessionKind(question.sourceSession.adapter, question.sourceSession.link)}
            />
            {t('question.open')}
          </button>
        </div>
      )}
      {question.kind === 'desktop_control' && (
        <p class="mb-2 text-sm font-medium">
          {question.todoTitle} — {question.app}
        </p>
      )}
      <QuestionMarkdown question={question} content={neoQuestionText(question)} />
      <QuestionDocument question={question} />
      <FileReferenceCards
        source={{ kind: 'question', id: question.id }}
        ownerHome={question.sourceSession?.daemon ? null : undefined}
        text={[neoQuestionText(question), question.document ?? ''].join('\n')}
      />
      <ArtifactCards
        artifacts={question.artifacts}
        source={{ kind: 'question', id: question.id }}
      />
      {question.kind === 'choice' && question.multiple && (
        <div class="mt-2 space-y-1">
          {(question.options ?? []).map((option, index) => (
            <label
              key={option}
              data-choice-option
              class="flex min-w-0 max-w-full items-start gap-2 text-sm [overflow-wrap:anywhere]"
            >
              <input
                type="checkbox"
                class="mt-1 shrink-0"
                checked={picked.includes(option)}
                onChange={(event) => toggle(option, (event.target as HTMLInputElement).checked)}
              />
              <ChoiceOptionText question={question} option={option} index={index} />
            </label>
          ))}
        </div>
      )}
      {question.kind === 'choice' && !question.multiple && (
        <div class="mt-2 flex flex-col items-stretch gap-1.5">
          {(question.options ?? []).map((option, index) => (
            <button
              key={option}
              type="button"
              data-choice-option
              class={choiceClass}
              disabled={disabled}
              onClick={() => onAnswer([option])}
            >
              <ChoiceOptionText question={question} option={option} index={index} />
            </button>
          ))}
        </div>
      )}
      <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
        {hold && (
          <button type="button" class={neoPlainClass} disabled={disabled} onClick={hold.toggle}>
            {t(hold.held ? 'queue.takeBack' : 'queue.hold')}
          </button>
        )}
        {reply}
        {question.kind === 'desktop_control' && (
          <button
            type="button"
            class={neoPrimaryClass}
            disabled={disabled || !onDesktopAllow}
            onClick={() => onDesktopAllow?.(question)}
          >
            {t('question.allow')}
          </button>
        )}
        {question.kind === 'yesno' && (
          <>
            <button
              type="button"
              class={neoSecondaryClass}
              disabled={disabled}
              onClick={() => onAnswer('no')}
            >
              {question.noLabel}
            </button>
            <button
              type="button"
              class={neoPrimaryClass}
              disabled={disabled}
              onClick={() => onAnswer('yes')}
            >
              {question.yesLabel}
            </button>
          </>
        )}
        {question.kind === 'choice' && question.multiple && (
          <button
            type="button"
            class={neoPrimaryClass}
            disabled={disabled}
            onClick={() => onAnswer(picked)}
          >
            {t('question.confirm')}
          </button>
        )}
      </div>
    </div>
  );
}

export function NeoAskTodos({
  entry: received,
  focusedItem,
  disabled,
  onAnswer,
  onReply,
  onHold,
  onReplyAsk,
  onOpen,
  onSettle,
  onLoadDone,
  onLoadDetails,
  onTopic,
  onControl,
  onDesktopControl,
  onDesktopAllow,
  hideOpenCards,
  onDetails,
}: {
  entry: NeoAskEntry;
  hideOpenCards?: boolean;
  onDetails?: (entry: NeoAskEntry) => void;
  onControl?: (todo: NeoTodoEntry, control: NeoTodoControl) => Promise<void>;
  onDesktopControl?: (todoId: string, on: boolean) => void;
  onDesktopAllow?: (question: NeoQuestionEntry) => void;
  focusedItem?: { questionId?: string; todoId?: string };
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onReply?: (question: NeoQuestionEntry) => void;
  onHold?: (questionId: string, held: boolean) => void;
  onReplyAsk?: () => void;
  onOpen?: (link: string, title: string) => void;
  onSettle?: (status: 'done' | 'dropped') => void | Promise<void>;
  onLoadDone?: (askId: string, offset: number) => Promise<NeoDoneTodosPage>;
  onLoadDetails?: (askId: string) => Promise<NeoAskEntry>;
  onTopic?: (topic: string) => void;
}) {
  const [details, setDetails] = useState<NeoAskEntry | null>(null);
  const [readRevision, setReadRevision] = useState<number | null>(null);
  const pendingDetail = useRef<{ revision: number } | null>(null);
  const entry =
    received.summary && details?.ask.id === received.ask.id
      ? {
          ...details,
          state: received.state,
          doneCount: received.doneCount,
          ask: { ...details.ask, title: received.ask.title, status: received.ask.status },
        }
      : received;
  const [detailError, setDetailError] = useState('');
  const cardRef = useRef<HTMLElement>(null);
  const allButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const focusedQuestionId = focusedItem?.questionId;
  const focusedQuestionState = entry.questions.find(
    (question) => question.id === focusedQuestionId
  )?.state;
  const focusedTodoId = focusedItem?.todoId;
  const focusedTodoState = entry.todos.find((todo) => todo.id === focusedTodoId)?.state;
  useEffect(() => {
    if (
      (focusedQuestionId && focusedQuestionState && focusedQuestionState !== 'open') ||
      (focusedTodoId && (focusedTodoState === 'done' || focusedTodoState === 'removed'))
    )
      setOpen(true);
  }, [focusedItem, focusedQuestionState, focusedTodoState]);
  const [paged, setPaged] = useState<NeoTodoEntry[]>([]);
  const [stalled, setStalled] = useState(false);
  const [paging, setPaging] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);
  const settle = async (status: 'done' | 'dropped') => {
    setSettleError(null);
    try {
      await onSettle?.(status);
    } catch (cause) {
      setSettleError(cause instanceof Error ? cause.message : t('ask.settleFailed'));
    }
  };
  const { ask, todos } = entry;
  const { expanded, setExpanded } = useExpandedTodos(ask.sessionId, ask.id);
  const readingDetails =
    open ||
    !!focusedItem ||
    expanded.length > 0 ||
    (received.summary?.openQuestionCount ?? 0) > 0 ||
    !!details?.questions.some((question) => question.state === 'open');
  useEffect(() => {
    setReadRevision(null);
    return () => {
      pendingDetail.current = null;
    };
  }, [received.ask.id, readingDetails]);
  useEffect(() => {
    if (
      !received.summary ||
      !onLoadDetails ||
      !readingDetails ||
      pendingDetail.current ||
      (readRevision !== null && readRevision >= received.ask.updatedAt)
    )
      return;
    const ticket = { revision: received.ask.updatedAt };
    pendingDetail.current = ticket;
    setDetailError('');
    void onLoadDetails(received.ask.id).then(
      (value) => {
        if (pendingDetail.current !== ticket) return;
        pendingDetail.current = null;
        setDetails(value);
        onDetails?.(value);
        setReadRevision(Math.max(ticket.revision, value.ask.updatedAt));
      },
      (cause) => {
        if (pendingDetail.current !== ticket) return;
        pendingDetail.current = null;
        setDetailError(cause instanceof Error ? cause.message : t('ask.moreDoneFailed'));
        setReadRevision(ticket.revision);
      }
    );
  }, [
    received.ask.id,
    received.ask.updatedAt,
    !!received.summary,
    readingDetails,
    onLoadDetails,
    readRevision,
  ]);
  const asked = entry.questions
    .filter((question) => question.state === 'open' && !hideOpenCards)
    .sort(
      (a, b) =>
        Number(!!a.heldAt) - Number(!!b.heldAt) ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id)
    );
  const answered = entry.questions.filter((question) => question.state === 'answered');
  const retired = entry.questions.filter((question) => question.state === 'retired');
  const knownIds = new Set(
    [...received.todos.filter((todo) => todo.state === 'done'), ...paged].map((todo) => todo.id)
  );
  const sent = todos.filter(
    (todo) => todo.state === 'done' && (!received.summary || !onLoadDone || knownIds.has(todo.id))
  );
  const knownDone = [
    ...sent,
    ...paged.filter((todo) => !todos.some((other) => other.id === todo.id)),
  ];
  const hiddenDone = entry.doneCount - knownDone.length;
  const live = todos.filter((todo) => todo.state !== 'removed' && todo.state !== 'done');
  const showMoreDone = () => {
    if (knownDone.length >= entry.doneCount || !onLoadDone || paging) return;
    setPaging(true);
    setDoneError(null);
    void onLoadDone(ask.id, stalled ? 0 : knownDone.length)
      .then((page) => {
        if (!page.ok) return setDoneError(t('ask.moreDoneRefused', { reason: page.reason }));
        const merged = neoDonePageMerge(paged, knownDone, page.todos, stalled);
        setPaged(merged.paged);
        setStalled(merged.stalled);
      })
      .catch(() => setDoneError(t('ask.moreDoneFailed')))
      .finally(() => setPaging(false));
  };
  useEffect(() => {
    if (
      open &&
      !paging &&
      !stalled &&
      !doneError &&
      hiddenDone > 0 &&
      (knownDone.length === 0 ||
        (focusedTodoState === 'done' && !knownDone.some((todo) => todo.id === focusedTodoId)))
    )
      showMoreDone();
  }, [open, paging, stalled, doneError, knownDone.length, focusedTodoId, focusedTodoState]);
  useEffect(() => {
    let restore = () => {};
    const frame = requestAnimationFrame(() => {
      const anchor = focusedQuestionId
        ? `neo-ref-question-${focusedQuestionId}`
        : focusedTodoId
          ? `neo-ref-todo-${focusedTodoId}`
          : null;
      const target =
        anchor &&
        ((open && document.getElementById(`all-${anchor}`)) || document.getElementById(anchor));
      if (
        !target ||
        (!cardRef.current?.contains(target) &&
          !target.closest('[data-neo-cards]') &&
          target.closest('[role="dialog"]')?.getAttribute('data-testid') !==
            `neo-ask-all-${received.ask.id}`)
      )
        return;
      const prior = target.getAttribute('tabindex');
      target.tabIndex = -1;
      target.dataset.cardReplyFocus = 'true';
      target.classList.add('ring-2', 'ring-accent');
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'center' });
      restore = () => {
        delete target.dataset.cardReplyFocus;
        target.classList.remove('ring-2', 'ring-accent');
        if (prior === null) target.removeAttribute('tabindex');
        else target.setAttribute('tabindex', prior);
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      restore();
    };
  }, [open, focusedItem, focusedQuestionState, focusedTodoState, knownDone.length]);
  const listed = live;
  const focused = ask.focusedSession;
  const focusedFallback =
    focused?.link &&
    onOpen &&
    !entry.questions.some(
      (question) => question.state === 'open' && question.sourceSession?.link === focused.link
    ) &&
    !listed.some((todo) => todo.link === focused.link)
      ? focused
      : null;
  const removed = todos.filter((todo) => todo.state === 'removed');
  const itemCount = received.summary
    ? received.summary.todoCount +
      received.summary.questionCount -
      received.summary.openQuestionCount
    : todos.filter((todo) => todo.state !== 'done').length +
      entry.doneCount +
      answered.length +
      retired.length;
  const closeAll = () => {
    setOpen(false);
    requestAnimationFrame(() => allButton.current?.focus());
  };
  const renderTodo = (todo: NeoTodoEntry, anchorPrefix = '') => (
    <TodoRow
      key={todo.id}
      todo={todo}
      anchorPrefix={anchorPrefix}
      disabled={disabled}
      onControl={onControl && ((control) => onControl(todo, control))}
      onOpen={
        onOpen &&
        ((link, title) => {
          setOpen(false);
          onOpen(link, title);
        })
      }
      expanded={expanded.includes(todo.id)}
      onDesktopControl={onDesktopControl}
      onToggle={
        entry.summary || neoTodoHasMore(todo)
          ? () =>
              setExpanded(
                expanded.includes(todo.id)
                  ? expanded.filter((id) => id !== todo.id)
                  : [...expanded, todo.id]
              )
          : undefined
      }
    />
  );
  const [label, tone, weight] = states[entry.state];
  const created = neoRelativeTime(ask.createdAt, neoNow.value, locale.value);
  const todoCount =
    received.summary?.todoCount ??
    todos.filter((todo) => todo.state !== 'removed' && todo.state !== 'done').length +
      entry.doneCount;
  const openQuestions =
    received.summary?.openQuestionCount ??
    entry.questions.filter((question) => question.state === 'open').length;
  return (
    <article
      ref={cardRef}
      aria-label={ask.title}
      id={`neo-ref-ask-${ask.id}`}
      data-ask={ask.id}
      data-ask-state={entry.state}
      class={neoCardClass}
    >
      <div class="flex items-start gap-3">
        <div class="flex min-w-0 flex-1 items-start gap-2">
          <h3 class="line-clamp-3 min-w-0 break-words text-lg font-semibold leading-snug">
            {ask.title}
          </h3>
          {ask.topic && (
            <button
              type="button"
              disabled={!onTopic || !ask.topicKey}
              onClick={() => ask.topicKey && onTopic?.(ask.topicKey)}
              data-topic-swatch
              class="mt-0.5 max-w-[40%] shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium enabled:hover:opacity-80"
              style={{ borderColor: neoTopicColor(ask.topic), color: neoTopicColor(ask.topic) }}
            >
              <span class="block truncate">{ask.topic}</span>
            </button>
          )}
        </div>
        <Dropdown
          position="right"
          items={[
            {
              label: t('ask.copyLink'),
              onClick: () => {
                const title = ask.title.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&');
                void copyToClipboard(`[${title}](${location.origin}/ask/${ask.id}.md)`);
              },
            },
            ...(onReplyAsk ? [{ label: t('chat.reply'), onClick: onReplyAsk, disabled }] : []),
            ...(onSettle && ask.status === 'open'
              ? [
                  { label: t('ask.markDone'), onClick: () => void settle('done'), disabled },
                  {
                    label: t('ask.drop'),
                    onClick: () => void settle('dropped'),
                    danger: true,
                    disabled,
                  },
                ]
              : []),
          ]}
          trigger={
            <IconButton title={t('ask.actions')} size="sm" class="text-fg-faint">
              <NeoMoreIcon />
            </IconButton>
          }
        />
      </div>
      {detailError && !open && (
        <p role="alert" class="mt-2 text-sm text-danger">
          {detailError}
        </p>
      )}
      <p
        data-ask-status
        title={created ? `${t('time.created')} · ${created.full}` : undefined}
        class="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-muted"
      >
        <span class={`${tone} ${weight}`}>{t(label)}</span>
        {todoCount > 0 && <span>· {t('ask.todoCount', { count: String(todoCount) })}</span>}
        {openQuestions > 0 && (
          <span>· {t('ask.questionsWaiting', { count: String(openQuestions) })}</span>
        )}
      </p>
      {ask.focusedSession && (
        <div class="mt-2 flex flex-wrap items-center justify-end gap-2" data-ask-focused-session>
          <span class="min-w-0 break-words text-right text-xs text-fg-muted">
            {ask.focusedSession.name ?? ask.focusedSession.id} · {ask.focusedSession.provider}
          </span>
        </div>
      )}
      {settleError && (
        <p role="alert" class="mt-2 break-words text-sm text-danger">
          {settleError}
        </p>
      )}
      {asked.map((question) => (
        <QuestionBox
          key={question.id}
          question={question}
          onOpen={onOpen}
          disabled={disabled}
          onAnswer={(answer) => onAnswer(question.id, answer)}
          onDesktopAllow={onDesktopAllow}
          onReply={onReply ? () => onReply(question) : undefined}
          hold={
            onHold && {
              held: !!question.heldAt,
              toggle: () => onHold(question.id, !question.heldAt),
            }
          }
        />
      ))}
      {listed.length > 0 && (
        <div class="mt-3" aria-label={t('ask.todos')}>
          {listed.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              onOpen={onOpen}
              disabled={disabled}
              onControl={onControl && ((control) => onControl(todo, control))}
              expanded={expanded.includes(todo.id)}
              onDesktopControl={onDesktopControl}
              onToggle={
                entry.summary || neoTodoHasMore(todo)
                  ? () =>
                      setExpanded(
                        expanded.includes(todo.id)
                          ? expanded.filter((id) => id !== todo.id)
                          : [...expanded, todo.id]
                      )
                  : undefined
              }
            />
          ))}
        </div>
      )}
      {focusedFallback && onOpen && (
        <div class="mt-3 flex justify-end" data-ask-session-open>
          <button
            type="button"
            class={neoSecondaryClass}
            aria-label={t('question.openSessionTitle', {
              name: focusedFallback.name ?? focusedFallback.id,
            })}
            onClick={() => onOpen(focusedFallback.link!, focusedFallback.label)}
          >
            <NeoSessionMark kind={neoSessionKind(focusedFallback.adapter, focusedFallback.link)} />
            {t('question.open')}
          </button>
        </div>
      )}
      {open && (
        <Modal
          isOpen
          onClose={closeAll}
          title={ask.title}
          titleClass="text-lg leading-snug"
          size="xl"
          data-testid={`neo-ask-all-${ask.id}`}
        >
          {detailError && (
            <p role="alert" class="text-sm text-danger">
              {detailError}
            </p>
          )}
          {[
            { label: t('ask.inProgress'), todos: live, count: live.length, prefix: 'all-' },
            { label: t('ask.completed'), todos: knownDone, count: entry.doneCount, prefix: '' },
          ].map(
            (group) =>
              group.count > 0 && (
                <section key={group.label} aria-label={group.label} class="mt-8 first:mt-0">
                  <h3 class="mb-1 text-xs font-medium text-fg-muted">
                    {group.label} · {group.count}
                  </h3>
                  {group.todos.map((todo) => renderTodo(todo, group.prefix))}
                </section>
              )
          )}
          {hiddenDone > 0 && (
            <button
              type="button"
              class="mt-2 text-xs font-medium text-fg-muted hover:text-fg-soft disabled:opacity-60"
              disabled={paging}
              onClick={showMoreDone}
            >
              {t('ask.moreDone', { count: hiddenDone })}
            </button>
          )}
          {doneError && (
            <p role="alert" class="mt-1 text-xs text-danger">
              {doneError}
            </p>
          )}

          {removed.length > 0 && (
            <div class="mt-8">
              <p class="text-xs font-medium text-fg-muted">
                {t('ask.removed')} · {removed.length}
              </p>
              <ul class="mt-3 space-y-2 text-sm text-fg-muted" aria-label={t('ask.removed')}>
                {removed.map((todo) => (
                  <li
                    key={todo.id}
                    id={`neo-ref-todo-${todo.id}`}
                    data-ask-todo={todo.id}
                    data-todo-state="removed"
                    class="truncate"
                    title={`${todo.title} — ${neoTodoStatus(todo)}`}
                  >
                    <span class="line-through">{todo.title}</span> — {neoTodoStatus(todo)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {answered.length > 0 && (
            <div class="mt-8">
              <p class="text-xs font-medium text-fg-muted">
                {t('ask.answered')} · {answered.length}
              </p>
              <ul class="mt-3 space-y-5" aria-label={t('ask.answered')}>
                {answered.map((question) => (
                  <li key={question.id} id={`neo-ref-question-${question.id}`}>
                    <div class="font-medium text-fg [&_.neo-markdown]:text-base">
                      <SettledQuestionBody question={question} />
                    </div>
                    <p data-question-answer class="mt-1.5 pl-6 text-sm text-fg-muted">
                      → {neoQuestionAnswerLabel(question, todos)}
                      {!!neoRelativeTime(question.answeredAt, neoNow.peek(), locale.value) && (
                        <span
                          data-answered-time
                          class="ml-2 inline-block align-baseline text-xs font-normal text-fg-faint [&_.neo-time-popover]:inset-x-auto [&_.neo-time-popover]:start-0 [&_.neo-time]:inline-block"
                        >
                          <NeoTime at={question.answeredAt} label="time.answered" />
                        </span>
                      )}
                    </p>
                    {question.answerProvenance && (
                      <div class="mt-2 space-y-1 border-l-2 border-line pl-3">
                        <p class="text-xs font-medium text-fg-soft">
                          {t('question.relayedBy', { name: question.answerProvenance.viaName })}
                        </p>
                        <p class="whitespace-pre-wrap break-words text-sm text-fg-soft">
                          {question.answerProvenance.words}
                        </p>
                        <p class="whitespace-pre-wrap break-words text-xs text-fg-faint">
                          {question.answerProvenance.where}
                        </p>
                        <p class="whitespace-pre-wrap break-words text-xs text-fg-faint">
                          {question.answerProvenance.when}
                        </p>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {retired.length > 0 && (
            <div class="mt-8">
              <p class="text-xs font-medium text-fg-muted">
                {t('ask.retired')} · {retired.length}
              </p>
              <ul class="mt-3 space-y-5" aria-label={t('ask.retired')}>
                {retired.map((question) => (
                  <li key={question.id} id={`neo-ref-question-${question.id}`}>
                    <div class="neo-time-line neo-question-time">
                      <NeoTime at={question.createdAt} />
                    </div>
                    <SettledQuestionBody question={question} />
                    <p>
                      {t('question.retired', { question: '' })}
                      {question.retiredReason ? `: ${question.retiredReason}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ask.outcome && (
            <div class="mt-8">
              <p class="text-xs font-medium text-fg-muted">{t('ask.outcome')}</p>
              <MarkdownRenderer
                content={ask.outcome}
                class="neo-markdown neo-markdown-assistant mt-1 min-w-0 text-sm leading-relaxed"
              />
            </div>
          )}
        </Modal>
      )}
      {(itemCount > 0 || received.summary || ask.outcome) && (
        <div class={neoFooterClass}>
          <button
            ref={allButton}
            type="button"
            data-ask-details-toggle
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            class="flex min-h-11 w-full items-center justify-center gap-2 text-sm font-medium text-accent hover:bg-fill-soft"
          >
            <span aria-hidden="true">≡</span>
            {t('ask.all', { count: itemCount })}
          </button>
        </div>
      )}
    </article>
  );
}
