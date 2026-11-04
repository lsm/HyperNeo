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
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-transcript-session-reader" "$PROOFS/lane-b-transcript-session-reader.ts" --defer-body-copy
bash "$PROOFS/proof-run.sh" "$EVIDENCE/history-snapshot-reader" "$PROOFS/history-snapshot-reader.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-session-list-reader" "$PROOFS/lane-b-session-list-reader.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-session-list-live-reader" "$PROOFS/lane-b-session-list-live-reader.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-health-session-count-reader" "$PROOFS/lane-b-health-session-count-reader.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-projected-session-reader" "$PROOFS/lane-b-projected-session-reader.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-projected-system-broadcast-failure" "$PROOFS/lane-b-projected-system-broadcast-failure.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-transcript-shutdown-order" "$PROOFS/lane-b-transcript-shutdown-order.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-mutation-planning" "$PROOFS/todo-mutation-planning.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-single-message-reader" "$PROOFS/lane-b-single-message-reader.ts" --defer-body-copy
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-mutation-commit" "$PROOFS/todo-mutation-commit.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/coding-daemon-merge-build" "$PROOFS/coding-daemon-merge-build.ts"
for variant in enterprise policy-revoke merge-fails late-label per-pr retry-once legacy-open uncertain-error limit-gone external-owned zero-required no-checks human-default human-owner human-unconfigured approved-no-checks human-waiting-ci human-sibling-ci owner-ci human-new-head ci-startup-queued ci-startup-running ci-merge-race ci-retry-budget ci-stopped-ready; do
  bash "$PROOFS/proof-run.sh" "$EVIDENCE/coding-daemon-merge-sweep-$variant" "$PROOFS/coding-daemon-merge-sweep.ts" "$variant"
done
bash "$PROOFS/proof-run.sh" "$EVIDENCE/coding-signoff-scope" "$PROOFS/coding-signoff-scope.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-remove-writer" "$PROOFS/todo-remove-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-mutation-activation" "$PROOFS/todo-mutation-activation.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-runner-state" "$PROOFS/todo-runner-state.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-runner-activation" "$PROOFS/todo-runner-activation.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-start-recovery" "$PROOFS/todo-start-recovery.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-start-recovery-activation" "$PROOFS/todo-start-recovery-activation.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/ask-settlement-build" "$PROOFS/ask-settlement-build.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/neo-track-admission-build" "$PROOFS/neo-track-admission-build.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/neo-track-admission-activation" "$PROOFS/neo-track-admission-activation.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-add-build" "$PROOFS/todo-add-build.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/todo-stop-context" "$PROOFS/todo-stop-context.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/ask-settlement-activation" "$PROOFS/ask-settlement-activation.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/human-confirmed-todos" "$PROOFS/human-confirmed-todos.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-message-count-reader" "$PROOFS/lane-b-message-count-reader.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-session-export-reader" "$PROOFS/lane-b-session-export-reader.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-b-session-schedule-create" "$PROOFS/lane-b-session-schedule-create.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-node-config-contract" "$PROOFS/workflow-node-config-contract.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-existing-run-pin" "$PROOFS/workflow-existing-run-pin.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-snapshot-writer" "$PROOFS/workflow-snapshot-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/direct-start-requeue-writer" "$PROOFS/direct-start-requeue-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/job-requeue-writer" "$PROOFS/job-requeue-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/task-schedule-delete-writer" "$PROOFS/task-schedule-delete-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/task-schedule-pause-writer" "$PROOFS/task-schedule-pause-writer.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/workflow-options-contract" "$PROOFS/workflow-options-contract.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-pairing-approve" "$PROOFS/lane-c-pairing-approve.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-pairing-redeem" "$PROOFS/lane-c-pairing-redeem.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-pairing-code-create" "$PROOFS/lane-c-pairing-code-create.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-pairing-revoke-command" "$PROOFS/lane-c-pairing-revoke-command.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-connected-device-observer" "$PROOFS/lane-c-connected-device-observer.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-pairing-revoke-activation" "$PROOFS/lane-c-pairing-revoke-activation.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-human-reset-command" "$PROOFS/lane-c-human-reset-command.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-conversation-reservation-extract" "$PROOFS/lane-c-conversation-reservation-extract.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-human-reset-receipts" "$PROOFS/lane-c-human-reset-receipts.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-human-reset-coordinator" "$PROOFS/lane-c-human-reset-coordinator.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-human-reset-activation" "$PROOFS/lane-c-human-reset-activation.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-workspace-remove" "$PROOFS/lane-c-workspace-remove.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-workspace-upsert" "$PROOFS/lane-c-workspace-upsert.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-workspace-add" "$PROOFS/lane-c-workspace-add.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-artifact-identity-extract" "$PROOFS/lane-c-artifact-identity-extract.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-artifact-identity-command" "$PROOFS/lane-c-artifact-identity-command.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/retire-local-register" "$PROOFS/retire-local-register.ts" verify
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-artifact-reference-identity" "$PROOFS/lane-c-artifact-reference-identity.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-artifact-git-identity" "$PROOFS/lane-c-artifact-git-identity.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-artifact-row-command" "$PROOFS/lane-c-artifact-row-command.ts"
bash "$PROOFS/proof-run.sh" "$EVIDENCE/lane-c-artifact-git-row" "$PROOFS/lane-c-artifact-git-row.ts"
echo 'Bun native smoke: registered batches passed (84 legacy helpers, 108 proof cases)'
