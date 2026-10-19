import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoReceiptAskOrigin } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAskOrigin } from './ask-origin.ts';

type Input = {
  kind: NeoReceiptAskOrigin['kind'];
  id: string;
  input: { sessionId: string; messageId: string | null };
};
type Resolver = (input: Input['input']) => NeoAskOrigin | null;

export function selectNeoSnapshotOriginInputs(work: readonly NeoWork[]): Input[] {
  return work.map((item) => ({
    kind: 'work' as const,
    id: item.id,
    input: { sessionId: item.originSessionId, messageId: item.originMessageId },
  }));
}

export function readNeoSnapshotAskOrigins(
  receipts: readonly Input[],
  resolve: Resolver
): NeoReceiptAskOrigin[] {
  return receipts.map(({ kind, id, input }) => {
    const origin = input.messageId === null ? null : resolve(input);
    return { kind, id, origin: origin ? { ...origin } : null };
  });
}

export const projectNeoSnapshotAskOrigins = (
  superpipe({})('neo-snapshot-ask-origins') as PipelineAPI
)
  .input(['work', 'resolve'])
  .pipe(selectNeoSnapshotOriginInputs, 'work', 'receipts')
  .pipe(readNeoSnapshotAskOrigins, ['receipts', 'resolve'], 'origins')
  .end('origins') as (work: readonly NeoWork[], resolve: Resolver) => NeoReceiptAskOrigin[];
