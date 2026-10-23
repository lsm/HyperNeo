import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { OperationCaller } from '../operations/registry.ts';

export function requireNeoTreeAuthor(
  caller: OperationCaller,
  binding: NeoBinding | null
): { value: true } | { reason: { ok: false; reason: string } } {
  return (caller.source === 'rpc' && caller.principal === 'local') ||
    (caller.source === 'mcp' && binding?.kind === 'neo')
    ? { value: true }
    : { reason: { ok: false, reason: 'root_or_human_only' } };
}
