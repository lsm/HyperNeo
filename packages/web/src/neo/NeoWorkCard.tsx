import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkDriverReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { useMemo } from 'preact/hooks';
import { ProviderLogo } from '../components/ProviderLogo.tsx';
import { Button } from '../components/ui/Button.tsx';
import { providerLogoColor } from '../lib/provider-brand.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoWorkQuestion } from './NeoWorkQuestion.tsx';
import { neoWorkDriverLabel, neoWorkDriverLink } from './work-driver.ts';

const labels: Record<NeoWork['status'], string> = {
  proposed: 'Your call',
  queued: 'Handed to HyperNeo',
  reported: 'Response ready',
  failed: 'Failed',
  cancelled: 'Stopped',
};

const appLogos: Record<string, string> = {
  'claude-desktop': 'anthropic',
  'codex-desktop': 'anthropic-codex',
};

const tones = {
  success: 'text-success bg-success/10',
  warning: 'text-warning bg-warning/10',
  accent: 'text-accent bg-accent/10',
};

function neoWorkTone(
  work: NeoWork,
  driver: NeoWorkDriverReceipt | undefined,
  waiting: boolean
): keyof typeof tones {
  const status = work.status === 'queued' ? driver?.status : null;
  if (work.status === 'reported' || status === 'done') return 'success';
  if (
    (work.status === 'queued' && waiting) ||
    work.status === 'failed' ||
    work.status === 'cancelled' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'needs_you'
  )
    return 'warning';
  return 'accent';
}

const interactive =
  'button, a, summary, details, input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="button"]';

export function sceneOpenSelector(id: string): string {
  return `[data-scene-open="${id.replace(/["\\]/g, '\\$&')}"]`;
}

function insideUserSelection(scope: Element): boolean {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  return (!!anchorNode && scope.contains(anchorNode)) || (!!focusNode && scope.contains(focusNode));
}

