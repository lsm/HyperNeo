import type { NeoConversationWake } from '@hyperneo/shared/types/neo-wake';
import { NativeContentDisclosure } from '../components/ui/NativeContentDisclosure.tsx';
import { t } from '../lib/i18n/index.ts';
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
  return (
    <NativeContentDisclosure
      data-public-entry={entryKey}
      data-wake={wake.scheduleId}
      label={t('chat.wakeLabel', { title: wake.title })}
      class="neo-arrive mx-auto max-w-[94%] text-xs text-fg-muted"
      summary={
        <span class="inline-flex max-w-full flex-wrap items-center gap-2">
          <NeoIcon name="clock" class="!h-3.5 !w-3.5" />
          <span class="max-w-40 truncate font-medium text-fg">{wake.title}</span>
          <span class="min-w-0 flex-1 truncate">
            {wake.settledAt === null ? t('chat.wakeRunning') : t('chat.wakeFinished')}
          </span>
        </span>
      }
    >
      <div class="space-y-3 px-3 pb-2 pt-1">
        {wake.summary && <p class="whitespace-pre-wrap break-words">{wake.summary}</p>}
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
      </div>
    </NativeContentDisclosure>
  );
}
