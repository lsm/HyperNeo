import { ChevronRightGlyph } from '../components/icons/common-glyphs.tsx';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { ArtifactCards } from '../components/artifacts/ArtifactCards.tsx';
import { FileReferenceCards } from '../components/artifacts/FileReferenceCards.tsx';
import {
  previewLinkedReferenceCandidates,
  previewLinkedReferenceSpans,
} from '@hyperneo/shared/types/artifact-reference';
import { openArtifactPreview } from '../lib/artifact-preview-store.ts';
import type {
  NeoAskEntry,
  NeoQuestionAnswer,
  NeoQuestionEntry,
  NeoTodoEntry,
} from '@hyperneo/shared/types/neo-ask';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Modal } from '../components/ui/Modal.tsx';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import {
  NeoMoreIcon,
  neoCardClass,
  neoFooterClass,
  neoPlainClass,
  neoPrimaryClass,
  neoSecondaryClass,
  NeoSessionMark,
  NeoSessionOpen,
} from './NeoCardParts.tsx';
import { neoSessionKind } from './work-driver.ts';
import { type NeoDoneTodosPage, neoDonePageMerge } from './neo-asks.ts';
import { messageTime } from './NeoMessage.tsx';
import { t } from '../lib/i18n/index.ts';
import { copyToClipboard } from '../lib/utils.ts';
import {
  neoQuestionText,
  neoTodoDetail,
  neoTodoHasMore,
  neoTodoNextAction,
  neoTodoStatus,
} from './todo-status.ts';
import { neoTopicColor } from './topic-color.ts';

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
  blocked: ['!', 'text-warning'],
  done: ['✓', 'text-success'],
  closed_unverified: ['?', 'text-warning'],
  failed: ['✕', 'text-danger'],
  removed: ['', 'text-fg-faint'],
} as const;

const choiceClass =
  'flex min-w-0 max-w-full items-start gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-xs font-semibold text-fg [overflow-wrap:anywhere] hover:border-accent/40 hover:text-accent focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';

function choiceLetter(question: NeoQuestionEntry, option: string) {
  return question.optionLabels?.[question.options?.indexOf(option) ?? -1] ?? '';
}

function ChoiceLetter({ label }: { label: string }) {
  return label ? <span class="shrink-0 text-accent">{label}</span> : null;
}

