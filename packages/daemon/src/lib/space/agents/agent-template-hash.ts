/**
 * Agent Template Hash Utility
 *
 * Computes a deterministic canonical hash of a preset agent's template
 * fingerprint for drift detection. Mirrors the workflow `template-hash.ts`
 * utility, but for the small handful of fields that are seeded onto preset
 * `SpaceAgent` rows by `seedPresetAgents()`.
 *
 * The fingerprint covers `name` (lowercased, trimmed), `description`, the
 * `tools` array (sorted), and `customPrompt`. Runtime/identity fields like
 * `id`, `spaceId`, `model`, `provider`, `thinkingLevel`, `createdAt`,
 * `updatedAt` are NOT included — they vary per-space (or are user
 * preferences) and have nothing to do with what the preset definition says
 * the agent should look like.
 */

/**
 * The shape of a preset agent that participates in fingerprinting.
 *
 * `tools` is required (use `[]` for an empty list) so the hash is stable
 * across callers that pass an empty array vs. omitting the field.
 */
export interface AgentTemplateInput {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
}

/**
 * Canonical shape used for hashing — uses only template-portable fields.
 *
 * Field order matters because we hash a `JSON.stringify(...)` of this
 * object. Keep the keys in this fixed order; do NOT sort them.
 */
export interface AgentTemplateFingerprint {
  /** Lowercased + trimmed agent name. */
  name: string;
  /** Description as-supplied (already canonical text). */
  description: string;
  /** Tools sorted alphabetically for stability across array orderings. */
  tools: string[];
  /** Custom prompt verbatim — case + whitespace are part of the identity. */
  customPrompt: string;
}

/**
 * Build the canonical fingerprint of a preset agent. Useful for tests that
 * want to assert the shape *before* hashing.
 */
export function buildAgentTemplateFingerprint(agent: AgentTemplateInput): AgentTemplateFingerprint {
  return {
    name: (agent.name ?? '').trim().toLowerCase(),
    description: agent.description ?? '',
    tools: [...(agent.tools ?? [])].sort(),
    customPrompt: agent.customPrompt ?? '',
  };
}

/**
 * Compute the SHA-256 hex hash of a preset agent's canonical fingerprint.
 * Used to track template versions and detect drift between the preset
 * definition in code and what was persisted on a space's `space_agents` row.
 */
export function computeAgentTemplateHash(agent: AgentTemplateInput): string {
  const fp = buildAgentTemplateFingerprint(agent);
  const json = JSON.stringify(fp);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(json);
  return hasher.digest('hex');
}

/**
 * Returns true when two preset agent definitions hash to the same value.
 */
export function agentTemplatesMatch(a: AgentTemplateInput, b: AgentTemplateInput): boolean {
  return computeAgentTemplateHash(a) === computeAgentTemplateHash(b);
}
