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
 * matched the review-approval script's comparison first, so review-approval
 * hooks were rebuilt on every migration call. The naive regex also has a
 * destructive form: a custom `review-approval:`-prefixed hook whose script
 * contains an unrelated `-lt N` gets silently clobbered with the generated
 * Codex script. The custom-hook fixtures pin the destructive form directly (a
 * rebuild to a byte-identical script is invisible to `toEqual`, so replay
 * checks alone cannot). This suite pins that regression plus the neighboring
 * semantics: review approval hooks, custom timeout values, approval-count
 * expressions, duplicate hook IDs, channel address formats, interpreter
 * changes, and timeoutMs equivalence.
 */

import { describe, expect, test } from 'bun:test';
import type { Gate, WorkflowHook } from '@hyperneo/shared';
import {
  CODING_WORKFLOW,
  CODING_WITH_QA_WORKFLOW,
  getBuiltInWorkflows,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import {
  migrateWorkflowGateProgressionToHooks,
  type WorkflowMigrationWarning,
} from '../../../../src/lib/space/workflows/workflow-migration.ts';
import { CODEX_REVIEW_BOT_TIMEOUT_SECONDS } from '../../../../src/lib/space/runtime/gate-features.ts';

/**
 * The migration bakes the env-resolved default Codex timeout into generated
 * hook scripts at module load. Assert against the RESOLVED value (and its
 * human label, mirroring formatCodexTimeoutLabel) rather than hard-coding
 * 7200/`2-hour`, so this suite still passes when the test process inherits
 * HYPERNEO_CODEX_REVIEW_BOT_TIMEOUT_SECONDS.
 */
const DEFAULT_TIMEOUT = CODEX_REVIEW_BOT_TIMEOUT_SECONDS;
const DEFAULT_TIMEOUT_LABEL =
  DEFAULT_TIMEOUT >= 3600 && DEFAULT_TIMEOUT % 3600 === 0
    ? `${DEFAULT_TIMEOUT / 3600}-hour`
    : `${Math.max(1, Math.round(DEFAULT_TIMEOUT / 60))}-minute`;

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
  return workflow.hooks?.find(
    (hook) => hook.sourceNode === sourceNode && hook.targetNode === targetNode
  );
}

const QA_TEMPLATE_PROPS = {
  templateName: CODING_WITH_QA_WORKFLOW.name,
  templateGates: CODING_WITH_QA_WORKFLOW.gates ?? [],
};

/**
 * The generated Review → QA approval hook, taken from the migrated built-in
 * template. Used as the baseline for equivalence fixtures (interpreter /
 * timeoutMs variants).
 */
function generatedReviewApprovalHook(): WorkflowHook {
  const migratedTemplate = getBuiltInWorkflows().find(
    (workflow) => workflow.name === CODING_WITH_QA_WORKFLOW.name
  )!;
  const hook = migratedTemplate.hooks!.find(
    (candidate) => candidate.sourceNode === 'Review' && candidate.targetNode === 'QA'
  );
  if (!hook) throw new Error('expected generated review approval hook on migrated template');
  return hook;
}

