/**
 * Verbatim reconstruction of the PRE-#2409 combined codex-bearing approval hook
 * script builders, which PR #2409 deleted when it moved the codex +1 check out
 * of the approval bash into a separate declarative `codex_review_approved` hook.
 * The migration-replay suite calls these to produce the genuine legacy artifact
 * (the full inline 2h codex wait + gh-api reaction lookup) so the re-emit-pass
 * upgrade is pinned against the real persisted shape, not a stand-in.
 *
 * Copied verbatim from commit d37196f0f (packages/daemon/src/lib/space/workflows/
 * workflow-migration.ts); the only edits are the export, the rename, and
 * inlining the 7200s default (the env-overridable constant was deleted by
 * #2409). Do not edit by hand — re-extract from that commit if the legacy shape
 * must be updated.
 */

function formatCodexTimeoutLabel(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

export function buildLegacyApprovalsScript(timeoutSeconds: number = 7200): string {
  const label = formatCodexTimeoutLabel(timeoutSeconds);
  return [
    'STATE=$(jq -c \'.approvals // {}\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || echo {})',
    'WAIT_STARTED=$(jq -r \'.codex_wait_started_at // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'WAIT_HEAD=$(jq -r \'.codex_wait_head_oid // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'INCOMING=$(jq -c \'(.data.approvals // .approvals // {})\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || echo {})',
    'MERGED=$(jq -c -n --argjson a "$STATE" --argjson b "$INCOMING" \'$a * $b\')',
    'COUNT=$(jq \'to_entries | map(select(.value == "approved" or .value == true)) | length\' <<< "$MERGED")',
    'if [ "$COUNT" -lt 4 ]; then jq -n --argjson approvals "$MERGED" --argjson count "$COUNT" \'{"type":"block","reason":"Plan dispatch requires four approved plan-review votes","data":{"approvals":$approvals,"approval_count":$count}}\'; exit 0; fi',
    'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
    'if [ -z "$PR_URL" ]; then echo "Plan approval requires pr_url for Codex validation" >&2; exit 1; fi',
    'if ! PR_JSON=$(gh pr view "$PR_URL" --json number,headRefOid,url 2>/dev/null); then echo "Failed to fetch plan PR for Codex validation" >&2; exit 1; fi',
    'PR_NUMBER=$(jq -r \'.number\' <<< "$PR_JSON")',
    'HEAD_OID=$(jq -r \'.headRefOid // empty\' <<< "$PR_JSON")',
    'PR_API_URL=$(jq -r \'.url // empty\' <<< "$PR_JSON")',
    'PR_HOST=$(sed -E "s#https://([^/]+)/.*#\\1#" <<< "$PR_API_URL")',
    'OWNER=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\1#" <<< "$PR_API_URL")',
    'REPO=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\2#" <<< "$PR_API_URL")',
    'if [ -z "$PR_HOST" ] || [ -z "$OWNER" ] || [ -z "$REPO" ] || [ "$OWNER" = "$PR_API_URL" ]; then echo "Failed to resolve repository from PR URL" >&2; exit 1; fi',
    'ALLOWED_HOST="${GH_HOST:-github.com}"',
    'if [ "$PR_HOST" != "github.com" ] && [ "$PR_HOST" != "$ALLOWED_HOST" ]; then echo "PR host ${PR_HOST} is not allowed for GitHub lookups" >&2; exit 1; fi',
    'COMMENTS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments?per_page=100") || { echo "Failed to fetch Codex comments" >&2; exit 1; }',
    'REACTIONS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/reactions?per_page=100") || { echo "Failed to fetch Codex reactions" >&2; exit 1; }',
    'COMMENT_OK=$(jq --arg head "$HEAD_OID" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and ((.body // "") | contains($head)))] | length\' <<< "$COMMENTS")',
    'REACTION_OK=$(jq \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1")] | length\' <<< "$REACTIONS")',
    'FRESH_REACTION_OK=$(jq --arg since "$WAIT_STARTED" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1" and (.created_at // "") > $since)] | length\' <<< "$REACTIONS")',
    'if [ "$COMMENT_OK" != "0" ] || { [ -n "$WAIT_STARTED" ] && [ "$WAIT_HEAD" = "$HEAD_OID" ] && [ "$FRESH_REACTION_OK" != "0" ]; }; then jq -n --argjson approvals "$MERGED" --argjson reaction_count "$REACTION_OK" --argjson fresh_reaction_count "$FRESH_REACTION_OK" \'{"type":"allow","data":{"approvals":$approvals,"codex_approved":true,"codex_reaction_count":$reaction_count,"codex_fresh_reaction_count":$fresh_reaction_count}}\'; exit 0; fi',
    'NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `if [ -z "$WAIT_STARTED" ] || [ "$WAIT_HEAD" != "$HEAD_OID" ]; then jq -n --argjson approvals "$MERGED" --arg started "$NOW_ISO" --arg head "$HEAD_OID" '{"type":"block","reason":"Plan approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"approvals":$approvals,"approval_count":4,"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'WAIT_STARTED_PARSE=${WAIT_STARTED%%.*}; WAIT_STARTED_PARSE=${WAIT_STARTED_PARSE%Z}Z',
    'START_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$WAIT_STARTED_PARSE" +%s 2>/dev/null || date -u -d "$WAIT_STARTED" +%s 2>/dev/null || echo 0)',
    'NOW_EPOCH=$(date -u +%s)',
    `if [ $((NOW_EPOCH - START_EPOCH)) -lt ${timeoutSeconds} ]; then jq -n --argjson approvals "$MERGED" --arg started "$WAIT_STARTED" --arg head "$HEAD_OID" '{"type":"block","reason":"Plan approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"approvals":$approvals,"approval_count":4,"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'jq -n --argjson approvals "$MERGED" \'{"type":"allow","data":{"approvals":$approvals,"codex_approved":false,"codex_timed_out":true,"codex_warning":"No current-head Codex approval found before timeout"}}\'',
  ].join('\n');
}

export function buildLegacyReviewApprovalScript(timeoutSeconds: number = 7200): string {
  const label = formatCodexTimeoutLabel(timeoutSeconds);
  return [
    'APPROVED=$(jq -r \'(.data.approved // .approved // false)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
    'PR_URL=$(jq -r \'(.data.pr_url // .pr_url // empty)\' <<< "${HYPERNEO_PARAMS_JSON:-{}}" 2>/dev/null || true)',
    'if [ "$APPROVED" != "true" ]; then echo "Review handoff requires approved=true" >&2; exit 1; fi',
    'if [ -z "$PR_URL" ]; then echo "Review approval handoff requires pr_url for Codex validation" >&2; exit 1; fi',
    'WAIT_STARTED=$(jq -r \'.codex_wait_started_at // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'WAIT_HEAD=$(jq -r \'.codex_wait_head_oid // empty\' <<< "${HYPERNEO_HOOK_LOCAL_STATE_JSON:-{}}" 2>/dev/null || true)',
    'if ! PR_JSON=$(gh pr view "$PR_URL" --json number,headRefOid,url 2>/dev/null); then echo "Failed to fetch PR for Codex validation" >&2; exit 1; fi',
    'PR_NUMBER=$(jq -r \'.number\' <<< "$PR_JSON")',
    'HEAD_OID=$(jq -r \'.headRefOid // empty\' <<< "$PR_JSON")',
    'PR_API_URL=$(jq -r \'.url // empty\' <<< "$PR_JSON")',
    'PR_HOST=$(sed -E "s#https://([^/]+)/.*#\\1#" <<< "$PR_API_URL")',
    'OWNER=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\1#" <<< "$PR_API_URL")',
    'REPO=$(sed -E "s#https://[^/]+/([^/]+)/([^/]+)/pull/[0-9]+.*#\\2#" <<< "$PR_API_URL")',
    'if [ -z "$PR_HOST" ] || [ -z "$OWNER" ] || [ -z "$REPO" ] || [ "$OWNER" = "$PR_API_URL" ]; then echo "Failed to resolve repository from PR URL" >&2; exit 1; fi',
    'ALLOWED_HOST="${GH_HOST:-github.com}"',
    'if [ "$PR_HOST" != "github.com" ] && [ "$PR_HOST" != "$ALLOWED_HOST" ]; then echo "PR host ${PR_HOST} is not allowed for GitHub lookups" >&2; exit 1; fi',
    'COMMENTS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments?per_page=100") || { echo "Failed to fetch Codex comments" >&2; exit 1; }',
    'REACTIONS=$(gh api --hostname "$PR_HOST" --paginate --slurp "repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/reactions?per_page=100") || { echo "Failed to fetch Codex reactions" >&2; exit 1; }',
    'COMMENT_OK=$(jq --arg head "$HEAD_OID" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and ((.body // "") | contains($head)))] | length\' <<< "$COMMENTS")',
    'REACTION_OK=$(jq \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1")] | length\' <<< "$REACTIONS")',
    'FRESH_REACTION_OK=$(jq --arg since "$WAIT_STARTED" \'[.[][] | select(((.user.login // "") | test("codex"; "i")) and ((.user.login // "") | endswith("[bot]")) and .content == "+1" and (.created_at // "") > $since)] | length\' <<< "$REACTIONS")',
    'if [ "$COMMENT_OK" != "0" ] || { [ -n "$WAIT_STARTED" ] && [ "$WAIT_HEAD" = "$HEAD_OID" ] && [ "$FRESH_REACTION_OK" != "0" ]; }; then jq -n --arg url "$PR_URL" --argjson reaction_count "$REACTION_OK" --argjson fresh_reaction_count "$FRESH_REACTION_OK" \'{"type":"allow","data":{"approved":true,"pr_url":$url,"codex_approved":true,"codex_reaction_count":$reaction_count,"codex_fresh_reaction_count":$fresh_reaction_count}}\'; exit 0; fi',
    'NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `if [ -z "$WAIT_STARTED" ] || [ "$WAIT_HEAD" != "$HEAD_OID" ]; then jq -n --arg started "$NOW_ISO" --arg head "$HEAD_OID" '{"type":"block","reason":"Review approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'WAIT_STARTED_PARSE=${WAIT_STARTED%%.*}; WAIT_STARTED_PARSE=${WAIT_STARTED_PARSE%Z}Z',
    'START_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$WAIT_STARTED_PARSE" +%s 2>/dev/null || date -u -d "$WAIT_STARTED" +%s 2>/dev/null || echo 0)',
    'NOW_EPOCH=$(date -u +%s)',
    `if [ $((NOW_EPOCH - START_EPOCH)) -lt ${timeoutSeconds} ]; then jq -n --arg started "$WAIT_STARTED" --arg head "$HEAD_OID" '{"type":"block","reason":"Review approval requires fresh Codex bot approval for current head or ${label} timeout from approval handoff","data":{"codex_wait_started_at":$started,"codex_wait_head_oid":$head}}'; exit 0; fi`,
    'jq -n --arg url "$PR_URL" \'{"type":"allow","data":{"approved":true,"pr_url":$url,"codex_approved":false,"codex_timed_out":true,"codex_warning":"No current-head Codex approval found before timeout"}}\'',
  ].join('\n');
}

/** The default (7200s / 2-hour) plan-approval script the pre-#2409 migration emitted. */
export const LEGACY_PLAN_APPROVAL_SCRIPT: string = buildLegacyApprovalsScript();

/** The default (7200s / 2-hour) review-approval script the pre-#2409 migration emitted. */
export const LEGACY_REVIEW_APPROVAL_SCRIPT: string = buildLegacyReviewApprovalScript();
