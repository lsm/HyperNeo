import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { messageTime } from './NeoMessage.tsx';

export function NeoPublicationHistory({
  publication,
  id,
}: {
  publication: NeoPublication;
  id: string;
}) {
  const versions = [
    ...(publication.revisions ?? []),
    {
      revisionId: publication.revisionId ?? publication.publicationId,
      shortText: publication.shortText,
      fullText: publication.fullText,
      createdAt: publication.editedAt ?? publication.createdAt,
    },
  ];
  return (
    <section id={id} aria-label="Revision history" class="mt-3 rounded-xl bg-fill-soft p-3">
      <h3 class="mb-3 text-xs font-medium text-fg-muted">Revision history</h3>
      <ol class="space-y-4">
        {versions.map((version, index) => {
          const time = messageTime(version.createdAt);
          return (
            <li key={version.revisionId}>
              <div class="mb-1 flex flex-wrap items-baseline gap-2 text-[11px] text-fg-faint">
                <span>
                  {index === versions.length - 1 ? 'Current' : index === 0 ? 'Original' : 'Revised'}
                </span>
                {time && (
                  <time dateTime={time.iso} title={time.full}>
                    {time.label}
                  </time>
                )}
              </div>
              <MarkdownRenderer
                content={version.fullText || version.shortText || ''}
                class="neo-markdown neo-markdown-assistant text-sm leading-relaxed"
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
