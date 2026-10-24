import { ContentDisclosureControl } from '../components/ui/ContentDisclosureControl.tsx';
import { ChevronRightGlyph } from '../components/icons/common-glyphs.tsx';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { ArtifactCards } from '../components/artifacts/ArtifactCards.tsx';
import type {
  NeoAskEntry,
  NeoQuestionAnswer,
  NeoQuestionEntry,
  NeoTodoEntry,
} from '@hyperneo/shared/types/neo-ask';
import { useEffect, useRef, useState } from 'preact/hooks';
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
} from './NeoCardParts.tsx';
import { neoSessionKind } from './work-driver.ts';
import { NEO_DONE_SHOWN, type NeoDoneTodosPage, neoDonePageMerge } from './neo-asks.ts';
import { messageTime } from './NeoMessage.tsx';
import { t } from '../lib/i18n/index.ts';
import { neoQuestionText, neoTodoDetail, neoTodoHasMore, neoTodoStatus } from './todo-status.ts';

const states = {
  waiting: ['ask.state.waiting', 'text-warning bg-warning/10'],
  doing: ['ask.state.doing', 'text-accent bg-accent/10'],
  done: ['ask.state.done', 'text-success bg-success/10'],
  dropped: ['ask.state.dropped', 'text-fg-muted bg-fill-soft'],
  todo: ['ask.state.todo', 'text-fg-muted bg-fill-soft'],
} as const;

