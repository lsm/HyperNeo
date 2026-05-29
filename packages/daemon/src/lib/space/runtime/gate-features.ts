import { hasEnabledGateFeature } from '@neokai/shared';
import type { Gate, GatePoll, GateScript } from '@neokai/shared';

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

export const CODEX_REVIEW_BOT_FEATURE = 'codex_review_bot';
export const CODEX_REVIEW_BOT_TIMEOUT_SECONDS = 600;
export const CODEX_REVIEW_BOT_POLL_INTERVAL_MS = 60_000;

const CODEX_REVIEW_BOT_SCRIPT = [
  'GATE_PR_URL=$(jq -r \'.pr_url // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
  'PR_URL="${GATE_PR_URL:-${PR_URL:-}}"',
  'if [ -z "$PR_URL" ]; then',
  '  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
  'fi',
  'if [ -z "$PR_URL" ]; then',
  '  echo "No PR URL available to verify codex[bot] reaction. Provide pr_url gate data or run from a PR branch." >&2',
  '  exit 1',
  'fi',
  'if [[ ! "$PR_URL" =~ ^https://([^/]+)/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then',
  '  echo "Unsupported PR URL for codex[bot] reaction check: ${PR_URL}" >&2',
  '  exit 1',
  'fi',
  'PR_HOST="${BASH_REMATCH[1]}"',
  'OWNER="${BASH_REMATCH[2]}"',
  'REPO="${BASH_REMATCH[3]}"',
  'NUMBER="${BASH_REMATCH[4]}"',
  // SSRF protection: validate extracted host against an allowlist so a
  // compromised agent cannot redirect the gh API call to an attacker host.
  'ALLOWED=false',
  'for host in "github.com" "${GH_HOST:-}"; do',
  '  if [ -n "$host" ] && [ "$PR_HOST" = "$host" ]; then',
  '    ALLOWED=true',
  '    break',
  '  fi',
  'done',
  'if [ "$ALLOWED" != "true" ]; then',
  '  echo "Disallowed host for codex[bot] reaction check: ${PR_HOST}" >&2',
  '  exit 1',
  'fi',
  'GH_HOST_ARGS=()',
  'if [ -n "$PR_HOST" ]; then GH_HOST_ARGS=(--hostname "$PR_HOST"); fi',
  'REACTIONS_RAW=$(gh api --paginate "${GH_HOST_ARGS[@]}" "repos/${OWNER}/${REPO}/issues/${NUMBER}/reactions?per_page=100" -H "Accept: application/vnd.github+json")',
  'if [ $? -ne 0 ]; then',
  '  echo "Failed to fetch PR reactions for ${PR_URL}" >&2',
  '  exit 1',
  'fi',
  'REACTIONS_JSON=$(jq -s \'add // []\' <<< "$REACTIONS_RAW")',
  // Timeout is based only on gate-data update time (no fallback), so the
  // timeout does not start until the reviewer writes approval data.
  'TIMEOUT_ISO="${NEOKAI_GATE_DATA_UPDATED_ISO:-}"',
  // Per-cycle freshness anchor: cycle_start_at from gate data (set on init and
  // cyclic reset) so reactions from prior cycles are filtered out. Falls back
  // to workflow start for gates that have not been written to yet.
  'CYCLE_START_MS=$(jq -r \'.cycle_start_at // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
  'if [ -n "$CYCLE_START_MS" ]; then',
  `  FRESHNESS_ISO=$(bun -e 'const d=new Date(parseInt(process.argv[1])); if(Number.isNaN(d.getTime())) process.exit(1); console.log(d.toISOString());' "$CYCLE_START_MS" 2>/dev/null || true)`,
  'else',
  '  FRESHNESS_ISO="${NEOKAI_WORKFLOW_START_ISO:-}"',
  'fi',
  // GitHub created_at is second-precision; normalize JS millisecond ISO to match.
  'if [ -n "$FRESHNESS_ISO" ] && [[ "$FRESHNESS_ISO" =~ \\.[0-9]+Z$ ]]; then',
  '  FRESHNESS_ISO="${FRESHNESS_ISO%.*}Z"',
  'fi',
  // Resolve current PR head for inclusion in success output (audit trail).
  'HEAD_SHA=$(gh api "${GH_HOST_ARGS[@]}" "repos/${OWNER}/${REPO}/pulls/${NUMBER}" -q \'.head.sha\' 2>/dev/null || true)',
  'if [ -n "$FRESHNESS_ISO" ]; then',
  '  FRESH_REACTIONS=$(jq --arg start "$FRESHNESS_ISO" \'[.[] | select(.created_at >= $start)]\' <<< "$REACTIONS_JSON")',
  'else',
  '  FRESH_REACTIONS="$REACTIONS_JSON"',
  'fi',
  // Check fresh +1 before timeout so a late +1 is reported as a pass, not a timeout.
  'CODEX_PLUS_ONE_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "+1")] | length\' <<< "$FRESH_REACTIONS")',
  'if [ "$CODEX_PLUS_ONE_COUNT" != "0" ] && [ -n "$CODEX_PLUS_ONE_COUNT" ]; then',
  '  jq -n --arg url "$PR_URL" --arg sha "${HEAD_SHA}" \'{"pr_url":$url,"codex_bot_reaction":"+1","head_sha":$sha}\'',
  '  exit 0',
  'fi',
  // Timeout check uses TIMEOUT_ISO only (no workflow-start fallback).
  'if [ -n "$TIMEOUT_ISO" ]; then',
  `  START_EPOCH=$(bun -e 'const t=Date.parse(process.argv[1]); if (Number.isNaN(t)) process.exit(1); console.log(Math.floor(t / 1000));' "$TIMEOUT_ISO" 2>/dev/null || true)`,
  '  NOW_EPOCH=$(date +%s)',
  `  if [ -n "$START_EPOCH" ] && [ $((NOW_EPOCH - START_EPOCH)) -ge ${CODEX_REVIEW_BOT_TIMEOUT_SECONDS} ]; then`,
  '    jq -n --arg url "$PR_URL" --arg status "timeout" --arg sha "${HEAD_SHA}" \'{"pr_url":$url,"codex_bot_reaction":$status,"head_sha":$sha,"codex_bot_warning":"codex[bot] +1 reaction missing after timeout; allowing gate"}\'',
  '    exit 0',
  '  fi',
  'fi',
  'CODEX_EYES_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "eyes")] | length\' <<< "$FRESH_REACTIONS")',
  'if [ "$CODEX_EYES_COUNT" != "0" ] && [ -n "$CODEX_EYES_COUNT" ]; then',
  '  echo "codex[bot] review still in progress (eyes reaction present); wait for +1 on ${PR_URL}" >&2',
  'else',
  '  echo "codex[bot] has not started or has not reported on ${PR_URL}; comment \'@codex review\' on the PR, then wait for an eyes or +1 reaction" >&2',
  'fi',
  'exit 1',
].join('\n');

