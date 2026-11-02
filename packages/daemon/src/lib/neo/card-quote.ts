import { neoReplyExcerpt, type NeoReplyTo } from '@hyperneo/shared/types/neo-ask';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';

export function snapshotNeoCardQuote(ref: NeoReplyTo, text: string | undefined): NeoReplyTo {
  const excerpt = neoReplyExcerpt(text ?? '');
  return excerpt ? { ...ref, author: 'neo', excerpt } : ref;
}

export async function presentNeoCardQuotes(
  items: readonly NeoConversationAsk[],
  database: Database
): Promise<NeoConversationAsk[]> {
  const store = new NeoAskTodoRepository(database);
  return Promise.all(
    items.map(async (item) => {
      const ref = item.replyTo;
      if (!ref || ref.kind === 'message' || (ref.author && ref.excerpt)) return item;
      const text =
        ref.kind === 'question'
          ? (await store.read('getQuestion', ref.id))?.text
          : ref.kind === 'todo'
            ? (await store.read('getTodo', ref.id))?.title
            : (await store.read('getAsk', ref.id))?.title;
      return { ...item, replyTo: snapshotNeoCardQuote(ref, text) };
    })
  );
}
