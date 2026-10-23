import type { NeoQuestionEntry, NeoStatusCode, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import { isMessageKey, t } from '../lib/i18n/index.ts';

function neoCodedText(text: string, codes: readonly NeoStatusCode[] = []): string {
  if (!codes.length || !codes.every(({ code }) => isMessageKey(code))) return text;
  return codes
    .map(({ code, params }) => t(code as Parameters<typeof t>[0], params))
    .join(t('status.separator'));
}

export function neoTodoStatus(todo: Pick<NeoTodoEntry, 'status' | 'statusCodes'>): string {
  return neoCodedText(todo.status, todo.statusCodes);
}

export function neoQuestionText(question: Pick<NeoQuestionEntry, 'text' | 'textCodes'>): string {
  return neoCodedText(question.text, question.textCodes);
}

export function neoTodoHasMore(todo: NeoTodoEntry): boolean {
  return (
    neoTodoDetail(todo).length > 0 ||
    (todo.artifacts?.length ?? 0) > 0 ||
    (todo.state === 'blocked' && !!todo.nextAction)
  );
}

export function neoTodoDetail(todo: NeoTodoEntry): string[] {
  const status = neoTodoStatus(todo).trim();
  return [
    ...new Set(
      [todo.report, todo.evidence]
        .map((text) => text?.trim())
        .filter((text): text is string => !!text && text !== status)
    ),
  ];
}
