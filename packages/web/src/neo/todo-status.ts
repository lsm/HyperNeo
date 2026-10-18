import type { NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import { isMessageKey, t } from '../lib/i18n/index.ts';

export function neoTodoStatus(todo: Pick<NeoTodoEntry, 'status' | 'statusCodes'>): string {
  const codes = todo.statusCodes ?? [];
  if (!codes.length || !codes.every(({ code }) => isMessageKey(code))) return todo.status;
  return codes
    .map(({ code, params }) => t(code as Parameters<typeof t>[0], params))
    .join(t('status.separator'));
}
