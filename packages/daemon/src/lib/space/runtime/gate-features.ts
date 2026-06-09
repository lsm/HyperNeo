import { hasEnabledGateFeature } from '@neokai/shared';
import type { Gate, GatePoll, GateScript, SpaceWorkflow } from '@neokai/shared';

export interface GateFeatureDefinition {
  script?: () => GateScript;
  poll?: () => GatePoll;
}

const gateFeatureRegistry = new Map<string, GateFeatureDefinition>();

export function registerGateFeature(name: string, definition: GateFeatureDefinition): void {
  gateFeatureRegistry.set(name, definition);
}

export function isRegisteredGateFeature(name: string): boolean {
  return gateFeatureRegistry.has(name);
}

export function hasRegisteredGateFeatures(
  gate: { features?: Gate['features'] } | undefined
): boolean {
  return Object.keys(gate?.features ?? {}).some(
    (name) => hasEnabledGateFeature(gate, name) && isRegisteredGateFeature(name)
  );
}

function getEnabledGateFeatureDefinitions(gate: Gate): GateFeatureDefinition[] {
  return Object.keys(gate.features ?? {})
    .filter((name) => hasEnabledGateFeature(gate, name))
    .map((name) => gateFeatureRegistry.get(name))
    .filter((definition): definition is GateFeatureDefinition => !!definition);
}

/**
 * Validates that a gate does not enable multiple features that define the same
 * runtime artifact (script or poll). Returns an array of error strings.
 */
export function validateGateFeatures(gate: Gate): string[] {
  const errors: string[] = [];
  const enabledNames = Object.keys(gate.features ?? {}).filter((name) =>
    hasEnabledGateFeature(gate, name)
  );
  const scriptFeatures = enabledNames.filter((name) => gateFeatureRegistry.get(name)?.script);
  const pollFeatures = enabledNames.filter((name) => gateFeatureRegistry.get(name)?.poll);
  if (scriptFeatures.length > 1) {
    errors.push(
      `gate: multiple features define a script (${scriptFeatures.join(', ')}); only one script feature is allowed per gate`
    );
  }
  if (pollFeatures.length > 1) {
    errors.push(
      `gate: multiple features define a poll (${pollFeatures.join(', ')}); only one poll feature is allowed per gate`
    );
  }
  return errors;
}

export function isApprovalGate(gate: Gate): boolean {
  return (gate.fields ?? []).some((f) => {
    const check = f.check as { op?: unknown; match?: unknown; value?: unknown } | undefined;
    if (f.name === 'approved') return true;
    if (f.type === 'boolean' && check?.op === '==' && check.value === true) return true;
    if (f.type === 'map' && check?.op === 'count' && check.match === 'approved') return true;
    return false;
  });
}

/**
 * Returns true when the gate has a script or poll injected by a registered
 * gate feature.
 */
export function hasInjectedGateFeature(
  gate: Gate,
  _workflow?: SpaceWorkflow,
  _sourceNodeName?: string
): boolean {
  return hasRegisteredGateFeatures(gate);
}

export function getEffectiveGate(
  gate: Gate,
  _workflow?: SpaceWorkflow,
  _sourceNodeName?: string
): Gate {
  const definitions = getEnabledGateFeatureDefinitions(gate);

  const scriptDefinition = definitions.find((definition) => definition.script);
  const pollDefinition = definitions.find((definition) => definition.poll);

  if (!scriptDefinition?.script && !pollDefinition?.poll) return gate;

  return {
    ...gate,
    script: scriptDefinition?.script?.() ?? gate.script,
    poll: pollDefinition?.poll?.() ?? gate.poll,
  };
}

export function getEffectiveGatePoll(
  gate: Gate,
  _workflow?: SpaceWorkflow,
  _sourceNodeName?: string
): GatePoll | undefined {
  const definitions = getEnabledGateFeatureDefinitions(gate);

  const pollDefinition = definitions.find((definition) => definition.poll);
  return pollDefinition?.poll?.() ?? gate.poll;
}
