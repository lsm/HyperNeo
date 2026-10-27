import { isDeepStrictEqual } from 'node:util';
import type { CodingSmokeRequest } from './smoke-operation.ts';
import type { CodingAssignmentsRepository } from './assignments.ts';
import type { CodingDeliveryFactsRepository } from './delivery-facts.ts';

export function requireCodingSmokeAssignment(
  input: CodingSmokeRequest,
  assignments: CodingAssignmentsRepository,
  repo: CodingDeliveryFactsRepository
): { value: true } | { reason: { accepted: false; reason: string } } {
  const assignment = assignments.read(input.todoId, input.url, input.head).qa;
  const gate = repo.read(input.todoId, input.url, input.head)?.gate;
  return assignment &&
    isDeepStrictEqual(assignment.actor, input.smoke.actor) &&
    isDeepStrictEqual(assignment.ref, input.smoke.ref) &&
    (!gate ||
      (gate.acceptanceContract === assignment.acceptanceContract &&
        isDeepStrictEqual(gate.write, assignment.write)))
    ? { value: true }
    : { reason: { accepted: false, reason: 'stage_assignment_mismatch' } };
}
