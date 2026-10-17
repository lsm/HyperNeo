import type {
  NeoAskEntry,
  NeoQuestion,
  NeoQuestionAnswer,
  NeoTodoEntry,
} from '@hyperneo/shared/types/neo-ask';
import { useState } from 'preact/hooks';
import {
  neoCardClass,
  neoFooterClass,
  neoPlainClass,
  neoPrimaryClass,
  neoSecondaryClass,
} from './NeoCardParts.tsx';
import { NeoIcon } from './NeoIcon.tsx';

const states = {
  waiting: ['等你', 'text-warning bg-warning/10'],
  doing: ['在做', 'text-accent bg-accent/10'],
  done: ['做完', 'text-success bg-success/10'],
  dropped: ['放弃了', 'text-fg-muted bg-fill-soft'],
  todo: ['没开始', 'text-fg-muted bg-fill-soft'],
} as const;

const marks = {
  todo: ['○', 'text-fg-faint'],
  doing: ['●', 'text-accent'],
  done: ['✓', 'text-success'],
  failed: ['✕', 'text-danger'],
  removed: ['', 'text-fg-faint'],
} as const;

export function neoQuestionAnswerLabel(question: NeoQuestion, todos: readonly NeoTodoEntry[]) {
  const answer = question.answer;
  if (answer === null) return '';
  if (question.kind === 'yesno' && question.answeredBy === 'button')
    return (answer === 'yes' ? question.yesLabel : question.noLabel) ?? String(answer);
  if (question.kind === 'start' && Array.isArray(answer))
    return answer.length
      ? `开始 ${answer.map((id) => todos.find((todo) => todo.id === id)?.title ?? id).join('、')}`
      : '先不做';
  return Array.isArray(answer) ? answer.join('、') || '都不要' : answer;
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
          aria-label={`开始 ${todo.title}`}
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
            新
          </span>
        )}
        <span class="block break-words text-xs text-fg-muted">
          {number === undefined ? todo.status : `做完 = ${todo.doneWhen}`}
        </span>
      </div>
      {todo.link && todo.state !== 'removed' && onOpen && (
        <button
          type="button"
          class={neoSecondaryClass}
          aria-label={`打开 ${todo.title}`}
          onClick={() => onOpen(todo.link!, todo.title)}
        >
          打开
        </button>
      )}
    </div>
  );
}

function QuestionBox({
  question,
  todos,
  disabled,
  onAnswer,
  onReply,
}: {
  question: NeoQuestion;
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
  const toggle = (value: string, on: boolean) =>
    setPicked((current) => (on ? [...current, value] : current.filter((item) => item !== value)));
  const reply = onReply && (
    <button type="button" class={neoPlainClass} disabled={disabled} onClick={onReply}>
      在聊天里回复
    </button>
  );
  return (
    <div
      id={`neo-ref-question-${question.id}`}
      data-ask-question={question.id}
      data-question-kind={question.kind}
      class="mt-3 rounded-lg bg-warning/10 px-3 py-2"
    >
      <p class="text-sm font-semibold">{question.text}</p>
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
            <label key={option} class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(option)}
                onChange={(event) => toggle(option, (event.target as HTMLInputElement).checked)}
              />
              {option}
            </label>
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
        {question.kind === 'choice' &&
          !question.multiple &&
          (question.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              class={neoSecondaryClass}
              disabled={disabled}
              onClick={() => onAnswer([option])}
            >
              {option}
            </button>
          ))}
        {question.kind === 'choice' && question.multiple && (
          <button
            type="button"
            class={neoPrimaryClass}
            disabled={disabled}
            onClick={() => onAnswer(picked)}
          >
            确定
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
              先不做
            </button>
            <button
              type="button"
              class={neoPrimaryClass}
              disabled={disabled || picked.length === 0}
              onClick={() => onAnswer(picked)}
            >
              开始
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
}: {
  entry: NeoAskEntry;
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onReply?: (question: NeoQuestion) => void;
  onOpen?: (link: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { ask, todos } = entry;
  const asked = entry.questions.filter((question) => question.state === 'open');
  const answered = entry.questions.filter((question) => question.state === 'answered');
  const inQuestion = new Set(
    asked.flatMap((question) => (question.kind === 'start' ? (question.startTodos ?? []) : []))
  );
  const [label, tone] = states[entry.state];
  return (
    <article
      aria-label={ask.title}
      data-ask={ask.id}
      data-ask-state={entry.state}
      class={neoCardClass}
    >
      <div class="flex min-h-7 items-center gap-2">
        <span class={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>
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
      {todos.some((todo) => !inQuestion.has(todo.id)) && (
        <div class="mt-3" aria-label="Todos">
          {todos
            .filter((todo) => !inQuestion.has(todo.id))
            .map((todo) => (
              <TodoRow key={todo.id} todo={todo} onOpen={onOpen} />
            ))}
        </div>
      )}
      {open && (
        <div data-ask-details class="mt-3 space-y-3 text-sm text-fg-muted">
          {answered.length > 0 && (
            <div>
              <p class="text-xs font-medium text-fg-faint">已回答</p>
              <ul class="mt-1.5 space-y-1.5" aria-label="已回答">
                {answered.map((question) => (
                  <li key={question.id} id={`neo-ref-question-${question.id}`}>
                    {question.text} — {neoQuestionAnswerLabel(question, todos)}
                    {question.answeredAt
                      ? ` · ${new Date(question.answeredAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}`
                      : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ask.outcome && (
            <div>
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
