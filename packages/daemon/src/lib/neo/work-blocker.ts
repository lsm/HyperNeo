import { fillPrompt, NEO_WORK_ENVIRONMENT_MOVE } from '@hyperneo/prompts';
import { z } from 'zod';
import type { NeoDriverTarget } from './driver-work.ts';

export const NeoWorkBlockerSchema = z.object({
  kind: z.enum(['environment', 'needs_human']),
  what: z.string().trim().min(1).max(500),
});
export type NeoWorkBlocker = z.infer<typeof NeoWorkBlockerSchema>;

const BLOCKER_LINE = /^(?:Agent: )?Blocked \((environment|needs_human)\): *(\S.*)$/;

export function neoWorkBlockerLine(blocker: NeoWorkBlocker): string {
  return `Blocked (${blocker.kind}): ${blocker.what.replace(/\s+/g, ' ').trim()}`;
}

export function readNeoWorkBlocker(report: string | null | undefined): NeoWorkBlocker | null {
  const last = (report ?? '').trimEnd().split('\n').at(-1)?.trim() ?? '';
  const found = last.match(BLOCKER_LINE);
  return found ? { kind: found[1] as NeoWorkBlocker['kind'], what: found[2].trim() } : null;
}

export type NeoEnvironmentMove = { failure: string; adapters: string[] };

export function planNeoEnvironmentMove(
  blocker: NeoWorkBlocker | null,
  target: NeoDriverTarget | null,
  adapters: readonly { id: string; capabilities: readonly string[] }[] | null
): { value: NeoEnvironmentMove } | { reason: null } {
  if (blocker?.kind !== 'environment' || target?.verb !== 'start' || !adapters)
    return { reason: null };
  const place = target.place;
  const others = adapters
    .filter(
      (adapter) =>
        adapter.id !== target.adapter &&
        adapter.capabilities.includes('start') &&
        (adapter.id === 'space') === !!place.spaceId
    )
    .map((adapter) => adapter.id);
  return others.length ? { value: { failure: blocker.what, adapters: others } } : { reason: null };
}

export function neoEnvironmentMoveNote(move: NeoEnvironmentMove | null): string {
  return move
    ? `\n${fillPrompt(NEO_WORK_ENVIRONMENT_MOVE, { failure: move.failure, adapters: move.adapters.join(', ') })}`
    : '';
}
