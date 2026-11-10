import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../operations/registry.ts';
import { SESSION_DOOR_PRINCIPAL } from '../pairing/pairing-operations.ts';

type RestartFacts = { neo: string; streams: boolean; speech: boolean };
type Reservation = { ok: true; pid: number; expiresAt: number } | { ok: false; reason: string };

export function planRestartReservation(facts: RestartFacts): { value: true } | { reason: string } {
  if (facts.neo === 'unavailable') return { reason: 'unavailable' };
  if (facts.neo !== 'idle') return { reason: 'neo_busy' };
  if (facts.streams || facts.speech) return { reason: 'voice_busy' };
  return { value: true };
}

export class RestartReservation {
  private expiresAt = 0;

  remaining(now = Date.now()): number {
    return Math.max(0, this.expiresAt - now);
  }

  reserve(read: () => RestartFacts, now = Date.now()): Reservation {
    if (this.remaining(now)) return { ok: false, reason: 'updating' };
    try {
      const plan = planRestartReservation(read());
      if ('reason' in plan) return { ok: false, reason: plan.reason };
      this.expiresAt = now + 15_000;
      return { ok: true, pid: process.pid, expiresAt: this.expiresAt };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }
}

export const restartReservation = new RestartReservation();

export function createRestartReservationOperation(
  read: () => RestartFacts,
  reservation = restartReservation
) {
  const reserve = (superpipe({})('system.restart.reserve') as PipelineAPI)
    .input(['read'])
    .pipe((read: () => RestartFacts) => reservation.reserve(read), 'read', 'reservation')
    .end('reservation') as (read: () => RestartFacts) => Reservation;
  return defineOperation({
    name: 'system.restart.reserve',
    description:
      'Reserve an idle daemon restart for 15 seconds through the paired local session socket. Busy or unavailable state defers the restart.',
    inputSchema: z.strictObject({}),
    resultSchema: z.union([
      z.object({
        ok: z.literal(true),
        pid: z.number().int().positive(),
        expiresAt: z.number().int(),
      }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ]),
    policy: { safetyClass: 'human_only' },
    execute: async (_input, caller) =>
      caller.source === 'mcp' &&
      caller.principal === SESSION_DOOR_PRINCIPAL &&
      caller.device?.kind === 'human'
        ? reserve(read)
        : { ok: false as const, reason: 'local_session_socket_required' },
  });
}
