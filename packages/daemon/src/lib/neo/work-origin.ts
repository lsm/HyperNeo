import type { OperationCaller } from '../operations/registry.ts';

export function neoTurnOrigin(turn: NonNullable<OperationCaller['neoTurn']>): string {
  return turn.origin ?? turn.messageId;
}

export function hasNeoHumanWorkInput(
  caller: OperationCaller,
  prompts: readonly { type: string; inputKind?: unknown }[]
): boolean {
  return (
    caller.source === 'mcp' &&
    !!caller.neoTurn?.human &&
    prompts.some((message) => message.type === 'user' && message.inputKind === 'human')
  );
}
