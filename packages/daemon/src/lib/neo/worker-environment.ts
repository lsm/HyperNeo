import { fillPrompt, NEO_WORK_ENVIRONMENT_MOVE } from '@hyperneo/prompts';
import type { NeoDriverTarget } from './driver-work.ts';

const WORKER_ENVIRONMENT_FAILURES: readonly RegExp[] = [
  /\b(?:can(?:no|')t|could not|unable to|failed to) resolve [\w.-]+/i,
  /\bname resolution\b[^.\n]{0,40}\bfail/i,
  /\b(?:no|without) (?:network|internet)(?: access)?\b/i,
  /\bnetwork is unreachable\b/i,
  /\bno usable (?:token|credentials?)\b/i,
  /\bunavailable [\w-]+ (?:authentication|credentials?)\b/i,
  /\b(?:authentication|credentials?|token) (?:is |are )?(?:unavailable|missing)\b/i,
  /\bnot (?:logged in|authenticated)\b/i,
];

export function classifyNeoWorkerEnvironmentFailure(
  report: string | null | undefined
): string | null {
  if (!report) return null;
  for (const pattern of WORKER_ENVIRONMENT_FAILURES) {
    const found = report.match(pattern);
    if (found) return found[0];
  }
  return null;
}

export type NeoEnvironmentMove = { failure: string; adapters: string[] };

export function planNeoEnvironmentMove(
  failure: string | null,
  target: NeoDriverTarget | null,
  adapters: readonly { id: string; capabilities: readonly string[] }[] | null
): { value: NeoEnvironmentMove } | { reason: null } {
  if (!failure || target?.verb !== 'start' || !adapters) return { reason: null };
  const place = target.place;
  const others = adapters
    .filter(
      (adapter) =>
        adapter.id !== target.adapter &&
        adapter.capabilities.includes('start') &&
        (adapter.id === 'space') === !!place.spaceId
    )
    .map((adapter) => adapter.id);
  return others.length ? { value: { failure, adapters: others } } : { reason: null };
}

export function neoEnvironmentMoveNote(move: NeoEnvironmentMove | null): string {
  return move
    ? `\n${fillPrompt(NEO_WORK_ENVIRONMENT_MOVE, { failure: move.failure, adapters: move.adapters.join(', ') })}`
    : '';
}
