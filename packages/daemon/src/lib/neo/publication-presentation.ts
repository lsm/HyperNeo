import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoQuestionSource } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';

export const presentNeoPublications = (superpipe({})('neo.publication.present') as PipelineAPI)
  .input(['items', 'read'])
  .pipe(
    (items: readonly NeoPublication[], read: (id: string) => Promise<NeoQuestionSource | null>) => {
      const sources = new Map<string, Promise<NeoQuestionSource | null>>();
      const source = (id: string) => {
        if (!sources.has(id)) sources.set(id, read(id));
        return sources.get(id)!;
      };
      return Promise.all(
        items.map(async (item) => ({
          ...item,
          ...(item.session ? { sessionSource: await source(item.session) } : {}),
          ...(item.revisions
            ? {
                revisions: await Promise.all(
                  item.revisions.map(async (revision) => ({
                    ...revision,
                    ...(revision.session ? { sessionSource: await source(revision.session) } : {}),
                  }))
                ),
              }
            : {}),
        }))
      );
    },
    ['items', 'read'],
    'items'
  )
  .endAsync('items') as (
  items: readonly NeoPublication[],
  read: (id: string) => Promise<NeoQuestionSource | null>
) => Promise<NeoPublication[]>;
