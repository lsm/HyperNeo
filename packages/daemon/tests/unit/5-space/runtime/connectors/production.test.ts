/**
 * Production connector wiring tests (epic #2299, P1 #2301).
 *
 * Locks in the L2 contract the engine now depends on:
 *   - the github connector is registered in production,
 *   - its auth surface matches the legacy `GITHUB_LOOKUP_ENV_KEYS` (so script-hook
 *     credential injection is behavior-identical pre/post connectors),
 *   - built-in validators declare their connector deps through the registry
 *     (no hardcoded `'github'` in the engine), and
 *   - the legacy fallback admits `'github'` when the connectors layer is off.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Connector } from '../../../../../src/lib/space/runtime/connectors/connector';
import {
  clearConnectorRegistry,
  getConnector,
  getRegisteredConnectorIds,
  isRegisteredConnector,
  registerConnector,
} from '../../../../../src/lib/space/runtime/connectors/connector';
import { GITHUB_CONNECTOR_ID } from '../../../../../src/lib/space/runtime/connectors/github-connector';
import {
  clearBuiltInConnectorDeps,
  getBuiltInConnectorDeps,
  registerProductionConnectors,
} from '../../../../../src/lib/space/runtime/connectors/production';
import { validateWorkflowHooks } from '../../../../../src/lib/space/workflow-hook-validation';
import type { WorkflowHook, WorkflowNodeInput } from '@hyperneo/shared';

/**
 * Snapshot/restore the global connector registry around each test so this file
 * is robust to other test files in the shard mutating (or clearing) it. The
 * registry is a module-level Map; snapshotting the production state and
 * restoring it in afterEach avoids fragile manual re-seed ordering.
 */
function snapshotRegistry(): Connector[] {
  return getRegisteredConnectorIds()
    .map((id) => getConnector(id))
    .filter((c): c is Connector => c !== undefined);
}

let registrySnapshot: Connector[] = [];

/** The exact surface the legacy `GITHUB_LOOKUP_ENV_KEYS` injected. */
const EXPECTED_GITHUB_SANDBOX_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
];

const nodes: WorkflowNodeInput[] = [
  { id: 'n1', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
  { id: 'n2', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
];

function scriptHook(externalLookups: string[]): WorkflowHook {
  return {
    id: 'hook-1',
    enabled: true,
    sourceNode: 'Coding',
    targetNode: 'Review',
    method: 'send_message',
    validator: {
      kind: 'script',
      interpreter: 'bash',
      source: 'echo \'{"type":"allow"}\'',
      externalLookups,
    },
    authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
  };
}

describe('production connector wiring', () => {
  beforeAll(() => {
    // Reset BOTH module-level maps (connector registry + built-in deps) for a
    // clean slate, then re-seed production state — models the symmetric
    // clearConnectorRegistry()/clearBuiltInConnectorDeps() test contract.
    clearConnectorRegistry();
    clearBuiltInConnectorDeps();
    registerProductionConnectors();
    registrySnapshot = snapshotRegistry();
  });

  afterEach(() => {
    clearConnectorRegistry();
    for (const connector of registrySnapshot) registerConnector(connector);
    delete process.env.HYPERNEO_WORKFLOW_CONNECTORS;
  });

  test('registers the github connector', () => {
    expect(isRegisteredConnector(GITHUB_CONNECTOR_ID)).toBe(true);
    expect(getRegisteredConnectorIds()).toContain(GITHUB_CONNECTOR_ID);
    expect(getConnector(GITHUB_CONNECTOR_ID)?.id).toBe(GITHUB_CONNECTOR_ID);
  });

  test('github connector declares the legacy sandbox env-key surface', () => {
    const auth = getConnector(GITHUB_CONNECTOR_ID)?.auth;
    expect(auth).toBeDefined();
    expect(auth?.envKeys).toEqual(EXPECTED_GITHUB_SANDBOX_ENV_KEYS);
    expect(typeof auth?.resolveExtraEnv).toBe('function');
  });

  test('built-in github presets declare their connector dependency via the registry', () => {
    expect(getBuiltInConnectorDeps('pr_ready')).toEqual([GITHUB_CONNECTOR_ID]);
    expect(getBuiltInConnectorDeps('pr_merged')).toEqual([GITHUB_CONNECTOR_ID]);
    // Other built-ins carry no external-state dependency.
    expect(getBuiltInConnectorDeps('pr_open')).toEqual([]);
    expect(getBuiltInConnectorDeps('artifact_exists')).toEqual([]);
  });

  test('validation admits registered connectors and rejects unknown ones', () => {
    expect(validateWorkflowHooks([scriptHook(['github'])], nodes)).toEqual([]);
    const errors = validateWorkflowHooks([scriptHook(['gitlab'])], nodes).join('\n');
    expect(errors).toContain('"gitlab" is not a registered connector');
  });

  test('legacy fallback admits "github" when the connectors layer is disabled', () => {
    const previous = process.env.HYPERNEO_WORKFLOW_CONNECTORS;
    process.env.HYPERNEO_WORKFLOW_CONNECTORS = '0';
    try {
      clearConnectorRegistry();
      // With the layer off + registry empty, the legacy literal still admits
      // 'github' so a rollback never breaks existing workflows.
      expect(validateWorkflowHooks([scriptHook(['github'])], nodes)).toEqual([]);
      const errors = validateWorkflowHooks([scriptHook(['gitlab'])], nodes).join('\n');
      expect(errors).toContain('"gitlab" is not a registered connector');
    } finally {
      if (previous === undefined) delete process.env.HYPERNEO_WORKFLOW_CONNECTORS;
      else process.env.HYPERNEO_WORKFLOW_CONNECTORS = previous;
    }
  });
});