function makeUserScriptHook(overrides: Partial<WorkflowHook> & { id: string }): WorkflowHook {
  return {
    enabled: true,
    sourceNode: 'Review',
    targetNode: 'QA',
    method: 'send_message',
    classification: 'validation',
    order: 0,
    validator: { kind: 'script', interpreter: 'bash', source: 'jq -n \'{"type":"allow"}\'' },
    authorizedCallers: [{ sourceNode: 'Review' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES: ReplayFixture[] = [
  {
    name: 'built-in review approval hook (codex) migrates and replays identically',
    build: () => ({
      ...CODING_WITH_QA_WORKFLOW,
      ...QA_TEMPLATE_PROPS,
    }),
    verify: ({ workflow, warnings }) => {
      const hook = hookBetween(workflow, 'Review', 'QA');
      expect(hook).toBeDefined();
      expect(hook!.id).toStartWith('review-approval:');
      const source = scriptSource(hook);
      expect(source).toContain('if [ "$APPROVED" != "true" ]');
      expect(source).toContain(`((NOW_EPOCH - START_EPOCH)) -lt ${DEFAULT_TIMEOUT} `);
      expect(source).toContain(`${DEFAULT_TIMEOUT_LABEL} timeout`);
      expect(source).toContain('gh pr view');
      expect(scriptExternalLookups(hook)).toEqual(['github']);

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
    name: 'custom per-node codex timeout (minutes) is baked into the migrated hook',
    build: () => ({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((node) =>
        node.name === 'Review'
          ? { ...node, requireCodexApproval: true, codexTimeoutSeconds: 300 }
          : node
      ),
      ...QA_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      const hook = hookBetween(workflow, 'Review', 'QA');
      const source = scriptSource(hook);
      expect(source).toContain('((NOW_EPOCH - START_EPOCH)) -lt 300 ');
      expect(source).not.toContain('-lt 7200 ');
      expect(source).toContain('5-minute timeout');
      expect(scriptExternalLookups(hook)).toEqual(['github']);
    },
  },
  {
    name: 'custom per-node codex timeout (hours) is baked into the migrated hook',
    build: () => ({
      ...CODING_WITH_QA_WORKFLOW,
      nodes: CODING_WITH_QA_WORKFLOW.nodes.map((node) =>
        node.name === 'Review' ? { ...node, codexTimeoutSeconds: 3600 } : node
      ),
      ...QA_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      const hook = hookBetween(workflow, 'Review', 'QA');
      const source = scriptSource(hook);
      expect(source).toContain('((NOW_EPOCH - START_EPOCH)) -lt 3600 ');
      expect(source).not.toContain('-lt 7200 ');
      expect(source).toContain('1-hour timeout');
    },
  },
  {
    name: 'duplicate hook ids in input collapse deterministically (last wins)',
    build: () => ({
      ...CODING_WITH_QA_WORKFLOW,
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
      ...QA_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      const duplicates = workflow.hooks?.filter((hook) => hook.id === 'duplicate-hook');
      expect(duplicates).toHaveLength(1);
      expect(scriptSource(duplicates?.[0])).toBe('echo second');
      // Migration still runs alongside the corrupt input.
      expect(workflow.hooks?.some((hook) => hook.id.startsWith('review-approval:'))).toBe(true);
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
            writers: ['Review'],
            check: { op: '==', value: true },
          },
        ],
      };
      return {
        ...CODING_WITH_QA_WORKFLOW,
        gates: [...(CODING_WITH_QA_WORKFLOW.gates ?? []), fanOutGate],
        channels: [
          { from: 'Coding', to: 'Review', label: 'Coding → Review' },
          {
            from: 'Review',
            to: '*',
            gateId: 'review-approval-gate',
            label: 'Review → * (broadcast)',
          },
          {
            from: 'Review',
            to: 'Coding',
            maxCycles: 6,
            label: 'Review → Coding (feedback)',
          },
          {
            from: 'Review',
            to: ['Coding', 'QA'],
            gateId: 'review-approval-gate',
            label: 'Review → fan-out',
          },
        ],
        templateName: CODING_WITH_QA_WORKFLOW.name,
        templateGates: [...(CODING_WITH_QA_WORKFLOW.gates ?? []), fanOutGate],
      };
    },
    verify: ({ workflow, warnings }) => {
      // The gates match built-in shapes exactly, so the ONLY thing blocking
      // migration here is the channel address format ('*' broadcast and
      // array fan-out) — both must stay gated and hook-free.
      const broadcast = workflow.channels?.find((channel) => channel.to === '*');
      expect(broadcast?.gateId).toBe('review-approval-gate');
      const fanOut = workflow.channels?.find((channel) => Array.isArray(channel.to));
      expect(fanOut?.gateId).toBe('review-approval-gate');

      expect(workflow.hooks?.some((hook) => hook.id.startsWith('review-approval:'))).toBe(false);
      expect(warnings.map((warning) => warning.code)).toEqual([
        'legacy_custom_gate_deprecated',
        'legacy_custom_gate_deprecated',
      ]);
      expect(
        workflow.gates?.find((gate) => gate.id === 'review-approval-gate')?.legacyGateMetadata
      ).toMatchObject({ deprecated: true });
    },
    replayWarningCodes: ['legacy_custom_gate_deprecated', 'legacy_custom_gate_deprecated'],
  },
  {
    name: 'interpreter change on a generated-shape hook is preserved and not reused',
    build: () => {
      const generated = generatedReviewApprovalHook();
      return {
        ...CODING_WITH_QA_WORKFLOW,
        hooks: [
          {
            ...generated,
            id: 'review-approval-legacy-interpreter',
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
        ...QA_TEMPLATE_PROPS,
      };
    },
    verify: ({ workflow }) => {
      const legacy = workflow.hooks?.find(
        (hook) => hook.id === 'review-approval-legacy-interpreter'
      );
      expect(legacy).toBeDefined();
      // User-authored semantics preserved verbatim — same source, untouched.
      expect(scriptInterpreter(legacy)).toBe('sh');
      expect(scriptSource(legacy)).toBe(scriptSource(generatedReviewApprovalHook()));
      // Interpreter participates in equivalence: a fresh generated hook is
      // installed alongside rather than reusing the legacy variant.
      const generated = workflow.hooks?.find((hook) => hook.id.startsWith('review-approval:'));
      expect(generated).toBeDefined();
      expect(scriptInterpreter(generated)).toBe('bash');
    },
  },
  {
    name: 'timeoutMs participates in generated-hook equivalence',
    build: () => {
      const generated = generatedReviewApprovalHook();
      return {
        ...CODING_WITH_QA_WORKFLOW,
        hooks: [
          {
            ...generated,
            id: 'review-approval-custom-timeout-ms',
            validator:
              generated.validator.kind === 'script'
                ? { ...generated.validator, timeoutMs: 60_000 }
                : generated.validator,
          },
        ],
        ...QA_TEMPLATE_PROPS,
      };
    },
    verify: ({ workflow }) => {
      const custom = workflow.hooks?.find(
        (hook) => hook.id === 'review-approval-custom-timeout-ms'
      );
      expect(custom).toBeDefined();
      expect(scriptTimeoutMs(custom)).toBe(60_000);
      // A hook that differs only in timeoutMs is NOT the generated
      // equivalent — migration installs a fresh 30s hook alongside it.
      const generated = workflow.hooks?.find((hook) => hook.id.startsWith('review-approval:'));
      expect(generated).toBeDefined();
      expect(scriptTimeoutMs(generated)).toBe(30_000);
    },
  },
  {
    name: 'custom review-approval:-prefixed hook with unrelated -lt N is never clobbered',
    build: () => ({
      ...CODING_WITH_QA_WORKFLOW,
      hooks: [
        ...(CODING_WITH_QA_WORKFLOW.hooks ?? []),
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
      ...QA_TEMPLATE_PROPS,
    }),
    verify: ({ workflow }) => {
      // The EFFECTIVE pin for the Codex P2 regex regression: the post-pass
      // rebuild guard must match ONLY the anchored timeout comparison
      // `((NOW_EPOCH - START_EPOCH)) -lt N`. Under a naive `/-lt (\d+) /`
      // this hook's unrelated `-lt 5` is misread as a baked timeout
      // (5 !== default) and the hook is silently clobbered with the
      // generated Codex script. (A byte-identical generated-hook rebuild is
      // invisible to toEqual, so the replay fixtures alone cannot catch it.)
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
    name: 'custom workflow keeps legacy gates and user-authored hooks verbatim',
    build: () => ({
      nodes: [
        { id: 'custom-build-node', name: 'Build', agents: [{ name: 'builder' }] },
        { id: 'custom-qa-node', name: 'QA', agents: [{ name: 'qa' }] },
      ],
      gates: [
        {
          id: 'custom-approval-gate',
          label: 'Approvals',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['Build'],
              check: { op: '==', value: true },
            },
          ],
        },
      ],
      channels: [{ from: 'Build', to: 'QA', gateId: 'custom-approval-gate' }],
      hooks: [
        makeUserScriptHook({
          id: 'user-authored-hook',
          sourceNode: 'Build',
          targetNode: 'QA',
          validator: {
            kind: 'script',
            interpreter: 'bash',
            source: [
              'COUNT=$(jq ". | length" <<< "$INPUT")',
              'if [ "$COUNT" -lt 5 ]; then exit 1; fi',
            ].join('\n'),
            timeoutMs: 12_345,
          },
          authorizedCallers: [{ sourceNode: 'Build' }],
        }),
      ],
    }),
    verify: ({ workflow, warnings }) => {
      // No templateName → gates never migrate, even when they match a
      // built-in shape exactly. The custom workflow's semantics are
      // preserved as-is.
      expect(warnings.map((warning) => warning.code)).toEqual(['legacy_custom_gate_deprecated']);
      expect(workflow.channels?.[0]?.gateId).toBe('custom-approval-gate');
      expect(workflow.gates?.[0]?.legacyGateMetadata).toMatchObject({ deprecated: true });

      expect(workflow.hooks).toHaveLength(1);
      const hook = workflow.hooks?.[0];
      expect(hook?.id).toBe('user-authored-hook');
      expect(scriptSource(hook)).toContain('-lt 5');
      expect(scriptTimeoutMs(hook)).toBe(12_345);
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
      CODING_WITH_QA_WORKFLOW,
      RESEARCH_WORKFLOW,
      REVIEW_ONLY_WORKFLOW,
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

  test('custom timeout drift rebuild converges after one re-migration', () => {
    // Once a channel is migrated its gateId is stripped, so the post-pass
    // rebuilds the hook when codexTimeoutSeconds drifts. The rebuild must
    // CONVERGE: after one re-migration at the new value, further replays
    // are byte-identical (no oscillating rebuilds).
    const withReviewTimeout = (
      base: MigrationInput,
      seconds: number | undefined
    ): MigrationInput => ({
      ...base,
      nodes: base.nodes?.map((node) =>
        node.name === 'Review'
          ? { ...node, requireCodexApproval: true, codexTimeoutSeconds: seconds }
          : node
      ),
    });

    const initial = migrateWorkflowGateProgressionToHooks(
      withReviewTimeout({ ...CODING_WITH_QA_WORKFLOW, ...QA_TEMPLATE_PROPS }, 300)
    ).workflow;
    expect(scriptSource(hookBetween(initial, 'Review', 'QA'))).toContain('-lt 300 ');

    const rebuilt = migrateWorkflowGateProgressionToHooks(
      withReviewTimeout({ ...initial, ...QA_TEMPLATE_PROPS }, 900)
    ).workflow;
    const rebuiltSource = scriptSource(hookBetween(rebuilt, 'Review', 'QA'));
    expect(rebuiltSource).toContain('-lt 900 ');
    expect(rebuiltSource).not.toContain('-lt 300 ');
    expect(rebuiltSource).toContain('15-minute timeout');

    const replay = migrateWorkflowGateProgressionToHooks(
      withReviewTimeout({ ...rebuilt, ...QA_TEMPLATE_PROPS }, 900)
    );
    expect(replay.workflow).toEqual(rebuilt);
    expect(replay.warnings).toEqual([]);
  });
});

describe('migrateWorkflowGateProgressionToHooks retains transition-referenced gates', () => {
  it('keeps a gate referenced by a handoff transition even when its channel migrates', () => {
    // A gate shared between a migrating channel (review-posted-gate) and a
    // handoff transition must be retained — otherwise the channel's migration
    // drops the gate and the transition's gateId dangles.
    const input = {
      name: 'Transition Gate Retain',
      nodes: [
        {
          id: 'n1',
          name: 'Coding',
          agents: [{ agentId: 'a1', name: 'coder' }],
          transitions: [{ id: 'to-review', target: 'Review', gateId: 'review-posted-gate' }],
        },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
      ],
      channels: [{ id: 'ch', from: 'Coding', to: 'Review', gateId: 'review-posted-gate' }],
      gates: [{ id: 'review-posted-gate', resetOnCycle: false }],
      hooks: [],
      templateGates: [],
    } as unknown as MigrationInput;
    const out = migrateWorkflowGateProgressionToHooks(input);
    expect(out.workflow.gates?.some((g) => g.id === 'review-posted-gate')).toBe(true);
    expect(out.workflow.nodes?.[0].transitions?.[0].gateId).toBe('review-posted-gate');
  });

  it('shape-guards a malformed transitions payload without throwing', () => {
    // The transition scan runs before validateTransitions; a non-array or
    // non-object element must not crash the migration.
    const input = {
      name: 'Malformed Transitions',
      nodes: [
        {
          id: 'n1',
          name: 'Coding',
          agents: [{ agentId: 'a1', name: 'coder' }],
          transitions: { not: 'array' } as unknown,
        },
      ],
      channels: [],
      gates: [],
      hooks: [],
      templateGates: [],
    } as unknown as MigrationInput;
    expect(() => migrateWorkflowGateProgressionToHooks(input)).not.toThrow();
  });
});
