import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
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
import { NeoIcon } from './NeoIcon.tsx';
import { messageTime } from './NeoMessage.tsx';
import { t } from '../lib/i18n/index.ts';
import { neoQuestionText, neoTodoStatus } from './todo-status.ts';

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

function TodoRow({
  todo,
  number,
  checked,
  onCheck,
  onOpen,
}: {
  todo: NeoTodoEntry;
  number?: number;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  onOpen?: (link: string, title: string) => void;
}) {
  const [mark, color] = marks[todo.state];
  return (
    <div
      id={`neo-ref-todo-${todo.id}`}
      data-ask-todo={todo.id}
      data-todo-state={todo.state}
      class={`flex min-w-0 items-start gap-2.5 text-sm ${number === undefined ? 'border-t border-line py-2 first:border-t-0' : 'py-1'}`}
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
        <span
          class={`block break-words text-xs ${number === undefined && todo.state === 'blocked' ? 'text-warning' : 'text-fg-muted'}`}
        >
          {number === undefined
            ? neoTodoStatus(todo)
            : t('todo.doneWhen', { doneWhen: todo.doneWhen })}
        </span>
        {number === undefined && todo.state === 'blocked' && todo.nextAction && (
          <span data-todo-next-action class="block break-words text-xs text-fg-muted">
            {t('todo.nextAction', { action: todo.nextAction })}
          </span>
        )}
      </div>
      {todo.link && todo.state !== 'removed' && onOpen && (
        <button
          type="button"
          class={neoSecondaryClass}
          aria-label={t('todo.openTitle', { title: todo.title })}
          onClick={() => onOpen(todo.link!, todo.title)}
        >
          <NeoSessionMark kind={neoSessionKind(null, todo.link)} />
          {t('todo.open')}
        </button>
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
}: {
  entry: NeoAskEntry;
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onReply?: (question: NeoQuestionEntry) => void;
  onOpen?: (link: string, title: string) => void;
  onSettle?: (status: 'done' | 'dropped') => void;
}) {
  const [open, setOpen] = useState(false);
  const { ask, todos } = entry;
  const asked = entry.questions.filter((question) => question.state === 'open');
  const answered = entry.questions.filter((question) => question.state === 'answered');
  const retired = entry.questions.filter((question) => question.state === 'retired');
  const inQuestion = new Set(
    asked.flatMap((question) => (question.kind === 'start' ? (question.startTodos ?? []) : []))
  );
  const live = todos.filter((todo) => todo.state !== 'removed');
  const removed = todos.filter((todo) => todo.state === 'removed' && !inQuestion.has(todo.id));
  const hasDetails =
    answered.length > 0 || retired.length > 0 || !!ask.outcome || removed.length > 0;
  const [label, tone] = states[entry.state];
  return (
    <article
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
              { label: t('ask.markDone'), onClick: () => onSettle('done'), disabled },
              {
                label: t('ask.drop'),
                onClick: () => onSettle('dropped'),
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
      {live.some((todo) => !inQuestion.has(todo.id)) && (
        <div class="mt-3" aria-label={t('ask.todos')}>
          {live
            .filter((todo) => !inQuestion.has(todo.id))
            .map((todo) => (
              <TodoRow key={todo.id} todo={todo} onOpen={onOpen} />
            ))}
        </div>
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
      {hasDetails && (
        <div class={neoFooterClass}>
          <span class="flex-1" />
          <button
            type="button"
            data-ask-details-toggle
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            class={neoPlainClass}
          >
            {t('ask.details')}
            <NeoIcon
              name="chevron"
              class={`!h-3.5 !w-3.5 transition-transform${open ? '' : ' rotate-180'}`}
            />
          </button>
        </div>
      )}
    </article>
  );
}
