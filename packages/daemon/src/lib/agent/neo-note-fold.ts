import type { MessageContent } from '@hyperneo/shared';

export const NEO_NOTE_FOLD_LIMIT = 10;
export const NEO_NOTE_FOLD_SEPARATOR = '\n\n---\n\n';

export interface NeoNoteFoldCandidate {
  uuid: string;
  content: string | MessageContent[];
  system: boolean;
  key: string | null;
}

export function planNeoNoteFold(
  head: NeoNoteFoldCandidate,
  pending: readonly NeoNoteFoldCandidate[]
): { content: string | MessageContent[]; uuids: string[] } {
  if (!head.system || typeof head.content !== 'string')
    return { content: head.content, uuids: [head.uuid] };
  const folded = pending
    .filter(
      (note) =>
        note.uuid !== head.uuid &&
        note.system &&
        typeof note.content === 'string' &&
        note.key === head.key
    )
    .slice(0, NEO_NOTE_FOLD_LIMIT - 1);
  return {
    content: [head.content, ...folded.map((note) => note.content as string)].join(
      NEO_NOTE_FOLD_SEPARATOR
    ),
    uuids: [head.uuid, ...folded.map((note) => note.uuid)],
  };
}
