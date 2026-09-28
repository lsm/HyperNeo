import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { DaemonInventoryLink } from '@hyperneo/shared/types/daemon-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  canonicalNeoWorkResourceRefs,
  decodeNeoWorkResourceRefs,
  selectNeoWorkResourceRefs,
} from '../../lib/neo/work-resource-refs.ts';
import {
  admitNeoWorkReportInput,
  requireSettledNeoWorkReport,
  type NeoWorkReportInput,
} from '../../lib/neo/work-report.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';

type Plan = { expected: NeoWork; input: NeoWorkReportInput; refs: DaemonInventoryLink[] };

function selectReport(input: NeoWorkReportInput) {
  const result = admitNeoWorkReportInput(input);
  return 'value' in result ? result : { reason: null };
}

function requireQueuedRecipient(expected: NeoWork, input: NeoWorkReportInput) {
  return expected.id === input.id && expected.status === 'queued' && expected.sessionId?.trim()
    ? { value: expected }
    : { reason: null };
}

const admit = (superpipe({})('neo-work-resource-settlement') as PipelineAPI)
  .input(['expected', 'input', 'resourceRefs'])
  .pipe(selectReport, 'input', 'result:plan')
  .pipe((input: NeoWorkReportInput) => input, 'plan', 'input')
  .pipe(requireQueuedRecipient, ['expected', 'input'], 'result:plan')
  .pipe(selectNeoWorkResourceRefs, 'resourceRefs', 'result:plan')
  .pipe(canonicalNeoWorkResourceRefs, 'plan', 'refs')
  .pipe(
    (expected: NeoWork, input: NeoWorkReportInput, refs: DaemonInventoryLink[]): Plan => ({
      expected,
      input,
      refs,
    }),
    ['expected', 'input', 'refs'],
    'plan'
  )
  .end('plan') as (
  expected: NeoWork,
  input: NeoWorkReportInput,
  resourceRefs: unknown
) => Plan | null;

class SettlementConflict extends Error {}

export class NeoWorkResourceRepository {
  constructor(
    private readonly db: Database,
    private readonly notify: () => void = () => {}
  ) {}

  get(workId: string): DaemonInventoryLink[] | null {
    const row = this.db
      .prepare('SELECT refs_json AS refsJson FROM neo_work_resources WHERE work_id = ?')
      .get(workId) as { refsJson: string } | null;
    return row ? decodeNeoWorkResourceRefs(row.refsJson) : null;
  }

  settle(expected: NeoWork, input: NeoWorkReportInput, resourceRefs: unknown): NeoWork | null {
    const plan = admit(expected, input, resourceRefs);
    if (!plan) return null;
    let settled: NeoWork | null;
    try {
      settled = this.db.transaction(() => {
        const reserved = this.db
          .prepare(`INSERT INTO neo_work_resources(work_id, refs_json)
            SELECT id, ? FROM neo_work WHERE id = ? AND status = 'queued'
              AND session_id IS ? AND origin_session_id = ? AND origin_message_id IS ?
              AND concern_id IS ? AND target_session_id IS ? AND report IS ?
            ON CONFLICT(work_id) DO NOTHING RETURNING work_id`)
          .get(
            JSON.stringify(plan.refs),
            expected.id,
            expected.sessionId,
            expected.originSessionId,
            expected.originMessageId,
            expected.concernId,
            expected.targetSessionId,
            expected.report
          );
        if (!reserved) return null;
        const work = new NeoRepository(this.db).transitionWork(expected.id, expected, {
          status: plan.input.status,
          report: plan.input.report,
        });
        if (
          'reason' in requireSettledNeoWorkReport(expected, plan.input, { work }) ||
          work?.concernId !== expected.concernId ||
          work?.targetSessionId !== expected.targetSessionId
        )
          throw new SettlementConflict();
        return work;
      })();
    } catch (error) {
      if (error instanceof SettlementConflict) return null;
      throw error;
    }
    if (settled) this.notify();
    return settled;
  }
}