export function NeoWorkCard({
  work,
  driver,
  busy,
  disabled,
  onAction,
  onOpen,
  presentation = 'detail',
  questionSlot,
  waiting = false,
}: {
  work: NeoWork;
  driver?: NeoWorkDriverReceipt;
  busy: boolean;
  disabled: boolean;
  onAction: (id: string, action: 'start' | 'cancel') => void;
  onOpen?: (id: string) => void;
  presentation?: 'detail' | 'summary';
  questionSlot?: (id: string, node: HTMLElement | null, previous: HTMLElement | null) => void;
  waiting?: boolean;
}) {
  const attachQuestion = useMemo(() => {
    let previous: HTMLElement | null = null;
    return (node: HTMLElement | null) => {
      questionSlot?.(work.id, node, previous);
      previous = node;
    };
  }, [work.id, questionSlot]);
  const label =
    work.status === 'queued' && driver ? neoWorkDriverLabel(driver) : labels[work.status];
  const tone = neoWorkTone(work, driver, waiting);
  const icon = tone === 'success' ? 'check' : 'work';
  const driverLink = work.sessionId ? null : neoWorkDriverLink(driver);
  const appLogo = driver ? appLogos[driver.adapter] : undefined;
  const openLink = driverLink && (
    <a
      href={driverLink}
      class="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fill-soft hover:text-accent"
      aria-label={`Open ${work.title}`}
    >
      Open
      {appLogo ? (
        <span data-app-logo={appLogo} class="flex" style={{ color: providerLogoColor(appLogo) }}>
          <ProviderLogo provider={appLogo} class="h-3.5 w-3.5" />
        </span>
      ) : (
        <NeoIcon name="external" class="!h-3.5 !w-3.5" />
      )}
    </a>
  );
  if (presentation === 'summary' && onOpen)
    return (
      <div class="flex min-h-11 w-full items-center gap-2 rounded-xl border border-line bg-surface pr-2 hover:border-accent/40">
        <button
          type="button"
          data-scene-open={work.id}
          disabled={!work.sessionId}
          onClick={() => onOpen(work.id)}
          class="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left focus-visible:outline-accent disabled:cursor-default"
          aria-label={work.sessionId ? `Open chat for ${work.title}` : work.title}
        >
          <span
            aria-hidden="true"
            data-tone={tone}
            class={`shrink-0 rounded-lg p-1.5 ${tones[tone]}`}
          >
            <NeoIcon name={icon} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block break-words text-sm font-medium">{work.title}</span>
            <span class="mt-1 block text-xs text-fg-muted">{label}</span>
          </span>
          {work.sessionId && (
            <span aria-hidden="true" class="shrink-0 text-fg-faint">
              <NeoIcon name="external" />
            </span>
          )}
        </button>
        {openLink}
      </div>
    );
  const active = work.status === 'queued';
  const answering = active && waiting && !!work.sessionId && !!onOpen;
  const hasActions = work.status === 'proposed' || answering;
  const openable = !!onOpen && !!work.sessionId && !hasActions;
  return (
    <article
      aria-label={work.title}
      data-scene-open={openable ? work.id : undefined}
      tabIndex={openable ? 0 : undefined}
      class={`neo-arrive rounded-2xl border border-line bg-surface p-5 shadow-sm${
        openable ? ' cursor-pointer transition-colors hover:border-accent/40' : ''
      }`}
      onClick={
        openable
          ? (event) => {
              const target = event.target as Element | null;
              if (!target || target.closest?.(interactive)) return;
              if (insideUserSelection(event.currentTarget as Element)) return;
              onOpen!(work.id);
            }
          : undefined
      }
      onKeyDown={
        openable
          ? (event) => {
              if (event.key === 'Enter' && event.target === event.currentTarget) onOpen!(work.id);
            }
          : undefined
      }
    >
      <div class="mb-3 flex items-center gap-3">
        <span data-tone={tone} class={`rounded-xl p-2 ${tones[tone]}`}>
          <NeoIcon name={icon} />
        </span>
        <span class="text-xs font-medium text-fg-muted">
          {answering ? 'Waiting for your answer' : label}
        </span>
        {active && (
          <span
            aria-hidden="true"
            class="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse"
          />
        )}
        {openLink}
        {openable && (
          <span aria-hidden="true" class="ml-auto text-fg-faint">
            <NeoIcon name="external" />
          </span>
        )}
        {!openable && !answering && onOpen && work.sessionId && (
          <button
            type="button"
            onClick={() => onOpen(work.id)}
            class="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fill-soft hover:text-accent"
          >
            Open chat
            <NeoIcon name="external" class="!h-3.5 !w-3.5" />
          </button>
        )}
      </div>
      <h3 class="break-words text-base font-medium">{work.title}</h3>
      {work.status === 'proposed' && (
        <p class="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-fg-muted">
          {work.instruction}
        </p>
      )}
      {work.status === 'failed' && work.report && (
        <p class="mt-2 line-clamp-2 break-words text-sm text-fg-muted">{work.report}</p>
      )}
      {active &&
        work.sessionId &&
        (questionSlot ? (
          <div ref={attachQuestion} />
        ) : (
          <NeoWorkQuestion key={work.id} work={work} />
        ))}
      {hasActions && (
        <div class="mt-4 flex flex-wrap items-center justify-end gap-4">
          {work.status === 'proposed' && (
            <Button
              variant="ghost"
              disabled={disabled || busy}
              class="hover:!bg-danger/10 hover:!text-danger"
              onClick={() => onAction(work.id, 'cancel')}
            >
              {busy ? 'Declining…' : 'Decline'}
            </Button>
          )}
          {answering && (
            <Button icon={<NeoIcon name="external" />} onClick={() => onOpen!(work.id)}>
              Answer in chat
            </Button>
          )}
          {work.status === 'proposed' && (
            <Button
              disabled={disabled || busy}
              onClick={() => onAction(work.id, 'start')}
              icon={<NeoIcon name="arrow" />}
            >
              {busy ? 'Starting…' : 'Start work'}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
