/**
 * Real-snapshot migration replay suite — epic #2299, P2 #2303.
 *
 * Why this suite exists (and what it deliberately is NOT):
 *
 * The #2303 task spec called for "re-stamp old `built_in: pr_ready|pr_merged`
 * → new preset form". Investigation against ADR #2 of the epic (built_in is
 * KEPT as the named-preset form — there is no newer persisted form) and the
 * live production DB showed that migration is a NO-OP for the persisted data:
 * the only built_in id present in any real workflow is `pr_ready`, and it
 * already resolves via the registry #2302 introduced; `pr_merged` was never
 * admitted before #2302, so no persisted workflow carries it. There is no
 * legacy id to transform and no shim gap to fill (unregistered ids already
 * fail-closed at dispatch + admission).
 *
 * What remains — and what this suite delivers — is the task's hard constraint:
 * "fixture tests against REAL persisted-workflow snapshots run through
 * migration" proving the load-time migration is idempotent and never disturbs
 * a deployed `pr_ready` gate. A bad migration silently breaks production
 * spaces, so this is the one place a regression must be caught by real data,
 * not a hand-synthesized workflow.
 *
 * The fixtures under `./fixtures/real-snapshots/` are anonymized snapshots of
 * actual rows from the production daemon.db (UUIDs zeroed, prompt text trimmed;
 * gate/hook scripts kept verbatim — they are what the migration reads). Each is
 * a genuinely deployed shape, including the messy cases the synthetic suite
 * does not cover: leftover unreferenced legacy gates, a legacy gate still wired
 * onto a channel, and `built_in:pr_ready` validators that must ride through
 * untouched.
 *
 * Per fixture we assert:
 *   1. Input purity — migration never mutates the snapshot it is given.
 *   2. `pr_ready` (and every built_in validator) is preserved verbatim — the
 *      no-op is safe: the preset resolves via the registry, so migration must
 *      not drop, rewrite, or duplicate it.
 *   3. Byte-level idempotency — re-running the load-time migration over its own
 *      output (with templateGates re-injected, as the workflow manager does on
 *      every load) is a no-op.
 *   4. No gate re-migrates on replay (zero `known_gate_migrated_to_hook`).
 *   5. Legacy-gate warnings are stable across passes (deterministic handling).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import type { Gate, SpaceWorkflow, WorkflowHook } from '@hyperneo/shared';
import { getBuiltInWorkflows } from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import {
  migrateWorkflowGateProgressionToHooks,
  type WorkflowMigrationWarning,
} from '../../../../src/lib/space/workflows/workflow-migration.ts';

type MigrationInput = Parameters<typeof migrateWorkflowGateProgressionToHooks>[0];

const FIXTURES_DIR = join(__dirname, 'fixtures', 'real-snapshots');

/** Map of built-in template name → its current gates, resolved once. The
 *  workflow manager injects these as `templateGates` on every load (it is not
 *  a persisted field), so each replay round re-injects them the same way. */
const TEMPLATE_GATES_BY_NAME = new Map<string, Gate[]>(
  getBuiltInWorkflows().map((t) => [t.name, t.gates ?? []])
);

interface FixtureFile {
  _provenance: string;
  _templateName: string;
  _summary: {
    hookValidatorKinds: Record<string, number>;
    gateIds: string[];
    nodeNames: string[];
  };
  workflow: SpaceWorkflow;
}

function loadFixtures(): Array<{ name: string; input: MigrationInput }> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => extname(f) === '.json')
    .sort()
    .map((file) => {
      const parsed = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as FixtureFile;
      const templateGates = TEMPLATE_GATES_BY_NAME.get(parsed.workflow.templateName ?? '') ?? [];
      // Reconstruct the exact object the workflow manager hands the migration
      // on load: the persisted row plus the runtime-injected templateGates.
      const input: MigrationInput = { ...parsed.workflow, templateGates };
      return { name: parsed._templateName, input };
    });
}

/** Sorted multiset of built_in validator ids on a hook list. The migration must
 *  never change this — `pr_ready` rides through untouched because it resolves
 *  via the registry (the preset), not via a gate→hook transformation. */
function builtInValidatorIds(hooks: WorkflowHook[] | undefined): string[] {
  return (hooks ?? [])
    .filter((h) => h.validator.kind === 'built_in')
    .map((h) => (h.validator as { id: string }).id)
    .sort();
}

function warningCodes(warnings: WorkflowMigrationWarning[]): string[] {
  return warnings.map((w) => w.code).sort();
}

describe('workflow migration — real-snapshot replay suite (#2303)', () => {
  const fixtures = loadFixtures();
  test('fixtures loaded from the real-snapshots directory', () => {
    // Guard against an empty/missing fixtures dir silently passing everything.
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, input } of fixtures) {
    describe(`real snapshot: ${name}`, () => {
      test('input purity — migration does not mutate the snapshot', () => {
        const before = JSON.stringify(input);
        migrateWorkflowGateProgressionToHooks(input);
        expect(JSON.stringify(input)).toBe(before);
      });

      test('built_in pr_ready (and any built_in validator) is preserved verbatim', () => {
        const beforeIds = builtInValidatorIds(input.hooks);
        const { workflow } = migrateWorkflowGateProgressionToHooks(input);
        const afterIds = builtInValidatorIds(workflow.hooks);
        // Existing built-in validators are never rewritten — the migration only
        // ADDS hooks (e.g. a `codex_review_approved` hook resolved from a legacy
        // requireCodexApproval source), so assert a superset, not equality.
        expect(beforeIds.every((id) => afterIds.includes(id))).toBe(true);
        // The headline assertion: every real snapshot carries pr_ready, and it
        // survives untouched. If this ever flips, a migration is rewriting a
        // deployed handoff gate — the exact silent breakage #2303 guards.
        expect(beforeIds).toContain('pr_ready');
      });

      test('idempotent — re-running the load-time migration is a byte-level no-op', () => {
        const first = migrateWorkflowGateProgressionToHooks(input);
        // Re-inject templateGates exactly as the workflow manager does on every
        // load (they are not persisted on the row).
        const replay = migrateWorkflowGateProgressionToHooks({
          ...first.workflow,
          templateGates: TEMPLATE_GATES_BY_NAME.get(input.templateName ?? '') ?? [],
        });
        expect(replay.workflow).toEqual(first.workflow);
        // No gate re-migrates on the second pass.
        expect(replay.warnings.filter((w) => w.code === 'known_gate_migrated_to_hook')).toEqual([]);
        // Legacy-gate handling is deterministic across passes.
        expect(warningCodes(replay.warnings)).toEqual(warningCodes(first.warnings));
      });
    });
  }
});
