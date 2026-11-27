import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkStatus } from '../drivers/types.ts';

export type NeoTurnReportFacts = {
  priorStatus: WorkStatus | null;
  state: NeoTodo['state'];
  blockedBy: NeoTodo['blockedBy'];
  questionOpen: boolean;
};

export function isSilentNeoTurn(message: string): boolean {
  return message.trim() === 'No response requested.';
}

export function skipEmptyNeoTurnReport(
  turn: { message: string; humanInput?: string },
  live: { status: string; waitingFor?: string; turnQuestion?: unknown } | null,
  facts: NeoTurnReportFacts | undefined
): boolean {
  return (
    turn.humanInput === undefined &&
    (isSilentNeoTurn(turn.message) ||
      (turn.message.trim() === '' && facts?.priorStatus === 'done')) &&
    live?.status === 'done' &&
    !live.waitingFor &&
    !live.turnQuestion &&
    facts?.state === 'doing' &&
    facts.blockedBy === null &&
    !facts.questionOpen
  );
}
