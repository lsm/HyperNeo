import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkInput } from '../drivers/types.ts';

type Receipt = { inputId: string; dispatchId: string };
type Turn = { at: number; startedAt?: number };
type Origin = { humanInput?: string; dispatchId?: string };

export const neoTurnOrigin = (superpipe({})('neo.turn-origin') as PipelineAPI)
  .input(['inputs', 'turn', 'previousAt', 'receipts'])
  .pipe(
    (inputs: readonly WorkInput[], turn: Turn, previousAt: number) => {
      const candidates = inputs.filter((input) => input.at > previousAt && input.at <= turn.at);
      return turn.startedAt === undefined
        ? candidates.at(-1)
        : (candidates.findLast((input) => input.at <= turn.startedAt!) ?? candidates[0]);
    },
    ['inputs', 'turn', 'previousAt'],
    'input'
  )
  .pipe(
    (input: WorkInput | undefined, receipts: readonly Receipt[]): Origin => {
      if (!input) return {};
      const receipt =
        input.inputId && receipts.find((receipt) => receipt.inputId === input.inputId);
      if (receipt) return { dispatchId: receipt.dispatchId };
      return input.human !== false && (input.inputId !== undefined || input.human === true)
        ? { humanInput: input.text.replace(/\s+/g, ' ').trim().slice(0, 160) }
        : {};
    },
    ['input', 'receipts'],
    'origin'
  )
  .end('origin') as (
  inputs: readonly WorkInput[],
  turn: Turn,
  previousAt: number,
  receipts: readonly Receipt[]
) => Origin;
