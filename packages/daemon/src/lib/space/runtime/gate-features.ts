import { hasCodexReviewBotFeature } from '@neokai/shared';
import type { Gate, GatePoll, GateScript } from '@neokai/shared';

export const CODEX_REVIEW_BOT_TIMEOUT_SECONDS = 600;
export const CODEX_REVIEW_BOT_POLL_INTERVAL_MS = 60_000;

const CODEX_REVIEW_BOT_SCRIPT = [
  'PR_URL=$(jq -r \'.pr_url // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
  'if [ -z "$PR_URL" ]; then',
  '  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
  'fi',
  'if [ -z "$PR_URL" ]; then',
  '  echo "No PR URL available to verify codex[bot] reaction. Provide pr_url gate data or run from a PR branch." >&2',
  '  exit 1',
  'fi',
  'if [[ ! "$PR_URL" =~ github\\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then',
  '  echo "Unsupported PR URL for codex[bot] reaction check: ${PR_URL}" >&2',
  '  exit 1',
  'fi',
  'OWNER="${BASH_REMATCH[1]}"',
  'REPO="${BASH_REMATCH[2]}"',
  'NUMBER="${BASH_REMATCH[3]}"',
  'if ! REACTIONS_JSON=$(gh api "repos/${OWNER}/${REPO}/issues/${NUMBER}/reactions?per_page=100" -H "Accept: application/vnd.github+json"); then',
  '  echo "Failed to fetch PR reactions for ${PR_URL}" >&2',
  '  exit 1',
  'fi',
  'CODEX_PLUS_ONE_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "+1")] | length\' <<< "$REACTIONS_JSON")',
  'if [ "$CODEX_PLUS_ONE_COUNT" != "0" ] && [ -n "$CODEX_PLUS_ONE_COUNT" ]; then',
  '  jq -n --arg url "$PR_URL" \'{"pr_url":$url,"codex_bot_reaction":"+1"}\'',
  '  exit 0',
  'fi',
  'CODEX_EYES_COUNT=$(jq \'[.[] | select(.user.login == "codex[bot]" and .content == "eyes")] | length\' <<< "$REACTIONS_JSON")',
  'START_ISO="${NEOKAI_WORKFLOW_START_ISO:-}"',
  'if [ -n "$START_ISO" ]; then',
  `  START_EPOCH=$(bun -e 'const t=Date.parse(process.argv[1]); if (Number.isNaN(t)) process.exit(1); console.log(Math.floor(t / 1000));' "$START_ISO" 2>/dev/null || true)`,
  '  NOW_EPOCH=$(date +%s)',
  `  if [ -n "$START_EPOCH" ] && [ $((NOW_EPOCH - START_EPOCH)) -ge ${CODEX_REVIEW_BOT_TIMEOUT_SECONDS} ]; then`,
  '    jq -n --arg url "$PR_URL" --arg status "timeout" \'{"pr_url":$url,"codex_bot_reaction":$status,"codex_bot_warning":"codex[bot] +1 reaction missing after timeout; allowing gate"}\'',
  '    exit 0',
  '  fi',
  'fi',
  'if [ "$CODEX_EYES_COUNT" != "0" ] && [ -n "$CODEX_EYES_COUNT" ]; then',
  '  echo "codex[bot] review still in progress (eyes reaction present); wait for +1 on ${PR_URL}" >&2',
  'else',
  '  echo "codex[bot] has not started or has not reported on ${PR_URL}; comment `@codex review` on the PR, then wait for an eyes or +1 reaction" >&2',
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

export function getEffectiveGate(gate: Gate): Gate {
  if (!hasCodexReviewBotFeature(gate)) return gate;
  return {
    ...gate,
    script: getCodexReviewBotGateScript(),
    poll: getCodexReviewBotGatePoll(),
  };
}

export function getEffectiveGatePoll(gate: Gate): GatePoll | undefined {
  if (hasCodexReviewBotFeature(gate)) return getCodexReviewBotGatePoll();
  return gate.poll;
}