// Poll variant: emits pending statuses to stdout (exit 0) so GatePollManager
// can inject guidance to the reviewer while waiting. Success/timeout paths
// are identical to the gate script.
const CODEX_REVIEW_BOT_POLL_SCRIPT = [
  'GATE_PR_URL=$(jq -r \'.pr_url // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
  'PR_URL="${GATE_PR_URL:-${PR_URL:-}}"',
  'if [ -z "$PR_URL" ]; then',
  '  echo "No PR URL available to verify codex[bot] reaction. Provide pr_url gate data or run from a PR branch."',
  '  exit 0',
  'fi',
  'if [[ ! "$PR_URL" =~ ^https://([^/]+)/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then',
  '  echo "Unsupported PR URL for codex[bot] reaction check: ${PR_URL}"',
  '  exit 0',
  'fi',
  'PR_HOST="${BASH_REMATCH[1]}"',
  'OWNER="${BASH_REMATCH[2]}"',
  'REPO="${BASH_REMATCH[3]}"',
  'NUMBER="${BASH_REMATCH[4]}"',
  // SSRF protection: validate extracted host against an allowlist so a
  // compromised agent cannot redirect the gh API call to an attacker host.
  'ALLOWED=false',
  'for host in "github.com" "${GH_HOST:-}"; do',
  '  if [ -n "$host" ] && [ "$PR_HOST" = "$host" ]; then',
  '    ALLOWED=true',
  '    break',
  '  fi',
  'done',
  'if [ "$ALLOWED" != "true" ]; then',
  '  echo "Disallowed host for codex[bot] reaction check: ${PR_HOST}" >&2',
  '  exit 1',
  'fi',
  'GH_HOST_ARGS=()',
  'if [ -n "$PR_HOST" ]; then GH_HOST_ARGS=(--hostname "$PR_HOST"); fi',
  'REACTIONS_RAW=$(gh api --paginate "${GH_HOST_ARGS[@]}" "repos/${OWNER}/${REPO}/issues/${NUMBER}/reactions?per_page=100" -H "Accept: application/vnd.github+json")',
  'if [ $? -ne 0 ]; then',
  '  echo "Failed to fetch PR reactions for ${PR_URL}"',
  '  exit 0',
  'fi',
  'REACTIONS_JSON=$(jq -s \'add // []\' <<< "$REACTIONS_RAW")',
  'TIMEOUT_ISO="${NEOKAI_GATE_DATA_UPDATED_ISO:-}"',
  'CYCLE_START_MS=$(jq -r \'.cycle_start_at // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
  'if [ -n "$CYCLE_START_MS" ]; then',
  `  FRESHNESS_ISO=$(bun -e 'const d=new Date(parseInt(process.argv[1])); if(Number.isNaN(d.getTime())) process.exit(1); console.log(d.toISOString());' "$CYCLE_START_MS" 2>/dev/null || true)`,
  'else',
  '  FRESHNESS_ISO="${NEOKAI_WORKFLOW_START_ISO:-}"',
  'fi',
  'if [ -n "$FRESHNESS_ISO" ] && [[ "$FRESHNESS_ISO" =~ \\.[0-9]+Z$ ]]; then',
  '  FRESHNESS_ISO="${FRESHNESS_ISO%.*}Z"',
  'fi',
  'HEAD_SHA=$(gh api "${GH_HOST_ARGS[@]}" "repos/${OWNER}/${REPO}/pulls/${NUMBER}" -q \'.head.sha\' 2>/dev/null || true)',
  'if [ -n "$FRESHNESS_ISO" ]; then',
  '  FRESH_REACTIONS=$(jq --arg start "$FRESHNESS_ISO" \'[.[] | select(.created_at >= $start)]\' <<< "$REACTIONS_JSON")',
  'else',
  '  FRESH_REACTIONS="$REACTIONS_JSON"',
  'fi',
  'CODEX_PLUS_ONE_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "+1")] | length\' <<< "$FRESH_REACTIONS")',
  'if [ "$CODEX_PLUS_ONE_COUNT" != "0" ] && [ -n "$CODEX_PLUS_ONE_COUNT" ]; then',
  '  jq -n --arg url "$PR_URL" --arg sha "${HEAD_SHA}" \'{"pr_url":$url,"codex_bot_reaction":"+1","head_sha":$sha}\'',
  '  exit 0',
  'fi',
  'if [ -n "$TIMEOUT_ISO" ]; then',
  `  START_EPOCH=$(bun -e 'const t=Date.parse(process.argv[1]); if (Number.isNaN(t)) process.exit(1); console.log(Math.floor(t / 1000));' "$TIMEOUT_ISO" 2>/dev/null || true)`,
  '  NOW_EPOCH=$(date +%s)',
  `  if [ -n "$START_EPOCH" ] && [ $((NOW_EPOCH - START_EPOCH)) -ge ${CODEX_REVIEW_BOT_TIMEOUT_SECONDS} ]; then`,
  '    jq -n --arg url "$PR_URL" --arg status "timeout" --arg sha "${HEAD_SHA}" \'{"pr_url":$url,"codex_bot_reaction":$status,"head_sha":$sha,"codex_bot_warning":"codex[bot] +1 reaction missing after timeout; allowing gate"}\'',
  '    exit 0',
  '  fi',
  'fi',
  'CODEX_EYES_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "eyes")] | length\' <<< "$FRESH_REACTIONS")',
  'if [ "$CODEX_EYES_COUNT" != "0" ] && [ -n "$CODEX_EYES_COUNT" ]; then',
  '  echo "codex[bot] review still in progress (eyes reaction present); wait for +1 on ${PR_URL}"',
  'else',
  '  echo "codex[bot] has not started or has not reported on ${PR_URL}; comment \'@codex review\' on the PR, then wait for an eyes or +1 reaction"',
  'fi',
  'exit 0',
].join('\n');

export function getCodexReviewBotGateScript(): GateScript {
  return {
    interpreter: 'bash',
    source: CODEX_REVIEW_BOT_SCRIPT,
    timeoutMs: 30000,
  };
}

export function getCodexReviewBotGatePoll(): GatePoll {
  return {
    intervalMs: CODEX_REVIEW_BOT_POLL_INTERVAL_MS,
    target: 'from',
    script: CODEX_REVIEW_BOT_POLL_SCRIPT,
    messageTemplate: 'codex[bot] reaction status update:\n{{output}}',
  };
}

registerGateFeature(CODEX_REVIEW_BOT_FEATURE, {
  script: getCodexReviewBotGateScript,
  poll: getCodexReviewBotGatePoll,
});

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

export function getEffectiveGate(gate: Gate): Gate {
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

export function getEffectiveGatePoll(gate: Gate): GatePoll | undefined {
  const pollDefinition = getEnabledGateFeatureDefinitions(gate).find(
    (definition) => definition.poll
  );
  return pollDefinition?.poll?.() ?? gate.poll;
}
