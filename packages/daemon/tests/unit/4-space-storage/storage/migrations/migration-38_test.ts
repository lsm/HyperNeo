/**
 * Migration 38 Tests — REMOVED
 *
 * Migration 38 added the `is_cyclic` column to `space_workflow_transitions`.
 * That table was dropped by migration 59 as part of the WorkflowTransition removal.
 * These tests are no longer applicable.
 */
import { it } from 'bun:test';

// Vitest (unlike bun:test) fails an included file that registers no tests
// ("No test suite found"). This passing placeholder keeps the file a valid
// historical marker; the reason is captured in the test name below.
it('migration 38: tests removed (space_workflow_transitions dropped by migration 59)', () => {
  // intentionally empty — see header.
});
