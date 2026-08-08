import { hasEnabledGateFeature } from '@hyperneo/shared';
import type { Gate, GatePoll, GateScript } from '@hyperneo/shared';

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

/**
 * Validates that a gate does not enable multiple features that define the same
 * runtime artifact (script or poll). Returns an array of error strings.
 *
 * NOTE: the `codex_review_bot` feature was the ONLY registered gate feature and
 * has been removed (epic #2299 #2304) — codex approval is now a declarative
 * `codex_review_approved` preset over the github connector. The registry is
 * intentionally empty; this generic mechanism remains for any future feature
 * registrant, and the engine special-cases no feature id.
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
