import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingAssignmentsRepository } from './assignments.ts';
import * as delivery from './delivery-facts.ts';
import type { CodingSmokeRequest } from './smoke-operation.ts';
import { requireCodingSmokeAssignment } from './smoke-assignment.ts';
import type { NeoDeployRead } from './deploy-checks.ts';

class CodingSmokeCommands {
  constructor(private readonly db: Database) {}

  check(input: CodingSmokeRequest) {
    return requireCodingSmokeAssignment(
      input,
      new CodingAssignmentsRepository(this.db),
      new delivery.CodingDeliveryFactsRepository(this.db)
    );
  }

  assignedRecord(input: CodingSmokeRequest, deploys: NeoDeployRead) {
    const checked = this.check(input);
    return 'reason' in checked
      ? checked.reason
      : this.record(input.todoId, input.url, input.head, input.smoke, deploys);
  }

  record(
    todoId: string,
    url: string,
    head: string,
    smoke: delivery.CodingSmoke,
    deploys: NeoDeployRead
  ) {
    return delivery.admitCodingSmoke(
      new delivery.CodingDeliveryFactsRepository(this.db),
      todoId,
      url,
      head,
      smoke,
      deploys
    );
  }
}

export const codingSmokeReads = defineRepositoryOp(
  'coding.smoke.reads',
  'read',
  CodingSmokeCommands,
  ['check']
);
export const codingSmokeWrites = defineRepositoryOp(
  'coding.smoke.commands',
  'write',
  CodingSmokeCommands,
  ['assignedRecord', 'record']
);
