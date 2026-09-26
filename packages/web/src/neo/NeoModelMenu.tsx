import type { ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  filterModelsBySearch,
  groupModelsByProvider,
  getProviderLabel,
} from '../hooks/useModelSwitcher.ts';
import { ProviderLogo } from '../components/ProviderLogo.tsx';
import { NeoIcon } from './NeoIcon.tsx';

export function NeoModelMenu({
  models,
  current,
  level,
  options,
  busy,
  loading,
  working,
  onModel,
  onThinking,
  onClose,
  onReload,
}: {
  models: ModelInfo[];
  current?: ModelInfo;
  level: ThinkingLevel;
  options: { value: ThinkingLevel; label: string }[];
  busy: boolean;
  loading: boolean;
  working: boolean;
  onModel: (model: ModelInfo) => void;
  onThinking: (level: ThinkingLevel) => void;
  onClose: () => void;
  onReload: () => void;
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
      id="neo-preferences"
      role="group"
      aria-label="Model and thinking settings"
      class="neo-arrive absolute bottom-full -left-10 sm:left-0 z-30 mb-3 flex w-[360px] max-w-[calc(100vw-64px)] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-raised shadow-xl"
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
                  disabled={busy}
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
        {!loading && !models.length && (
          <button type="button" onClick={onReload} class="w-full p-2 text-sm text-accent">
            Retry loading models
          </button>
        )}
      </div>
      <div class="shrink-0 border-t border-line bg-surface/40 p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-medium text-fg-muted">Thinking</span>
          <span class="text-[10px] text-fg-faint">
            {working ? 'Available after this reply' : 'For this conversation'}
          </span>
        </div>
        {options.length ? (
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
