import type { WorkChatMatch } from '../../storage/work-chat-search.ts';

export function matchChatsBy(
  chats: readonly WorkChatMatch[],
  keyOf: (chat: WorkChatMatch) => string | null | undefined
): ReadonlyMap<string, WorkChatMatch> {
  return new Map(
    chats.flatMap((chat) => {
      const key = keyOf(chat);
      return key ? [[key, chat] as const] : [];
    })
  );
}
