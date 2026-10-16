import { describe, expect, test } from 'bun:test';
import {
  classifyReportableTerminal,
  REPORTABLE_TERMINAL_PREDICATE_VERSION,
  type ReportableTerminalInput,
} from '../../../../src/lib/goals/reportable-terminal-gates';

function input(overrides: Partial<ReportableTerminalInput> = {}): ReportableTerminalInput {
  return {
    fromStatus: 'open',
    toStatus: 'done',
    hasStartGeneration: true,
    hasPriorTerminalGeneration: false,
    ...overrides,
  };
}

describe('classifyReportableTerminal', () => {
  describe('administrative transitions produce no notification', () => {
    test('archives a queued/draft task with no start generation', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'draft', toStatus: 'archived', hasStartGeneration: false })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });

    test('cancels a task before execution', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'cancelled', hasStartGeneration: false })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });

    test('completes an open task with no prior start (open → done)', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'done', hasStartGeneration: false })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });
  });

  describe('archival never produces a worker outcome notification', () => {
    test('archives an already-done task', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'done',
            toStatus: 'archived',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });

    test('archives an already-blocked task', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'blocked',
            toStatus: 'archived',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });

    test('archives an already-cancelled task', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'cancelled',
            toStatus: 'archived',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });

    test('reports archiving active work from review', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'review', toStatus: 'archived', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('reports archiving active work from approved', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'approved', toStatus: 'archived', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('archiving active work does not supersede a stale prior generation', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'review',
            toStatus: 'archived',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });
  });

  describe('active-work completions notify', () => {
    test('notifies for in_progress → open → done (started, completed from open)', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('notifies for in_progress → done', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'in_progress', toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('notifies for in_progress → cancelled after start', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'in_progress', toStatus: 'cancelled', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('notifies for review → approved → done', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'approved', toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });
  });

  describe('outcome-changing terminal-to-terminal transitions supersede + notify', () => {
    test('blocked → done produces a new terminal generation superseding the record', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'blocked',
            toStatus: 'done',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({
        action: 'supersede_notify',
        predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION,
      });
    });

    test('cancelled → done produces a new terminal generation superseding the record', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'cancelled',
            toStatus: 'done',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({
        action: 'supersede_notify',
        predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION,
      });
    });

    test('in_progress → blocked → done supersedes the blocked record', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'blocked',
            toStatus: 'done',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({
        action: 'supersede_notify',
        predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION,
      });
    });
  });

  describe('same-terminal rewrites produce no new notification', () => {
    test('done → done is a no-op', () => {
      expect(
        classifyReportableTerminal(
          input({
            fromStatus: 'done',
            toStatus: 'done',
            hasStartGeneration: true,
            hasPriorTerminalGeneration: true,
          })
        )
      ).toEqual({ action: 'none', reason: 'no_outcome_change' });
    });
  });

  describe('non-terminal target statuses', () => {
    test('open → in_progress is not terminal', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'in_progress', hasStartGeneration: true })
        )
      ).toEqual({ action: 'none', reason: 'not_terminal' });
    });

    test('null fromStatus to done with a start is a notify', () => {
      expect(
        classifyReportableTerminal(
          input({ fromStatus: null, toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });
  });
});
