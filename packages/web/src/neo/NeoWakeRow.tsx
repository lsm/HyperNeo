import type { NeoConversationWake } from '@hyperneo/shared/types/neo-wake';
import { locale, t } from '../lib/i18n/index.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { neoMessageAnchor } from './reply-context.ts';

export function NeoWakeRow({
  entryKey,
  wake,
  conversationId,
  onOpenWork,
}: {
  entryKey: string;
  wake: NeoConversationWake;
  conversationId: string;
  onOpenWork?: (anchor: string) => void;
}) {
  const fired = new Date(wake.firedAt);
  const running = wake.settledAt === null;
  const hasDetails = !!wake.summary || wake.additions.length > 0;
  const rowClass = 'rounded-xl border border-line bg-surface text-xs text-fg-muted';
  const heading = (
    <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <NeoIcon
        name={running ? 'progress' : 'clock'}
        class={
          running
            ? '!h-3.5 !w-3.5 motion-safe:animate-spin text-[var(--neo-teal)]'
            : '!h-3.5 !w-3.5'
        }
      />
      <span class="break-words font-medium text-fg">{wake.title}</span>
      <time dateTime={fired.toISOString()}>
        {fired.toLocaleString(locale.value, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </time>
      <span>{t(running ? 'chat.wakeRunning' : 'chat.wakeFinished')}</span>
    </span>
  );
  if (!hasDetails)
    return (
      <div
        data-public-entry={entryKey}
        data-wake={wake.scheduleId}
        data-wake-summary
        class={`${rowClass} px-3 py-2.5`}
      >
        {heading}
      </div>
    );
  return (
    <details data-public-entry={entryKey} data-wake={wake.scheduleId} class={`group ${rowClass}`}>
      <summary
        data-wake-summary
        aria-label={t('chat.wakeLabel', { title: wake.title })}
        class="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3 py-2 hover:bg-fill-soft [&::-webkit-details-marker]:hidden"
      >
        {heading}
        <NeoIcon name="chevron" class="!h-4 !w-4 rotate-180 group-open:rotate-0" />
      </summary>
      <div class="space-y-3 px-3 pb-2 pt-1">
        {wake.summary && <p class="whitespace-pre-wrap break-words">{wake.summary}</p>}
        {wake.additions.length > 0 && (
          <ul class="space-y-1 break-words">
            {wake.additions.map((item) => {
              const anchor =
                item.kind === 'journal'
                  ? null
                  : item.kind === 'publication'
                    ? neoMessageAnchor(conversationId, `publication-${item.id}`)
                    : `neo-ref-${item.kind}-${item.id}`;
              return (
                <li key={`${item.kind}:${item.id}`}>
                  {anchor ? (
                    <a
                      href={`#${anchor}`}
                      class="text-accent hover:underline"
                      onClick={(event) => {
                        if (item.kind !== 'publication' && onOpenWork) {
                          event.preventDefault();
                          onOpenWork(anchor);
                        }
                      }}
                    >
                      {item.label}
                    </a>
                  ) : (
                    item.label
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