const marks = {
  todo: ['○', 'text-fg-faint'],
  doing: ['●', 'text-accent'],
  blocked: ['!', 'text-warning'],
  done: ['✓', 'text-success'],
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

function TodoRow({
  todo,
  number,
  checked,
  onCheck,
  onOpen,
  expanded = false,
  onToggle,
}: {
  todo: NeoTodoEntry;
  expanded?: boolean;
  onToggle?: () => void;
  number?: number;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  onOpen?: (link: string, title: string) => void;
}) {
  const [mark, color] = marks[todo.state];
  const detailId = `neo-todo-detail-${todo.id}`;
  const detail = neoTodoDetail(todo);
  const head = (
    <>
      <span
        class={`break-words ${todo.state === 'removed' ? 'text-fg-faint line-through' : 'text-fg'}`}
      >
        {todo.title}
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
        {number === undefined
          ? neoTodoStatus(todo)
          : t('todo.doneWhen', { doneWhen: todo.doneWhen })}
      </span>
    </>
  );
  return (
    <div
      id={`neo-ref-todo-${todo.id}`}
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
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={t(expanded ? 'todo.hideDetails' : 'todo.showDetails', {
              title: todo.title,
            })}
            onClick={onToggle}
            class="block w-full min-w-0 rounded text-left focus-visible:outline-accent"
          >
            <ChevronRightGlyph
              aria-hidden="true"
              data-todo-hint
              class={`-ml-0.5 mr-1 inline-block h-3.5 w-3.5 align-[-2px] text-fg-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            />
            {head}
          </button>
        ) : (
          <div class="block w-full min-w-0 text-left">{head}</div>
        )}
        {(!onToggle || expanded) && (
          <div id={detailId} data-todo-details={onToggle ? '' : undefined} class="flow-root">
            <div class="contents [&>p:last-child]:inline [&>span:last-child]:inline">
              {onToggle &&
                detail.map((text) => (
                  <p key={text} class="mt-1 whitespace-pre-wrap break-words text-xs text-fg-muted">
                    {text}
                  </p>
                ))}
              <ArtifactCards artifacts={todo.artifacts} />
              {number === undefined && todo.state === 'blocked' && todo.nextAction && (
                <span data-todo-next-action class="block break-words text-xs text-fg-muted">
                  {t('todo.nextAction', { action: todo.nextAction })}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {todo.link && todo.state !== 'removed' && onOpen && (
        <div class="flex shrink-0 items-center justify-end gap-2 self-start">
          <button
            type="button"
            class={neoSecondaryClass}
            aria-label={t('todo.openTitle', { title: todo.title })}
            onClick={() => onOpen(todo.link!, todo.worker?.label ?? todo.title)}
          >
            <NeoSessionMark kind={neoSessionKind(todo.worker?.adapter, todo.link)} />
            {t('todo.open')}
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionDocument({ question }: { question: NeoQuestionEntry }) {
  const [open, setOpen] = useState(false);
  if (!question.document) return null;
  return (
    <>
      <button type="button" class={neoPlainClass} onClick={() => setOpen(true)}>
        {t('question.document')}
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title={t('question.document')} size="xl">
        <pre class="whitespace-pre-wrap break-words text-sm text-fg">{question.document}</pre>
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
}: {
  question: NeoQuestionEntry;
  todos: readonly NeoTodoEntry[];
  disabled?: boolean;
  onAnswer: (answer: NeoQuestionAnswer) => void;
  onReply?: () => void;
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
      <MarkdownRenderer
        content={neoQuestionText(question)}
        class="neo-markdown neo-markdown-assistant min-w-0 text-sm leading-relaxed"
      />
      <QuestionDocument question={question} />
      <ArtifactCards artifacts={question.artifacts} />
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
  entry,
  disabled,
  onAnswer,
  onReply,
  onOpen,
  onSettle,
  onLoadDone,
}: {
  entry: NeoAskEntry;
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onReply?: (question: NeoQuestionEntry) => void;
  onOpen?: (link: string, title: string) => void;
  onSettle?: (status: 'done' | 'dropped') => void | Promise<void>;
  onLoadDone?: (askId: string, offset: number) => Promise<NeoDoneTodosPage>;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
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
  const asked = entry.questions.filter((question) => question.state === 'open');
  const answered = entry.questions.filter((question) => question.state === 'answered');
  const retired = entry.questions.filter((question) => question.state === 'retired');
  const inQuestion = new Set(
    asked.flatMap((question) => (question.kind === 'start' ? (question.startTodos ?? []) : []))
  );
  const sent = todos.filter((todo) => todo.state === 'done');
  const knownDone = [
    ...sent,
    ...paged.filter((todo) => !todos.some((other) => other.id === todo.id)),
  ];
  const shownDone = doneOpen || entry.doneCount <= NEO_DONE_SHOWN ? knownDone : [];
  const hiddenDone = entry.doneCount - shownDone.length;
  const live = [
    ...todos.filter((todo) => todo.state !== 'removed' && todo.state !== 'done'),
    ...shownDone,
  ];
  const showMoreDone = () => {
    setDoneOpen(true);
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
  const listed = live.filter((todo) => !inQuestion.has(todo.id));
  const expandable = listed.filter(neoTodoHasMore);
  const allExpanded = expandable.every((todo) => expanded.includes(todo.id));
  const removed = todos.filter((todo) => todo.state === 'removed' && !inQuestion.has(todo.id));
  const hasDetails =
    answered.length > 0 || retired.length > 0 || !!ask.outcome || removed.length > 0;
  const everything = allExpanded && (open || !hasDetails);
  const toggleEverything = () => {
    setExpanded(everything ? [] : expandable.map((todo) => todo.id));
    setOpen(!everything);
    if (everything)
      requestAnimationFrame(() => {
        const card = cardRef.current;
        if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' });
      });
  };
  const [label, tone] = states[entry.state];
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
        <span class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{t(label)}</span>
        <span class="flex-1" />
        {onSettle && ask.status === 'open' && (
          <Dropdown
            position="right"
            items={[
              { label: t('ask.markDone'), onClick: () => void settle('done'), disabled },
              {
                label: t('ask.drop'),
                onClick: () => void settle('dropped'),
                danger: true,
                disabled,
              },
            ]}
            trigger={
              <IconButton title={t('ask.actions')} size="sm" class="text-fg-faint">
                <NeoMoreIcon />
              </IconButton>
            }
          />
        )}
      </div>
      <h3 class="mt-2 line-clamp-3 break-words text-base font-semibold leading-snug">
        {ask.title}
      </h3>
      {settleError && (
        <p role="alert" class="mt-2 break-words text-sm text-danger">
          {settleError}
        </p>
      )}
      {asked.map((question) => (
        <QuestionBox
          key={question.id}
          question={question}
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
                neoTodoHasMore(todo)
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
      {open && hasDetails && (
        <div data-ask-details class="mt-3 space-y-3 text-sm text-fg-muted">
          {removed.length > 0 && (
            <div>
              <p class="text-xs font-medium text-fg-faint">{t('ask.removed')}</p>
              <ul class="mt-1.5 space-y-1.5" aria-label={t('ask.removed')}>
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
            <div>
              <p class="text-xs font-medium text-fg-faint">{t('ask.answered')}</p>
              <ul class="mt-1.5 space-y-1.5" aria-label={t('ask.answered')}>
                {answered.map((question) => (
                  <li key={question.id} id={`neo-ref-question-${question.id}`}>
                    <MarkdownRenderer
                      content={neoQuestionText(question)}
                      class="neo-markdown neo-markdown-assistant min-w-0 text-sm leading-relaxed"
                    />
                    <QuestionDocument question={question} />
                    <ArtifactCards artifacts={question.artifacts} />
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
            <div>
              <p class="text-xs font-medium text-fg-faint">{t('ask.retired')}</p>
              <ul class="mt-1.5 space-y-1.5" aria-label={t('ask.retired')}>
                {retired.map((question) => (
                  <li key={question.id} id={`neo-ref-question-${question.id}`}>
                    <MarkdownRenderer
                      content={neoQuestionText(question)}
                      class="neo-markdown neo-markdown-assistant min-w-0 text-sm leading-relaxed"
                    />
                    <QuestionDocument question={question} />
                    <ArtifactCards artifacts={question.artifacts} />
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
            <div>
              <p class="text-xs font-medium text-fg-faint">{t('ask.outcome')}</p>
              <p class="mt-1 whitespace-pre-wrap break-words">{ask.outcome}</p>
            </div>
          )}
        </div>
      )}
      {(hasDetails || expandable.length > 1) && (
        <div class={neoFooterClass}>
          <span class="flex-1" />
          <ContentDisclosureControl
            data-ask-details-toggle
            expanded={everything}
            onToggle={toggleEverything}
            aria-label={t('ask.details')}
          />
        </div>
      )}
    </article>
  );
}
