import { THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  filterModelsBySearch,
  groupModelsByProvider,
  getProviderLabel,
} from '../hooks/useModelSwitcher.ts';
import { ProviderLogo } from '../components/ProviderLogo.tsx';
import { NeoIcon } from './NeoIcon.tsx';

export function NeoModelMenu({
  id = 'neo-preferences',
  models,
  current,
  level,
  options,
  busy,
  loading,
  working,
  scope = { idle: 'For this conversation', working: 'Available after this reply' },
  onModel,
  onThinking,
  onClose,
  onReload,
  align = 'left',
}: {
  id?: string;
  models: ModelInfo[];
  current?: ModelInfo;
  level: ThinkingLevel;
  options: { value: ThinkingLevel; label: string }[];
  busy: boolean;
  loading: boolean;
  working: boolean;
  scope?: { idle: string; working: string };
  onModel: (model: ModelInfo) => void;
  onThinking: (level: ThinkingLevel) => void;
  onClose: () => void;
  onReload?: () => void;
  align?: 'left' | 'right';
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    search.current?.focus();
  }, []);
  const visible = filterModelsBySearch(models, query);
  const groups = groupModelsByProvider(visible);
  return (
    <div
      id={id}
      role="group"
      aria-label="Model and thinking settings"
      class={`neo-arrive absolute bottom-full ${align === 'right' ? 'right-0' : '-left-10 sm:left-0'} z-30 mb-3 flex w-[360px] max-w-[calc(100vw-64px)] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-raised shadow-xl`}
      style={{ maxHeight: 'min(580px, calc(100dvh - var(--neo-composer-height, 190px) - 90px))' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div class="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
        <h2 class="text-sm font-medium">Model & thinking</h2>
        <button
          type="button"
          aria-label="Close model settings"
          class="rounded-lg p-1.5 text-fg-muted hover:bg-fill-soft"
          onClick={onClose}
        >
          <NeoIcon name="close" class="!h-4 !w-4" />
        </button>
      </div>
      <div class="relative mx-3 mb-2 shrink-0">
        <NeoIcon
          name="search"
          class="pointer-events-none absolute left-3 top-2.5 !h-4 !w-4 text-fg-faint"
        />
        <input
          ref={search}
          type="search"
          aria-label="Search models"
          placeholder="Find a model or provider…"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
            }
          }}
          class="w-full rounded-xl border border-line bg-surface py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
        />
      </div>
      <div
        ref={list}
        role="group"
        aria-label="Models"
        class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-2 pb-3"
        style={{ maxHeight: '380px' }}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = [
            ...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
          ];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : index + (event.key === 'ArrowDown' ? 1 : -1);
          if (next < 0) search.current?.focus();
          else buttons[Math.min(next, buttons.length - 1)]?.focus();
        }}
      >
        {[...groups].map(([provider, entries]) => (
          <section key={provider} aria-label={getProviderLabel(provider)}>
            <h3 class="flex items-center gap-2 px-3 pb-1 pt-2 text-[11px] font-medium text-fg-faint">
              <ProviderLogo provider={provider} class="h-3.5 w-3.5" />
              {getProviderLabel(provider)}
            </h3>
            {entries.map((item) => {
              const selected = item.id === current?.id && item.provider === current.provider;
              return (
                <button
                  key={`${provider}:${item.id}`}
                  type="button"
                  aria-label={`${item.name} · ${getProviderLabel(provider)}`}
                  aria-pressed={selected}
                  disabled={busy || item.available === false}
                  title={item.available === false ? 'Not runnable on this account' : undefined}
                  onClick={() => onModel(item)}
                  class={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-accent disabled:opacity-50 ${selected ? 'bg-accent/10 text-accent' : 'text-fg-soft hover:bg-fill-soft'}`}
                >
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium">{item.name}</span>
                  </span>
                  {selected && <NeoIcon name="check" class="!h-4 !w-4" />}
                </button>
              );
            })}
          </section>
        ))}
        {!visible.length && (
          <p role="status" class="px-3 py-6 text-center text-sm text-fg-muted">
            {loading
              ? 'Loading models…'
              : query
                ? 'No matching models. Try another name.'
                : 'No models available.'}
          </p>
        )}
        {!loading && !models.length && onReload && (
          <button type="button" onClick={onReload} class="w-full p-2 text-sm text-accent">
            Retry loading models
          </button>
        )}
      </div>
      <div class="shrink-0 border-t border-line bg-surface/40 p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-medium text-fg-muted">Thinking</span>
          <span class="text-[10px] text-fg-faint">{working ? scope.working : scope.idle}</span>
        </div>
        {options.length > 4 ? (
          <ThinkingSlider level={level} options={options} busy={busy} onThinking={onThinking} />
        ) : options.length ? (
          <div role="group" aria-label="Thinking" class="flex gap-1 rounded-xl bg-surface p-1">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={level === option.value}
                disabled={busy}
                title={option.label}
                onClick={() => onThinking(option.value)}
                class={`min-w-0 flex-1 rounded-lg py-1.5 text-xs transition-colors focus-visible:outline-accent disabled:opacity-50 ${level === option.value ? 'bg-accent/15 font-medium text-accent' : 'text-fg-muted hover:bg-fill-soft'}`}
              >
                {option.label.replace('Think ', '')}
              </button>
            ))}
          </div>
        ) : (
          <p class="text-xs text-fg-faint">Not available for this model</p>
        )}
      </div>
    </div>
  );
}

function nearestOptionIndex(level: ThinkingLevel, options: { value: ThinkingLevel }[]): number {
  const rank = THINKING_LEVELS.indexOf(level);
  let best = 0;
  options.forEach((option, index) => {
    const distance = Math.abs(THINKING_LEVELS.indexOf(option.value) - rank);
    if (distance < Math.abs(THINKING_LEVELS.indexOf(options[best].value) - rank)) best = index;
  });
  return best;
}

function ThinkingSlider({
  level,
  options,
  busy,
  onThinking,
}: {
  level: ThinkingLevel;
  options: { value: ThinkingLevel; label: string }[];
  busy: boolean;
  onThinking: (level: ThinkingLevel) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const selected = nearestOptionIndex(level, options);
  const shown = preview ?? selected;
  const pick = (index: number) => {
    setPreview(null);
    if (options[index] && options[index].value !== level) onThinking(options[index].value);
  };
  return (
    <div class="flex items-center gap-3 rounded-xl bg-surface px-3 py-2">
      <div class="relative min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={options.length - 1}
          step={1}
          value={shown}
          disabled={busy}
          aria-label="Thinking"
          aria-valuetext={options[shown].label}
          onInput={(event) => setPreview(Number((event.target as HTMLInputElement).value))}
          onChange={(event) => pick(Number((event.target as HTMLInputElement).value))}
          class="w-full accent-accent disabled:opacity-50"
        />
        <div aria-hidden="true" class="mt-0.5 flex justify-between px-[7px]">
          {options.map((option, index) => (
            <span
              key={option.value}
              title={option.label}
              class={`h-1 w-1 rounded-full ${index <= shown ? 'bg-accent' : 'bg-line-strong'}`}
            />
          ))}
        </div>
      </div>
      <span
        class="w-[4.5rem] shrink-0 text-right text-xs font-medium text-accent"
        data-testid="thinking-slider-label"
      >
        {options[shown].label}
      </span>
    </div>
  );
}
