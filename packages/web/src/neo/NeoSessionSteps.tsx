import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ContentDisclosureControl } from '../components/ui/ContentDisclosureControl.tsx';
import { t } from '../lib/i18n/index.ts';
import { NeoIcon } from './NeoIcon.tsx';
import {
  type SessionItem,
  type SessionSteps,
  sessionClock,
  sessionDuration,
  sessionStepCounts,
} from './session-transcript.ts';

const rowClass = 'rounded-xl border border-line bg-surface';

export function NeoToolRow({
  name,
  summary,
  result,
  isError,
}: {
  name: string;
  summary: string;
  result: string | null;
  isError: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tone = isError ? 'text-danger' : result === null ? 'text-accent' : 'text-success';
  return (
    <div class={`${rowClass} flow-root px-3 py-2`}>
      <span class={`mr-2 inline-flex w-4 justify-center align-middle ${tone}`} aria-hidden="true">
        <NeoIcon
          name={isError ? 'alert' : result === null ? 'spark' : 'check'}
          class="!h-3.5 !w-3.5"
        />
      </span>
      <span class="mr-2 text-xs font-semibold text-fg">{name}</span>
      <span class="break-words font-mono text-xs text-fg-muted">{summary}</span>
      {open && !!result && (
        <pre class="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-muted">
          {result}
        </pre>
      )}
      {!!result && (
        <ContentDisclosureControl
          expanded={open}
          onToggle={() => setOpen(!open)}
          aria-label={`${name} ${summary}`}
        />
      )}
    </div>
  );
}

export function NeoThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = text.split(/\r?\n/).find((line) => line) ?? '';
  return (
    <div class={`${rowClass} flow-root px-3 py-2`}>
      <span
        class="mr-2 inline-flex w-4 justify-center align-middle text-fg-muted"
        aria-hidden="true"
      >
        <NeoIcon name="spark" class="!h-3 !w-3" />
      </span>
      <span class="mr-2 text-xs font-semibold text-fg">{t('session.thinking')}</span>
      <span
        class={`text-xs italic text-fg-muted ${open ? 'whitespace-pre-wrap break-words' : 'inline-block max-w-[70%] truncate align-bottom'}`}
      >
        {open ? text : firstLine}
      </span>
      {!!text && (
        <ContentDisclosureControl
          expanded={open}
          onToggle={() => setOpen(!open)}
          aria-label={t('session.thinking')}
        />
      )}
    </div>
  );
}

function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

function currentLine(item: SessionItem | undefined): string {
  if (item?.kind.type === 'tool')
    return item.kind.summary ? `${item.kind.name}  ${item.kind.summary}` : item.kind.name;
  return item?.kind.type === 'thinking' ? t('session.thinkingNow') : '';
}

export function sessionStepCountsLabel(steps: SessionSteps): string {
  const { tools, thinking } = sessionStepCounts(steps);
  return [
    tools ? t(tools === 1 ? 'session.toolCall' : 'session.toolCalls', { count: tools }) : null,
    thinking ? t('session.thinkingCount', { count: thinking }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function NeoSessionStepsLine({
  steps,
  renderStep,
}: {
  steps: SessionSteps;
  renderStep: (item: SessionItem) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(steps.running);
  const counts = sessionStepCountsLabel(steps);
  const current = currentLine(steps.items[steps.items.length - 1]);
  const control = (
    <ContentDisclosureControl
      expanded={open}
      onToggle={() => setOpen(!open)}
      aria-label={t(open ? 'session.hideSteps' : 'session.showSteps')}
    />
  );
  return (
    <div class="flow-root">
      <div class="flex w-full min-w-0 items-center gap-2.5 rounded-[14px] border border-line bg-surface px-3.5 py-[11px] text-left">
        {steps.running ? (
          <span
            aria-hidden="true"
            class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
          />
        ) : (
          <span class="inline-flex shrink-0 text-success" aria-hidden="true">
            <NeoIcon name="check" class="!h-3.5 !w-3.5" />
          </span>
        )}
        <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span class="flow-root text-sm text-fg">
            {steps.running ? (
              <>
                {`${t('session.workingNow')} `}
                <span class="tabular-nums text-fg-muted">{sessionClock(now - steps.start)}</span>
              </>
            ) : (
              t('session.worked', { duration: sessionDuration(steps.end - steps.start) })
            )}
            {counts && <span class="text-fg-muted">{` · ${counts}`}</span>}
            {!open && !steps.running && control}
          </span>
          {steps.running && current && (
            <span class="flow-root font-mono text-xs text-fg-muted">
              {current}
              {!open && control}
            </span>
          )}
        </span>
      </div>
      {open && (
        <div class="ml-2 mt-2 flex flex-col gap-1.5 border-l-2 border-line pl-3">
          {steps.items.map((item) => (
            <div key={item.id}>{renderStep(item)}</div>
          ))}
        </div>
      )}
      {(open || (steps.running && !current)) && control}
    </div>
  );
}
