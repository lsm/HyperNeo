import { describe, expect, test } from 'bun:test';
import {
  decideReportableTerminal,
  REPORTABLE_TERMINAL_PREDICATE_VERSION,
  type ReportableTerminalInput,
} from '../../../../src/lib/space/goals/reportable-terminal-gates';

function input(overrides: Partial<ReportableTerminalInput> = {}): ReportableTerminalInput {
  return {
    fromStatus: 'open',
    toStatus: 'done',
    hasStartGeneration: true,
    hasPriorTerminalGeneration: false,
    ...overrides,
  };
}

describe('decideReportableTerminal', () => {
  describe('administrative transitions produce no notification', () => {
    test('archives a queued/draft task with no start generation', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'draft', toStatus: 'archived', hasStartGeneration: false })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });

    test('cancels a task before execution', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'cancelled', hasStartGeneration: false })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });

    test('completes an open task with no prior start (open → done)', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'done', hasStartGeneration: false })
        )
      ).toEqual({ action: 'none', reason: 'administrative' });
    });
  });

  describe('archival never produces a worker outcome notification', () => {
    test('archives an already-done task', () => {
      expect(
        decideReportableTerminal(
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
        decideReportableTerminal(
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
        decideReportableTerminal(
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
        decideReportableTerminal(
          input({ fromStatus: 'review', toStatus: 'archived', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('reports archiving active work from approved', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'approved', toStatus: 'archived', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });
  });

  describe('active-work completions notify', () => {
    test('notifies for in_progress → open → done (started, completed from open)', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('notifies for in_progress → done', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'in_progress', toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('notifies for in_progress → cancelled after start', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'in_progress', toStatus: 'cancelled', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });

    test('notifies for review → approved → done', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: 'approved', toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });
  });

  describe('outcome-changing terminal-to-terminal transitions supersede + notify', () => {
    test('blocked → done produces a new terminal generation superseding the record', () => {
      expect(
        decideReportableTerminal(
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
        decideReportableTerminal(
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
        decideReportableTerminal(
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
        decideReportableTerminal(
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
        decideReportableTerminal(
          input({ fromStatus: 'open', toStatus: 'in_progress', hasStartGeneration: true })
        )
      ).toEqual({ action: 'none', reason: 'not_terminal' });
    });

    test('null fromStatus to done with a start is a notify', () => {
      expect(
        decideReportableTerminal(
          input({ fromStatus: null, toStatus: 'done', hasStartGeneration: true })
        )
      ).toEqual({ action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION });
    });
  });
});
