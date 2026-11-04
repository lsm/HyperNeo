#!/usr/bin/env bash
set -euo pipefail
[[ $# = 1 && "$1" = /* ]] || { echo 'Expected one fresh absolute evidence directory' >&2; exit 2; }
EVIDENCE=$1
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROOFS="$REPO_ROOT/.claude/skills/verify"
mkdir "$EVIDENCE"
cd "$REPO_ROOT"
export VERIFY_PROOF_RUNTIME=bun
bash "$PROOFS/proof-run.sh" "$EVIDENCE/neo-settings-writer" "$PROOFS/neo-settings-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-cleanup-enqueue" "$PROOFS/lane-b-cleanup-enqueue.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-identity-contract" "$PROOFS/workflow-identity-contract.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-mailbox-admission" "$PROOFS/lane-b-mailbox-admission.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-event-submission" "$PROOFS/lane-b-event-submission.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-delivery-parking" "$PROOFS/lane-b-delivery-parking.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/agent-reminder-delete-writer" "$PROOFS/agent-reminder-delete-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-delete-writer" "$PROOFS/workflow-delete-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-rate-limit-cancel" "$PROOFS/lane-b-rate-limit-cancel.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-owned-input-withdrawal" "$PROOFS/lane-b-owned-input-withdrawal.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-rate-limit-retry" "$PROOFS/lane-b-rate-limit-retry.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-provider-rpc-writes" "$PROOFS/lane-c-provider-rpc-writes.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-credential-store-writes" "$PROOFS/lane-c-credential-store-writes.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-session-delivery-enqueue" "$PROOFS/lane-b-session-delivery-enqueue.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-stale-reclaim-writer" "$PROOFS/lane-b-stale-reclaim-writer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/direct-outcome-parking-writer" "$PROOFS/direct-outcome-parking-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-mailbox-expiry-writer" "$PROOFS/lane-b-mailbox-expiry-writer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-github-poll-successor-writer" "$PROOFS/lane-b-github-poll-successor-writer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-native-feed-enqueue-writer" "$PROOFS/lane-b-native-feed-enqueue-writer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-session-title-enqueue-writer" "$PROOFS/lane-b-session-title-enqueue-writer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-skill-validation-enqueue-writer" "$PROOFS/lane-c-skill-validation-enqueue-writer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-github-poll-refresh-writer" "$PROOFS/lane-c-github-poll-refresh-writer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-github-poll-refresh-retry" "$PROOFS/lane-c-github-poll-refresh-retry.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-github-poll-startup-degraded" "$PROOFS/lane-c-github-poll-startup-degraded.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-github-poll-capability-failure" "$PROOFS/lane-c-github-poll-capability-failure.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-session-schedule-create" "$PROOFS/lane-b-session-schedule-create.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-node-config-contract" "$PROOFS/workflow-node-config-contract.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-existing-run-pin" "$PROOFS/workflow-existing-run-pin.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-snapshot-writer" "$PROOFS/workflow-snapshot-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/direct-start-requeue-writer" "$PROOFS/direct-start-requeue-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/job-requeue-writer" "$PROOFS/job-requeue-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/task-schedule-delete-writer" "$PROOFS/task-schedule-delete-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/task-schedule-pause-writer" "$PROOFS/task-schedule-pause-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-options-contract" "$PROOFS/workflow-options-contract.ts" verify
echo 'Bun native smoke: settings and workflow/job batches passed (34 legacy helpers)'
