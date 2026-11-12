import { attribute, escapeSessionText } from '../messaging/session-envelope.ts';

export const FRONT_FALLBACK_TEXT = 'This reply could not be completed. Please try again.';

const LIMIT = 4096;
const CUT = '… (shown in full to the human)';

export function cutForFront(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= LIMIT) return text;
  const room = LIMIT - new TextEncoder().encode(CUT).length;
  return `${new TextDecoder().decode(bytes.slice(0, room)).replace(/\uFFFD+$/, '')}${CUT}`;
}

export function catchUpBlock(
  said: readonly { replyTo?: readonly string[]; fullText: string }[]
): string | null {
  if (!said.length) return null;
  return `<already-said>\n${said
    .map(
      (row) =>
        `<said replyTo="${attribute((row.replyTo ?? []).join(','))}">${escapeSessionText(cutForFront(row.fullText))}</said>`
    )
    .join('\n')}\n</already-said>`;
}
