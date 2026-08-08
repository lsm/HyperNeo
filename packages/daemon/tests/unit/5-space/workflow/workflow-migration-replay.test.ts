/**
 * Workflow Hook Migration Replay Suite
 *
 * Fixture-driven regression tests for migrateWorkflowGateProgressionToHooks.
 * Each fixture migrates a pre-hooks workflow shape (built-in template or
 * custom), asserts fixture-specific invariants, then REPLAYS the migration
 * over the migrated output asserting:
 *
 *   1. Byte-level idempotency — the replayed workflow deep-equals the first
 *      migration output (no hook rebuilds, no duplicate hooks, stable order).
 *   2. No gate re-migrates — replay emits zero `known_gate_migrated_to_hook`
 *      warnings (retained legacy custom gates may re-warn).
 *   3. Input purity — migration never mutates the workflow it is given, so
 *      persisted user-authored objects cannot be silently edited in place.
 *
 * Origin: a Codex P2 review found that a naive `/-lt (\d+) /` timeout regex
 * matched the plan-approval script's `[ "$COUNT" -lt 4 ]` vote-count check
 * first, so plan-approval hooks were rebuilt on every migration call. The
 * naive regex also has a destructive form: a custom `plan-approval:`/
 * `review-approval:`-prefixed hook whose script contains an unrelated
 * `-lt N` gets silently clobbered with the generated Codex script. The
 * custom-hook fixtures pin the destructive form directly (a rebuild to a
 * byte-identical script is invisible to `toEqual`, so replay checks alone
 * cannot). This suite pins that regression plus the neighboring semantics
 * called out in the task: plan/review approval hooks, custom timeout values,
 * approval-count expressions, duplicate hook IDs, channel address formats,
 * interpreter changes, timeoutMs equivalence, and multi-channel reset hooks.
 */

