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
  'if [[ ! "$PR_URL" =~ ^https://[^/]+/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then',
  '  echo "Unsupported PR URL for codex[bot] reaction check: ${PR_URL}" >&2',
  '  exit 1',
  'fi',
  'OWNER="${BASH_REMATCH[1]}"',
  'REPO="${BASH_REMATCH[2]}"',
  'NUMBER="${BASH_REMATCH[3]}"',
  'REACTIONS_RAW=$(gh api --paginate "repos/${OWNER}/${REPO}/issues/${NUMBER}/reactions?per_page=100" -H "Accept: application/vnd.github+json")',
  'if [ $? -ne 0 ]; then',
  '  echo "Failed to fetch PR reactions for ${PR_URL}" >&2',
  '  exit 1',
  'fi',
  'REACTIONS_JSON=$(jq -s \'add // []\' <<< "$REACTIONS_RAW")',
  // Timeout is based only on gate-data update time (no fallback), so the
  // timeout does not start until the reviewer writes approval data.
  'TIMEOUT_ISO="${NEOKAI_GATE_DATA_UPDATED_ISO:-}"',
  // Freshness uses gate-data update time with workflow-start fallback.
  'FRESHNESS_ISO="${NEOKAI_GATE_DATA_UPDATED_ISO:-${NEOKAI_WORKFLOW_START_ISO:-}}"',
  // Use the PR head commit timestamp as the freshness anchor so multi-writer
  // gates (e.g. plan-approval-gate) do not treat a codex +1 as stale when the
  // last vote updates the gate data row. Falls back to FRESHNESS_ISO when the
  // PR API is unavailable (e.g. deleted fork).
  'HEAD_SHA=$(gh api "repos/${OWNER}/${REPO}/pulls/${NUMBER}" -q \'.head.sha\' 2>/dev/null || true)',
  'if [ -n "$HEAD_SHA" ]; then',
  '  HEAD_COMMIT_DATE=$(gh api "repos/${OWNER}/${REPO}/commits/${HEAD_SHA}" -q \'.commit.committer.date\' 2>/dev/null || true)',
  'fi',
  'FRESHNESS_ISO="${HEAD_COMMIT_DATE:-${FRESHNESS_ISO}}"',
  'if [ -n "$FRESHNESS_ISO" ]; then',
  '  FRESH_REACTIONS=$(jq --arg start "$FRESHNESS_ISO" \'[.[] | select(.created_at >= $start)]\' <<< "$REACTIONS_JSON")',
  'else',
  '  FRESH_REACTIONS="$REACTIONS_JSON"',
  'fi',
  // Timeout check uses TIMEOUT_ISO only (no workflow-start fallback).
  'if [ -n "$TIMEOUT_ISO" ]; then',
  `  START_EPOCH=$(bun -e 'const t=Date.parse(process.argv[1]); if (Number.isNaN(t)) process.exit(1); console.log(Math.floor(t / 1000));' "$TIMEOUT_ISO" 2>/dev/null || true)`,
  '  NOW_EPOCH=$(date +%s)',
  `  if [ -n "$START_EPOCH" ] && [ $((NOW_EPOCH - START_EPOCH)) -ge ${CODEX_REVIEW_BOT_TIMEOUT_SECONDS} ]; then`,
  '    jq -n --arg url "$PR_URL" --arg status "timeout" \'{"pr_url":$url,"codex_bot_reaction":$status,"codex_bot_warning":"codex[bot] +1 reaction missing after timeout; allowing gate"}\'',
  '    exit 0',
  '  fi',
  'fi',
  'CODEX_PLUS_ONE_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "+1")] | length\' <<< "$FRESH_REACTIONS")',
  'if [ "$CODEX_PLUS_ONE_COUNT" != "0" ] && [ -n "$CODEX_PLUS_ONE_COUNT" ]; then',
  '  jq -n --arg url "$PR_URL" \'{"pr_url":$url,"codex_bot_reaction":"+1"}\'',
  '  exit 0',
  'fi',
  'CODEX_EYES_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "eyes")] | length\' <<< "$FRESH_REACTIONS")',
  'if [ "$CODEX_EYES_COUNT" != "0" ] && [ -n "$CODEX_EYES_COUNT" ]; then',
  '  echo "codex[bot] review still in progress (eyes reaction present); wait for +1 on ${PR_URL}" >&2',
  'else',
  '  echo "codex[bot] has not started or has not reported on ${PR_URL}; comment \'@codex review\' on the PR, then wait for an eyes or +1 reaction" >&2',
  'fi',
  'exit 1',
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
    script: CODEX_REVIEW_BOT_SCRIPT,
    messageTemplate: 'codex[bot] reaction status update:\n{{output}}',
  };
}

registerGateFeature(CODEX_REVIEW_BOT_FEATURE, {
  script: getCodexReviewBotGateScript,
  poll: getCodexReviewBotGatePoll,
});

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