export function neoQuestionAnswerLabel(question: NeoQuestionEntry, todos: readonly NeoTodoEntry[]) {
  const answer = question.answer;
  if (answer === null) return '';
  if (question.kind === 'yesno' && question.answeredBy === 'button')
    return (answer === 'yes' ? question.yesLabel : question.noLabel) ?? String(answer);
  if (question.kind === 'start' && Array.isArray(answer))
    return answer.length
      ? t('question.started', {
          todos: answer
            .map((id) => todos.find((todo) => todo.id === id)?.title ?? id)
            .join(t('list.separator')),
        })
      : t('question.notNow');
  return Array.isArray(answer)
    ? answer
        .map((option) => {
          const label = question.kind === 'choice' ? choiceLetter(question, option) : '';
          return label ? `${label}. ${option}` : option;
        })
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

function TodoRow({
  todo,
  number,
  checked,
  onCheck,
  onOpen,
  expanded = false,
  anchorPrefix = '',
  onToggle,
}: {
  todo: NeoTodoEntry;
  expanded?: boolean;
  anchorPrefix?: string;
  onToggle?: () => void;
  number?: number;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  onOpen?: (link: string, title: string) => void;
}) {
  const [mark, color] = marks[todo.state];
  const detailId = `${anchorPrefix}neo-todo-detail-${todo.id}`;
  const detail = neoTodoDetail(todo);
  const nextAction = neoTodoNextAction(todo);
  const head = (
    <>
      <span
        class={`break-words ${todo.state === 'removed' ? 'text-fg-faint line-through' : 'text-fg'}`}
      >
        <CardFileText text={todo.title} kind="todo" id={todo.id} />
      </span>
      {todo.addedAfterStart && todo.state !== 'removed' && (
        <span class="ml-1.5 rounded border border-accent px-1 text-xs font-semibold text-accent">
          {t('todo.new')}
        </span>
      )}
      {todo.worker && (
        <span data-worker-label class="block break-words text-xs text-fg-muted">
          {todo.worker.label}
        </span>
      )}
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
    </>
  );
  return (
    <div
      id={`${anchorPrefix}neo-ref-todo-${todo.id}`}
      data-ask-todo={todo.id}
      data-todo-state={todo.state}
      class={`grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2.5 text-sm ${number === undefined ? 'border-t border-line py-2 first:border-t-0' : 'py-1'}`}
    >
      {onCheck ? (
        <input
          type="checkbox"
          aria-label={t('todo.startTitle', { title: todo.title })}
          checked={checked}
          onChange={(event) => onCheck((event.target as HTMLInputElement).checked)}
          class="mt-1 shrink-0"
        />
      ) : (
        <span aria-hidden="true" class={`w-4 shrink-0 text-center font-semibold ${color}`}>
          {number ?? mark}
        </span>
      )}
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
            >
              <ChevronRightGlyph
                aria-hidden="true"
                data-todo-hint
                class={`absolute left-0 top-1 h-3.5 w-3.5 text-fg-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              />
            </button>
            <div data-todo-head class="pointer-events-none relative min-w-0 pl-4">
              {head}
            </div>
          </div>
        ) : (
          <div class="block w-full min-w-0 text-left">{head}</div>
        )}
        {(!onToggle || expanded) && (
          <div id={detailId} data-todo-details={onToggle ? '' : undefined} class="flow-root">
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
      </div>
      {todo.link && todo.state !== 'removed' && onOpen && (
        <div class="flex shrink-0 items-center justify-end gap-2 self-start">
          <NeoSessionOpen
            kind={neoSessionKind(todo.worker?.adapter, todo.link)}
            label={t('todo.openTitle', { title: todo.title })}
            onOpen={() => onOpen(todo.link!, todo.worker?.label ?? todo.title)}
          />
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

function QuestionBox({
  question,
  todos,
  disabled,
  onAnswer,
  onReply,
  onOpen,
}: {
  question: NeoQuestionEntry;
  todos: readonly NeoTodoEntry[];
  disabled?: boolean;
  onAnswer: (answer: NeoQuestionAnswer) => void;
  onReply?: () => void;
  onOpen?: (link: string, title: string) => void;
}) {
  const listed = (question.startTodos ?? []).flatMap(
    (id) => todos.find((todo) => todo.id === id) ?? []
  );
  const [picked, setPicked] = useState<string[]>(
    question.kind === 'start' ? listed.map((todo) => todo.id) : []
  );
  const seen = useRef(listed.map((todo) => todo.id));
  const ids = listed.map((todo) => todo.id).join(',');
  useEffect(() => {
    const now = ids ? ids.split(',') : [];
    const added = now.filter((id) => !seen.current.includes(id));
    seen.current = now;
    setPicked((current) => [...current.filter((id) => now.includes(id)), ...added]);
  }, [ids]);
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
      {question.kind === 'start' &&
        listed.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            number={0}
            checked={picked.includes(todo.id)}
            onCheck={(on) => toggle(todo.id, on)}
          />
        ))}
      {question.kind === 'choice' && question.multiple && (
        <div class="mt-2 space-y-1">
          {(question.options ?? []).map((option) => (
            <label
              key={option}
              data-choice-option
              class="flex min-w-0 max-w-full items-start gap-2 text-sm [overflow-wrap:anywhere]"
            >
              <input
                type="checkbox"
                class="mt-1 shrink-0"
                aria-label={`${choiceLetter(question, option)} ${option}`.trim()}
                checked={picked.includes(option)}
                onChange={(event) => toggle(option, (event.target as HTMLInputElement).checked)}
              />
              <ChoiceLetter label={choiceLetter(question, option)} />
              <span class="min-w-0">{option}</span>
            </label>
          ))}
        </div>
      )}
      {question.kind === 'choice' && !question.multiple && (
        <div class="mt-2 flex flex-col items-stretch gap-1.5">
          {(question.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              data-choice-option
              class={choiceClass}
              aria-label={`${choiceLetter(question, option)} ${option}`.trim()}
              disabled={disabled}
              onClick={() => onAnswer([option])}
            >
              <ChoiceLetter label={choiceLetter(question, option)} />
              <span class="min-w-0">{option}</span>
            </button>
          ))}
        </div>
      )}
      <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
        {reply}
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
        {question.kind === 'start' && (
          <>
            <button
              type="button"
              class={neoSecondaryClass}
              disabled={disabled}
              onClick={() => onAnswer([])}
            >
              {t('question.notNow')}
            </button>
            <button
              type="button"
              class={neoPrimaryClass}
              disabled={disabled || picked.length === 0}
              onClick={() => onAnswer(picked)}
            >
              {t('question.start')}
            </button>
          </>
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
  onReplyAsk,
  onOpen,
  onSettle,
  onLoadDone,
  onLoadDetails,
  onTopic,
}: {
  entry: NeoAskEntry;
  focusedItem?: { questionId?: string; todoId?: string };
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onReply?: (question: NeoQuestionEntry) => void;
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
  const asked = entry.questions.filter((question) => question.state === 'open');
  const answered = entry.questions.filter((question) => question.state === 'answered');
  const retired = entry.questions.filter((question) => question.state === 'retired');
  const inQuestion = new Set(
    asked.flatMap((question) => (question.kind === 'start' ? (question.startTodos ?? []) : []))
  );
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
  const listed = live.filter((todo) => !inQuestion.has(todo.id));
  const focused = ask.focusedSession;
  const focusedFallback =
    focused?.link &&
    onOpen &&
    !asked.some((question) => question.sourceSession?.link === focused.link) &&
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
      onOpen={
        onOpen &&
        ((link, title) => {
          setOpen(false);
          onOpen(link, title);
        })
      }
      expanded={expanded.includes(todo.id)}
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
  return (
    <article
      ref={cardRef}
      aria-label={ask.title}
      id={`neo-ref-ask-${ask.id}`}
      data-ask={ask.id}
      data-ask-state={entry.state}
      class={neoCardClass}
    >
      <div class="flex min-h-7 items-center gap-2">
        {ask.topic && (
          <button
            type="button"
            disabled={!onTopic}
            onClick={() => onTopic?.(ask.topic!)}
            class="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-fg enabled:hover:underline"
          >
            <span
              data-topic-swatch
              aria-hidden="true"
              class="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: neoTopicColor(ask.topic) }}
            />
            <span class="truncate">{ask.topic}</span>
          </button>
        )}
        <span class="flex-1" />
        <span data-ask-status class={`flex shrink-0 items-center gap-1.5 text-xs ${tone}`}>
          <span data-status-dot aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-current" />
          <span class={weight}>{t(label)}</span>
        </span>
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
      <h3 class="mt-2 line-clamp-3 break-words text-base font-semibold leading-snug">
        {ask.title}
      </h3>
      {detailError && !open && (
        <p role="alert" class="mt-2 text-sm text-danger">
          {detailError}
        </p>
      )}
      {entry.summary && (
        <p class="mt-1 text-xs text-fg-muted">
          {t('ask.todos')} · {entry.summary.todoCount}
          {entry.summary.openQuestionCount > 0 && (
            <>
              {' '}
              · {t('ask.state.waiting')} · {entry.summary.openQuestionCount}
            </>
          )}
        </p>
      )}
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
          todos={todos}
          disabled={disabled}
          onAnswer={(answer) => onAnswer(question.id, answer)}
          onReply={onReply ? () => onReply(question) : undefined}
        />
      ))}
      {listed.length > 0 && (
        <div class="mt-3" aria-label={t('ask.todos')}>
          {listed.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              onOpen={onOpen}
              expanded={expanded.includes(todo.id)}
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
                <section key={group.label} aria-label={group.label} class="mt-4 first:mt-0">
                  <h3 class="text-xs font-medium text-fg-muted">
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
            <div class="mt-4">
              <p class="text-xs font-medium text-fg-faint">{t('ask.removed')}</p>
              <ul class="mt-1.5 space-y-1.5" aria-label={t('ask.removed')}>
                {removed.map((todo) => (
                  <li
                    key={todo.id}
                    id={`${inQuestion.has(todo.id) ? 'all-' : ''}neo-ref-todo-${todo.id}`}
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
            <div class="mt-4">
              <p class="text-xs font-medium text-fg-faint">{t('ask.answered')}</p>
              <ul class="mt-1.5 space-y-1.5" aria-label={t('ask.answered')}>
                {answered.map((question) => (
                  <li key={question.id} id={`neo-ref-question-${question.id}`}>
                    <SettledQuestionBody question={question} />
                    <p>
                      — {neoQuestionAnswerLabel(question, todos)}
                      {question.answeredAt
                        ? ` · ${messageTime(question.answeredAt)?.label ?? ''}`
                        : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {retired.length > 0 && (
            <div class="mt-4">
              <p class="text-xs font-medium text-fg-faint">{t('ask.retired')}</p>
              <ul class="mt-1.5 space-y-1.5" aria-label={t('ask.retired')}>
                {retired.map((question) => (
                  <li key={question.id} id={`neo-ref-question-${question.id}`}>
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
            <div class="mt-4">
              <p class="text-xs font-medium text-fg-faint">{t('ask.outcome')}</p>
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