import { describe, expect, test } from 'bun:test';
import type { Gate, WorkflowHook } from '@hyperneo/shared';
import {
  CODING_WORKFLOW,
  FULLSTACK_QA_LOOP_WORKFLOW,
  getBuiltInWorkflows,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import {
  migrateWorkflowGateProgressionToHooks,
  type WorkflowMigrationWarning,
} from '../../../../src/lib/space/workflows/workflow-migration.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type MigrationInput = Parameters<typeof migrateWorkflowGateProgressionToHooks>[0];
type MigrationOutput = ReturnType<typeof migrateWorkflowGateProgressionToHooks>;

interface ReplayFixture {
  name: string;
  build: () => MigrationInput;
  verify: (first: MigrationOutput) => void;
  /**
   * Warning codes expected to re-fire on replay, in order. Retained legacy
   * custom gates warn on every pass; migrated built-in gates do not.
   */
  replayWarningCodes?: WorkflowMigrationWarning['code'][];
}

function runReplayFixture(fixture: ReplayFixture): void {
  const input = fixture.build();
  const inputSnapshot = JSON.stringify(input);
  const first = migrateWorkflowGateProgressionToHooks(input);
  // Migration must not mutate its input — persisted user-authored workflows
  // would otherwise be silently edited outside repository change detection.
  expect(JSON.stringify(input)).toBe(inputSnapshot);

  fixture.verify(first);

  const replay = migrateWorkflowGateProgressionToHooks({ ...first.workflow });
  // Idempotency: replaying over migrated output is a byte-level no-op —
  // no hook rebuilds, no duplicates, stable ordering.
  expect(replay.workflow).toEqual(first.workflow);
  // No gate re-migrates on replay.
  expect(
    replay.warnings.filter((warning) => warning.code === 'known_gate_migrated_to_hook')
  ).toEqual([]);
  expect(replay.warnings.map((warning) => warning.code)).toEqual(fixture.replayWarningCodes ?? []);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scriptSource(hook: WorkflowHook | undefined): string {
  return hook?.validator.kind === 'script' ? hook.validator.source : '';
}

function scriptTimeoutMs(hook: WorkflowHook | undefined): number | undefined {
  return hook?.validator.kind === 'script' ? hook.validator.timeoutMs : undefined;
}

function scriptInterpreter(hook: WorkflowHook | undefined): string | undefined {
  return hook?.validator.kind === 'script' ? hook.validator.interpreter : undefined;
}

function scriptExternalLookups(hook: WorkflowHook | undefined): unknown {
  return hook?.validator.kind === 'script' ? hook.validator.externalLookups : undefined;
}

function hookBetween(
  workflow: MigrationOutput['workflow'],
  sourceNode: string,
  targetNode: string
): WorkflowHook | undefined {
  // Prefer the SCRIPT approval hook — the migration now also emits a separate
  // `codex_review_approved` BUILT_IN hook on the same route (order 1), which
  // must not be mistaken for the approval script hook.
  return workflow.hooks?.find(
    (hook) =>
      hook.sourceNode === sourceNode &&
      hook.targetNode === targetNode &&
      hook.validator.kind === 'script'
  );
}

/** The migrated codex hook on an approval route, if the source node carries
 *  the legacy `requireCodexApproval` flag. */
function codexHookBetween(
  workflow: MigrationOutput['workflow'],
  sourceNode: string,
  targetNode: string
): WorkflowHook | undefined {
  return workflow.hooks?.find(
    (hook) =>
      hook.sourceNode === sourceNode &&
      hook.targetNode === targetNode &&
      hook.validator.kind === 'built_in' &&
      hook.validator.id === 'codex_review_approved'
  );
}

const PLAN_TEMPLATE_PROPS = {
  templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
  templateGates: PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? [],
};

const FULLSTACK_TEMPLATE_PROPS = {
  templateName: FULLSTACK_QA_LOOP_WORKFLOW.name,
  templateGates: FULLSTACK_QA_LOOP_WORKFLOW.gates ?? [],
};

/**
 * The generated Plan Review → Task Dispatcher approval hook, taken from the
 * migrated built-in template. Used as the baseline for equivalence fixtures
 * (interpreter / timeoutMs variants).
 */
function generatedPlanApprovalHook(): WorkflowHook {
  const migratedTemplate = getBuiltInWorkflows().find(
    (workflow) => workflow.name === PLAN_AND_DECOMPOSE_WORKFLOW.name
  )!;
  const hook = migratedTemplate.hooks!.find(
    (candidate) =>
      candidate.sourceNode === 'Plan Review' && candidate.targetNode === 'Task Dispatcher'
  );
  if (!hook) throw new Error('expected generated plan approval hook on migrated template');
  return hook;
}

function makeUserScriptHook(overrides: Partial<WorkflowHook> & { id: string }): WorkflowHook {
  return {
    enabled: true,
    sourceNode: 'Plan Review',
    targetNode: 'Task Dispatcher',
    method: 'send_message',
    classification: 'validation',
    order: 0,
    validator: { kind: 'script', interpreter: 'bash', source: 'jq -n \'{"type":"allow"}\'' },
    authorizedCallers: [{ sourceNode: 'Plan Review' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES: ReplayFixture[] = [
  {
    name: 'built-in plan approval hook migrates with a separate codex_review_approved hook',
    build: () => ({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      ...PLAN_TEMPLATE_PROPS,
    }),
    verify: ({ workflow, warnings }) => {
      // The approval hook is approval-count only — codex is a separate
      // declarative hook (the epic #2299 #2304 unification).
      const hook = hookBetween(workflow, 'Plan Review', 'Task Dispatcher');
      expect(hook).toBeDefined();
      expect(hook!.id).toStartWith('plan-approval:');
      const source = scriptSource(hook);
      expect(source).toContain('if [ "$COUNT" -lt 4 ]');
      expect(source).not.toContain('gh pr view');
      expect(source).not.toContain('Codex');
      expect(scriptTimeoutMs(hook)).toBe(30_000);
      expect(scriptInterpreter(hook)).toBe('bash');
      expect(scriptExternalLookups(hook)).toBeUndefined();

      // Codex is a built_in preset ordered AFTER the approval hook (order 1),
      // so its wait window starts at the approval handoff.
      const codex = codexHookBetween(workflow, 'Plan Review', 'Task Dispatcher');
      expect(codex).toBeDefined();
      expect(codex!.id).toStartWith('codex-approval:');
      expect(codex!.validator).toEqual({ kind: 'built_in', id: 'codex_review_approved' });
      expect(codex!.order).toBe(1);

      const channel = workflow.channels?.find(
        (candidate) => candidate.from === 'Plan Review' && candidate.to === 'Task Dispatcher'
      );
      expect(channel?.gateId).toBeUndefined();
      // All gates migrated away — the array is dropped entirely.
      expect(workflow.gates).toBeUndefined();
      expect(warnings.map((warning) => warning.code)).toEqual(['known_gate_migrated_to_hook']);

      const resetHook = workflow.hooks?.find((candidate) => candidate.id === 'plan-approval-reset');
      expect(resetHook?.targetNode).toBe('Planning');
      expect(scriptSource(resetHook)).toContain(hook!.id);
    },
  },
  {
    name: 'built-in plan approval hook without codex emits no codex hook',
    build: () => ({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: PLAN_AND_DECOMPOSE_WORKFLOW.nodes.map((node) =>
        node.name === 'Plan Review' ? { ...node, requireCodexApproval: false } : node
      ),
      ...PLAN_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      const hook = hookBetween(workflow, 'Plan Review', 'Task Dispatcher');
      expect(hook).toBeDefined();
      const source = scriptSource(hook);
      expect(source).toContain('if [ "$COUNT" -lt 4 ]');
      expect(source).toContain('Plan dispatch requires four approved plan-review votes');
      expect(source).not.toContain('gh pr view');
      expect(source).not.toContain('Codex');
      expect(scriptExternalLookups(hook)).toBeUndefined();
      // No codex hook when the source node does not require codex approval.
      expect(codexHookBetween(workflow, 'Plan Review', 'Task Dispatcher')).toBeUndefined();

      const resetHook = workflow.hooks?.find((candidate) => candidate.id === 'plan-approval-reset');
      expect(resetHook?.targetNode).toBe('Planning');
      expect(scriptSource(resetHook)).toContain(hook!.id);
    },
  },
  {
    name: 'built-in review approval hook migrates with a separate codex_review_approved hook',
    build: () => ({
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      ...FULLSTACK_TEMPLATE_PROPS,
    }),
    verify: ({ workflow, warnings }) => {
      const hook = hookBetween(workflow, 'Review', 'QA');
      expect(hook).toBeDefined();
      expect(hook!.id).toStartWith('review-approval:');
      const source = scriptSource(hook);
      expect(source).toContain('if [ "$APPROVED" != "true" ]');
      expect(source).not.toContain('gh pr view');
      expect(source).not.toContain('Codex');
      expect(scriptExternalLookups(hook)).toBeUndefined();

      const codex = codexHookBetween(workflow, 'Review', 'QA');
      expect(codex).toBeDefined();
      expect(codex!.id).toStartWith('codex-approval:');
      expect(codex!.validator).toEqual({ kind: 'built_in', id: 'codex_review_approved' });
      expect(codex!.order).toBe(1);

      const channel = workflow.channels?.find(
        (candidate) => candidate.from === 'Review' && candidate.to === 'QA'
      );
      expect(channel?.gateId).toBeUndefined();
      expect(workflow.gates).toBeUndefined();
      expect(warnings.map((warning) => warning.code)).toEqual(['known_gate_migrated_to_hook']);
      // Pre-existing built-in hooks ride through untouched.
      expect(workflow.hooks?.some((candidate) => candidate.id === 'fullstack-code-pr-ready')).toBe(
        true
      );
    },
  },
  {
    name: 'built-in coding workflow migrates review-posted hook',
    build: () => ({
      ...CODING_WORKFLOW,
      templateName: CODING_WORKFLOW.name,
      templateGates: CODING_WORKFLOW.gates ?? [],
    }),
    verify: ({ workflow, warnings }) => {
      // The Validation Complete node + validation-complete-gate were removed;
      // only the review-posted gate remains to migrate to a hook.
      const reviewPosted = workflow.hooks?.find((candidate) =>
        candidate.id.startsWith('review-posted:')
      );
      expect(reviewPosted?.sourceNode).toBe('Review');
      expect(reviewPosted?.targetNode).toBe('Coding');
      // The migrated hook references the review_posted built-in validator (an
      // external_state preset) — a declarative reference, no bash script and no
      // externalLookups (built-in validators resolve connectors via the registry).
      expect(reviewPosted?.validator).toEqual({ kind: 'built_in', id: 'review_posted' });
      expect(scriptSource(reviewPosted)).toBe('');

      expect(workflow.channels?.some((channel) => channel.gateId)).toBe(false);
      expect(workflow.gates).toBeUndefined();
      expect(
        warnings.filter((warning) => warning.code === 'known_gate_migrated_to_hook')
      ).toHaveLength(1);
      expect(workflow.hooks?.some((candidate) => candidate.id === 'code-pr-ready')).toBe(true);
    },
  },
  {
    name: 'duplicate hook ids in input collapse deterministically (last wins)',
    build: () => ({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      hooks: [
        makeUserScriptHook({
          id: 'duplicate-hook',
          validator: {
            kind: 'script',
            interpreter: 'bash',
            source: 'echo first',
          },
        }),
        makeUserScriptHook({
          id: 'duplicate-hook',
          validator: {
            kind: 'script',
            interpreter: 'bash',
            source: 'echo second',
          },
        }),
      ],
      ...PLAN_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      const duplicates = workflow.hooks?.filter((hook) => hook.id === 'duplicate-hook');
      expect(duplicates).toHaveLength(1);
      expect(scriptSource(duplicates?.[0])).toBe('echo second');
      // Migration still runs alongside the corrupt input.
      expect(workflow.hooks?.some((hook) => hook.id.startsWith('plan-approval:'))).toBe(true);
      expect(workflow.hooks?.some((hook) => hook.id === 'plan-approval-reset')).toBe(true);
    },
  },
  {
    name: 'broadcast and fan-out channel address formats stay on the legacy gate path',
    build: () => {
      const fanOutGate: Gate = {
        id: 'review-approval-gate',
        label: 'Review Approvals',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['Plan Review'],
            check: { op: '==', value: true },
          },
        ],
      };
      return {
        ...PLAN_AND_DECOMPOSE_WORKFLOW,
        gates: [...(PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? []), fanOutGate],
        channels: [
          { from: 'Planning', to: 'Plan Review', label: 'Planning → Plan Review' },
          {
            from: 'Plan Review',
            to: '*',
            gateId: 'plan-approval-gate',
            label: 'Plan Review → * (broadcast)',
          },
          {
            from: 'Plan Review',
            to: 'Planning',
            maxCycles: 5,
            label: 'Plan Review → Planning (revision requested)',
          },
          {
            from: 'Plan Review',
            to: ['Planning', 'Task Dispatcher'],
            gateId: 'review-approval-gate',
            label: 'Plan Review → fan-out',
          },
        ],
        templateName: PLAN_AND_DECOMPOSE_WORKFLOW.name,
        templateGates: [...(PLAN_AND_DECOMPOSE_WORKFLOW.gates ?? []), fanOutGate],
      };
    },
    verify: ({ workflow, warnings }) => {
      // The gates match built-in shapes exactly, so the ONLY thing blocking
      // migration here is the channel address format ('*' broadcast and
      // array fan-out) — both must stay gated and hook-free.
      const broadcast = workflow.channels?.find((channel) => channel.to === '*');
      expect(broadcast?.gateId).toBe('plan-approval-gate');
      const fanOut = workflow.channels?.find((channel) => Array.isArray(channel.to));
      expect(fanOut?.gateId).toBe('review-approval-gate');

      expect(workflow.hooks?.some((hook) => hook.id.startsWith('plan-approval:'))).toBe(false);
      expect(workflow.hooks?.some((hook) => hook.id.startsWith('review-approval:'))).toBe(false);
      expect(workflow.hooks?.some((hook) => hook.id.startsWith('plan-approval-reset'))).toBe(false);

      expect(warnings.map((warning) => warning.code)).toEqual([
        'legacy_custom_gate_deprecated',
        'legacy_custom_gate_deprecated',
      ]);
      for (const gateId of ['plan-approval-gate', 'review-approval-gate']) {
        expect(
          workflow.gates?.find((gate) => gate.id === gateId)?.legacyGateMetadata
        ).toMatchObject({ deprecated: true });
      }
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated', 'legacy_custom_gate_deprecated'],
  },
  {
    name: 'interpreter change on a generated-shape hook is preserved and not reused',
    build: () => {
      const generated = generatedPlanApprovalHook();
      return {
        ...PLAN_AND_DECOMPOSE_WORKFLOW,
        hooks: [
          {
            ...generated,
            id: 'plan-approval-legacy-interpreter',
            validator:
              generated.validator.kind === 'script'
                ? {
                    ...generated.validator,
                    // Simulates a persisted payload from before the bash-only
                    // interpreter union — the type cast is intentional.
                    interpreter: 'sh' as unknown as 'bash',
                  }
                : generated.validator,
          },
        ],
        ...PLAN_TEMPLATE_PROPS,
      };
    },
    verify: ({ workflow }) => {
      const legacy = workflow.hooks?.find((hook) => hook.id === 'plan-approval-legacy-interpreter');
      expect(legacy).toBeDefined();
      // User-authored semantics preserved verbatim — same source, untouched.
      expect(scriptInterpreter(legacy)).toBe('sh');
      expect(scriptSource(legacy)).toBe(scriptSource(generatedPlanApprovalHook()));
      // Interpreter participates in equivalence: a fresh generated hook is
      // installed alongside rather than reusing the legacy variant.
      const generated = workflow.hooks?.find((hook) => hook.id.startsWith('plan-approval:'));
      expect(generated).toBeDefined();
      expect(scriptInterpreter(generated)).toBe('bash');
    },
  },
  {
    name: 'timeoutMs participates in generated-hook equivalence',
    build: () => {
      const generated = generatedPlanApprovalHook();
      return {
        ...PLAN_AND_DECOMPOSE_WORKFLOW,
        hooks: [
          {
            ...generated,
            id: 'plan-approval-custom-timeout-ms',
            validator:
              generated.validator.kind === 'script'
                ? { ...generated.validator, timeoutMs: 60_000 }
                : generated.validator,
          },
        ],
        ...PLAN_TEMPLATE_PROPS,
      };
    },
    verify: ({ workflow }) => {
      const custom = workflow.hooks?.find((hook) => hook.id === 'plan-approval-custom-timeout-ms');
      expect(custom).toBeDefined();
      expect(scriptTimeoutMs(custom)).toBe(60_000);
      // A hook that differs only in timeoutMs is NOT the generated
      // equivalent — migration installs a fresh 30s hook alongside it.
      const generated = workflow.hooks?.find((hook) => hook.id.startsWith('plan-approval:'));
      expect(generated).toBeDefined();
      expect(scriptTimeoutMs(generated)).toBe(30_000);
    },
  },
  {
    name: 'custom plan-approval:-prefixed hook with unrelated -lt N is never clobbered',
    build: () => ({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      hooks: [
        makeUserScriptHook({
          id: 'plan-approval:custom-audit-trail',
          validator: {
            kind: 'script',
            interpreter: 'bash',
            source: [
              'RETRIES=$(jq -r \'.retryCount // 0\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}")',
              'if [ "$RETRIES" -lt 3 ]; then jq -n \'{"type":"allow"}\'; else echo "audit cap reached" >&2; exit 1; fi',
            ].join('\n'),
            timeoutMs: 45_000,
          },
        }),
      ],
      ...PLAN_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      // The EFFECTIVE pin for the Codex P2 regex regression: the post-pass
      // rebuild guard must match ONLY the anchored timeout comparison
      // `((NOW_EPOCH - START_EPOCH)) -lt N`. Under a naive `/-lt (\d+) /`
      // this hook's unrelated `-lt 3` is misread as a baked timeout
      // (3 !== default) and the hook is silently clobbered with the
      // generated Codex script. (A byte-identical generated-hook rebuild is
      // invisible to toEqual, so the replay fixtures alone cannot catch it.)
      const custom = workflow.hooks?.find((hook) => hook.id === 'plan-approval:custom-audit-trail');
      expect(custom).toBeDefined();
      expect(scriptSource(custom)).toContain('-lt 3');
      expect(scriptSource(custom)).not.toContain('gh pr view');
      expect(scriptTimeoutMs(custom)).toBe(45_000);
      // The generated hook still installs alongside on the same route.
      expect(
        workflow.hooks?.some(
          (hook) => hook.id.startsWith('plan-approval:') && hook.id !== custom!.id
        )
      ).toBe(true);
    },
  },
  {
    name: 'custom review-approval:-prefixed hook with unrelated -lt N is never clobbered',
    build: () => ({
      ...FULLSTACK_QA_LOOP_WORKFLOW,
      hooks: [
        ...(FULLSTACK_QA_LOOP_WORKFLOW.hooks ?? []),
        makeUserScriptHook({
          id: 'review-approval:custom-audit-trail',
          sourceNode: 'Review',
          targetNode: 'QA',
          validator: {
            kind: 'script',
            interpreter: 'bash',
            source: [
              'FINDINGS=$(jq -r \'.findings // 0\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}")',
              'if [ "$FINDINGS" -lt 5 ]; then jq -n \'{"type":"allow"}\'; else echo "too many findings" >&2; exit 1; fi',
            ].join('\n'),
          },
          authorizedCallers: [{ sourceNode: 'Review' }],
        }),
      ],
      ...FULLSTACK_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      // Review-side twin of the plan-approval pin above — the post-pass
      // treats `review-approval:`-prefixed ids the same way.
      const custom = workflow.hooks?.find(
        (hook) => hook.id === 'review-approval:custom-audit-trail'
      );
      expect(custom).toBeDefined();
      expect(scriptSource(custom)).toContain('-lt 5');
      expect(scriptSource(custom)).not.toContain('gh pr view');
      expect(
        workflow.hooks?.some(
          (hook) => hook.id.startsWith('review-approval:') && hook.id !== custom!.id
        )
      ).toBe(true);
    },
  },
  {
    name: 'multi-channel reset hooks install on every feedback route without duplication',
    build: () => ({
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      nodes: [
        ...PLAN_AND_DECOMPOSE_WORKFLOW.nodes,
        {
          id: 'replay-escalation-node',
          name: 'Escalation',
          agents: [{ agentId: 'Reviewer', name: 'escalation' }],
        },
      ],
      channels: [
        ...(PLAN_AND_DECOMPOSE_WORKFLOW.channels ?? []),
        { from: 'Plan Review', to: 'Escalation', label: 'Plan Review → Escalation' },
      ],
      ...PLAN_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      const approvalHook = hookBetween(workflow, 'Plan Review', 'Task Dispatcher');
      expect(approvalHook).toBeDefined();
      const resetHooks =
        workflow.hooks?.filter((hook) => hook.id.startsWith('plan-approval-reset')) ?? [];
      expect(resetHooks).toHaveLength(2);
      expect(resetHooks.map((hook) => hook.targetNode).sort()).toEqual(['Escalation', 'Planning']);
      // Reset hooks are collision-free: the second route gets a
      // disambiguated id, and both reference the approval hook they reset.
      expect(new Set(resetHooks.map((hook) => hook.id)).size).toBe(2);
      for (const resetHook of resetHooks) {
        expect(scriptSource(resetHook)).toContain(approvalHook!.id);
      }
    },
  },
  {
    name: 'custom workflow keeps legacy gates and user-authored hooks verbatim',
    build: () => ({
      nodes: [
        { id: 'custom-plan-node', name: 'Plan', agents: [{ name: 'planner' }] },
        { id: 'custom-build-node', name: 'Build', agents: [{ name: 'builder' }] },
      ],
      gates: [
        {
          id: 'plan-approval-gate',
          label: 'Approvals',
          fields: [
            {
              name: 'approvals',
              type: 'map',
              writers: ['Plan'],
              check: { op: 'count', match: 'approved', min: 4 },
            },
          ],
        },
      ],
      channels: [{ from: 'Plan', to: 'Build', gateId: 'plan-approval-gate' }],
      hooks: [
        makeUserScriptHook({
          id: 'user-authored-hook',
          sourceNode: 'Plan',
          targetNode: 'Build',
          validator: {
            kind: 'script',
            interpreter: 'bash',
            source: [
              'COUNT=$(jq ". | length" <<< "$INPUT")',
              'if [ "$COUNT" -lt 5 ]; then exit 1; fi',
            ].join('\n'),
            timeoutMs: 12_345,
          },
          authorizedCallers: [{ sourceNode: 'Plan' }],
        }),
      ],
    }),
    verify: ({ workflow, warnings }) => {
      // No templateName → gates never migrate, even when they match a
      // built-in shape exactly. The custom workflow's semantics are
      // preserved as-is.
      expect(warnings.map((warning) => warning.code)).toEqual(['legacy_custom_gate_deprecated']);
      expect(workflow.channels?.[0]?.gateId).toBe('plan-approval-gate');
      expect(workflow.gates?.[0]?.legacyGateMetadata).toMatchObject({ deprecated: true });

      expect(workflow.hooks).toHaveLength(1);
      const hook = workflow.hooks?.[0];
      expect(hook?.id).toBe('user-authored-hook');
      expect(scriptSource(hook)).toContain('-lt 5');
      expect(scriptTimeoutMs(hook)).toBe(12_345);
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated'],
  },
  {
    name: 'custom approval gate with requireCodexApproval source keeps codex enforcement',
    build: () => ({
      nodes: [
        {
          id: 'custom-plan-node',
          name: 'Plan',
          agents: [{ name: 'planner' }],
          requireCodexApproval: true,
        },
        { id: 'custom-build-node', name: 'Build', agents: [{ name: 'builder' }] },
      ],
      gates: [
        {
          id: 'custom-approval-gate',
          label: 'Approvals',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['Plan'],
              check: { op: '==', value: true },
            },
          ],
        },
      ],
      channels: [{ from: 'Plan', to: 'Build', gateId: 'custom-approval-gate' }],
    }),
    verify: ({ workflow, warnings }) => {
      // No templateName → the gate never migrates (channel stays gate-based)…
      expect(warnings.map((warning) => warning.code)).toEqual(['legacy_custom_gate_deprecated']);
      expect(workflow.channels?.[0]?.gateId).toBe('custom-approval-gate');
      // …but the codex requirement IS preserved: the gate carries the
      // `codex_review_approved` built-in VALIDATOR (gate-on-external-state), so
      // the send_message handler writes votes into gate data first and codex
      // gates the OPENING — a send_message hook would block before the vote
      // write and a custom map/count gate could never accumulate votes.
      const gate = workflow.gates?.find((g) => g.id === 'custom-approval-gate');
      expect(gate?.validator).toEqual({ kind: 'built_in', id: 'codex_review_approved' });
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated'],
  },
  {
    name: 'custom approval gate carrying the retired codex_review_bot feature emits a codex hook',
    build: () => ({
      nodes: [
        {
          id: 'custom-plan-node',
          name: 'Plan',
          agents: [{ name: 'planner' }],
          // A feature-carrying gate's source node also carries the legacy node
          // flag in practice; the flag keeps the generated codex hook idempotent
          // across replay.
          requireCodexApproval: true,
        },
        { id: 'custom-build-node', name: 'Build', agents: [{ name: 'builder' }] },
      ],
      gates: [
        {
          id: 'custom-approval-gate',
          label: 'Approvals',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['Plan'],
              check: { op: '==', value: true },
            },
          ],
          features: { codex_review_bot: true },
        },
      ],
      channels: [{ from: 'Plan', to: 'Build', gateId: 'custom-approval-gate' }],
    }),
    verify: ({ workflow }) => {
      // The codex requirement is preserved as the gate's built-in validator.
      expect(workflow.gates?.[0]?.validator).toEqual({
        kind: 'built_in',
        id: 'codex_review_approved',
      });
      // The feature is retained as a compat marker (validation tolerates it
      // during the migration window); the validator is the codex enforcement.
      expect(workflow.gates?.[0]?.features?.codex_review_bot).toBe(true);
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated'],
  },
  {
    name: 'clearing the requireCodexApproval node flag drops the generated codex hooks',
    build: () => ({
      nodes: [
        { id: 'custom-plan-node', name: 'Plan', agents: [{ name: 'planner' }] },
        { id: 'custom-build-node', name: 'Build', agents: [{ name: 'builder' }] },
      ],
      gates: [
        {
          id: 'custom-approval-gate',
          label: 'Approvals',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['Plan'],
              check: { op: '==', value: true },
            },
          ],
        },
      ],
      channels: [{ from: 'Plan', to: 'Build', gateId: 'custom-approval-gate' }],
      // The hook was generated by a PREVIOUS pass while the source node carried
      // requireCodexApproval; the user has since cleared the toggle (serialization
      // omits the flag but keeps the hooks). The migration must drop the stale
      // generated codex hook so the disabled setting actually takes effect.
      hooks: [
        {
          id: 'codex-approval:4-plan:5-build',
          enabled: true,
          label: 'Codex Review',
          sourceNode: 'Plan',
          targetNode: 'Build',
          method: 'send_message',
          classification: 'validation',
          order: 1,
          validator: { kind: 'built_in', id: 'codex_review_approved' },
          authorizedCallers: [{ sourceNode: 'Plan' }],
        },
      ],
    }),
    verify: ({ workflow }) => {
      expect(
        workflow.hooks?.some(
          (hook) =>
            hook.id.startsWith('codex-approval:') &&
            hook.validator.kind === 'built_in' &&
            hook.validator.id === 'codex_review_approved'
        )
      ).toBe(false);
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated'],
  },
  {
    name: 'shared custom gate with mixed sources uses the gate validator (vote-safe)',
    build: () => ({
      nodes: [
        {
          id: 'custom-plan-node',
          name: 'Plan',
          agents: [{ name: 'planner' }],
          requireCodexApproval: true,
        },
        { id: 'custom-other-node', name: 'Other', agents: [{ name: 'other' }] },
        { id: 'custom-build-node', name: 'Build', agents: [{ name: 'builder' }] },
      ],
      gates: [
        {
          id: 'shared-approval-gate',
          label: 'Approvals',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['Plan', 'Other'],
              check: { op: '==', value: true },
            },
          ],
        },
      ],
      channels: [
        { from: 'Plan', to: 'Build', gateId: 'shared-approval-gate' },
        { from: 'Other', to: 'Build', gateId: 'shared-approval-gate' },
      ],
    }),
    verify: ({ workflow }) => {
      // A shared gate with a requiring source attaches the codex VALIDATOR (not
      // per-source send_message hooks): the handler writes votes into gate data
      // first, then the gate evaluates codex + fields — so map/count votes
      // accumulate instead of being dropped by a blocking hook. Over-gating the
      // non-requiring source is a fail-closed, more-restrictive behavior that
      // is preferable to the vote deadlock.
      expect(workflow.gates?.find((g) => g.id === 'shared-approval-gate')?.validator).toEqual({
        kind: 'built_in',
        id: 'codex_review_approved',
      });
      const codexHooks =
        workflow.hooks?.filter(
          (hook) =>
            hook.validator.kind === 'built_in' && hook.validator.id === 'codex_review_approved'
        ) ?? [];
      expect(codexHooks.length).toBe(0);
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated', 'legacy_custom_gate_deprecated'],
  },
  {
    name: 'custom approval gate with a poll falls back to per-source hooks (no validator+poll)',
    build: () => ({
      nodes: [
        {
          id: 'custom-plan-node',
          name: 'Plan',
          agents: [{ name: 'planner' }],
          requireCodexApproval: true,
        },
        { id: 'custom-build-node', name: 'Build', agents: [{ name: 'builder' }] },
      ],
      gates: [
        {
          id: 'polled-approval-gate',
          label: 'Approvals',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['Plan'],
              check: { op: '==', value: true },
            },
          ],
          // A retained custom gate may configure a POLL. `validateGate` forbids
          // validator+poll, so codex must attach as a per-source hook instead of
          // a gate validator — otherwise the migrated gate becomes unsaveable.
          poll: { intervalMs: 30_000, target: 'to', script: 'echo \'{"type":"allow"}\'' },
        },
      ],
      channels: [{ from: 'Plan', to: 'Build', gateId: 'polled-approval-gate' }],
    }),
    verify: ({ workflow }) => {
      const gate = workflow.gates?.find((g) => g.id === 'polled-approval-gate');
      // No validator attached (would collide with the poll in validateGate).
      expect(gate?.validator).toBeUndefined();
      // The poll is preserved.
      expect(gate?.poll).toBeDefined();
      // This gate is a vote-count approval gate (boolean approved field →
      // isApprovalGate). A send_message hook would run before the handler
      // writes the vote, so codex is NOT enforced — the deadlock guard
      // prevents emitting a hook that could starve vote accumulation.
      const codexHooks =
        workflow.hooks?.filter(
          (hook) =>
            hook.validator.kind === 'built_in' && hook.validator.id === 'codex_review_approved'
        ) ?? [];
      expect(codexHooks.length).toBe(0);
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated'],
  },
  {
    name: 'gate-feature codex on a wildcard channel gates ALL sources (not just flagged ones)',
    build: () => ({
      nodes: [
        { id: 'node-a', name: 'Alpha', agents: [{ name: 'alpha-agent' }] },
        { id: 'node-b', name: 'Beta', agents: [{ name: 'beta-agent' }] },
        { id: 'node-c', name: 'Gamma', agents: [{ name: 'gamma-agent' }] },
      ],
      gates: [
        {
          id: 'shared-feature-gate',
          label: 'Approval',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          // Gate-level codex feature — applies to ALL sources, not just
          // requireCodexApproval-flagged ones. No node carries the flag.
          features: { codex_review_bot: true },
        },
      ],
      channels: [{ from: '*', to: 'Gamma', gateId: 'shared-feature-gate' }],
    }),
    verify: ({ workflow }) => {
      // The gate carries the feature → validator attached (all sources gated).
      expect(workflow.gates?.find((g) => g.id === 'shared-feature-gate')?.validator).toEqual({
        kind: 'built_in',
        id: 'codex_review_approved',
      });
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated'],
  },
];

describe('workflow hook migration replay suite', () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => runReplayFixture(fixture));
  }

  test('every built-in template migrates and replays identically', () => {
    for (const template of [
      CODING_WORKFLOW,
      RESEARCH_WORKFLOW,
      REVIEW_ONLY_WORKFLOW,
      PLAN_AND_DECOMPOSE_WORKFLOW,
      FULLSTACK_QA_LOOP_WORKFLOW,
    ]) {
      const first = migrateWorkflowGateProgressionToHooks({
        ...template,
        templateName: template.name,
        templateGates: template.gates ?? [],
      });
      const replay = migrateWorkflowGateProgressionToHooks({ ...first.workflow });
      expect(replay.workflow).toEqual(first.workflow);
      expect(replay.warnings).toEqual([]);
    }
  });

  test('plan-approval hook replay converges across multiple rounds', () => {
    // NOTE: this is a convergence check, NOT the Codex P2 regex pin. A
    // naive `/-lt (\d+) /` timeout regex would read `-lt 4` from the
    // vote-count check and rebuild the hook on every call — but to a
    // byte-identical script at the default timeout, which toEqual cannot
    // see. The effective pins are the `plan-approval:`/`review-approval:`-
    // prefixed custom-hook fixtures above, which ARE clobbered under the
    // naive regex. What THIS test pins: replaying a migrated plan-approval
    // hook (whose script carries BOTH the `-lt 4` vote count and the `-lt
    // N` timeout comparison) is a stable no-op across repeated rounds.
    const base: MigrationInput = {
      ...PLAN_AND_DECOMPOSE_WORKFLOW,
      ...PLAN_TEMPLATE_PROPS,
    };
    const first = migrateWorkflowGateProgressionToHooks(base).workflow;
    const firstHook = hookBetween(first, 'Plan Review', 'Task Dispatcher');
    expect(scriptSource(firstHook)).toContain('if [ "$COUNT" -lt 4 ]');

    for (let round = 0; round < 3; round++) {
      const replayed = migrateWorkflowGateProgressionToHooks({ ...first }).workflow;
      expect(replayed).toEqual(first);
    }
  });
});
