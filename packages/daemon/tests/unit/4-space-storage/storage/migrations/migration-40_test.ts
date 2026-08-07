/**
 * Migration 40 Tests
 *
 * Migration 40 added task_id + status to space_session_groups, dropped the role
 * CHECK constraint on space_session_group_members, and added agent_id + status to
 * space_session_group_members.
 *
 * All tests that previously validated these tables have been removed because
 * migration 59 drops space_session_groups and space_session_group_members entirely.
 * Running runMigrations() on a fresh DB leaves neither table present, so any
 * assertions against them would fail. Coverage for the M60 drop is in
 * migration-60_test.ts.
 */
import { it } from 'bun:test';

// Vitest (unlike bun:test) fails an included file that registers no tests
// ("No test suite found"). This passing placeholder keeps the file a valid
// historical marker; the reason is captured in the test name below.
it('migration 40: tests removed (space_session_groups[_members] dropped by migration 59)', () => {
  // intentionally empty — see header; M60 drop coverage is in migration-60_test.ts.
});
