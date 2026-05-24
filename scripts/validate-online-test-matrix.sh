#!/bin/bash
# Validates that all daemon online test files are covered by the CI matrices.
#
# The mocked CI matrix in .github/workflows/main.yml splits some modules (rpc, room,
# features, rewind, space) into shards with explicit file lists. Real-key shards
# live in .github/workflows/real-api-tests.yml. This script catches new test
# files that were added but not included in either matrix.
#
# NOTE: providers-anthropic-to-codex-bridge shard is disabled (requires OPENAI_API_KEY).
#
# Usage: bash scripts/validate-online-test-matrix.sh

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ONLINE_DIR="packages/daemon/tests/online"
ERRORS=0

# --- 1. Check split modules: every *.test.ts must appear in a CI matrix ---
# These arrays must stay in sync with the test_path values in
# .github/workflows/main.yml test-daemon-online matrix and
# .github/workflows/real-api-tests.yml daemon-real-api matrix.

RPC_FILES=(
  rpc-agent-handlers.test.ts
  rpc-config-handlers.test.ts
  rpc-draft-handlers.test.ts
  rpc-file-handlers.test.ts
  rpc-interrupt-handlers.test.ts
  rpc-live-query.test.ts
  rpc-message-handlers.test.ts
  rpc-model-handlers.test.ts
  rpc-model-switching.test.ts
  rpc-remove-output.test.ts
  rpc-rewind-handlers.test.ts
  rpc-session-filtering.test.ts
  rpc-session-handlers-extended.test.ts
  rpc-session-workflow.test.ts
  rpc-settings-handlers.test.ts
  rpc-state-sync.test.ts
  rpc-task-draft-handlers.test.ts
  rpc-task-lifecycle.test.ts
  session-handlers.test.ts
)

# NOTE: All room/* shards are intentionally commented out in .github/workflows/main.yml
# due to resource usage. Room online tests were deleted in Task #186 (Room retirement).
# The 'room' directory no longer exists in tests/online/.
ROOM_FILES=()

FEATURES_FILES=(
  auto-title.test.ts
  github-poll-job.test.ts
  message-delivery-mode-queue.test.ts
  message-persistence.test.ts
)

PROVIDERS_FILES=(
  anthropic-to-copilot-bridge-provider.test.ts
  anthropic-to-codex-bridge-provider.test.ts  # CI shard disabled — kept here so validator doesn't flag it
)

# Real-key cross-provider tests must be present in .github/workflows/real-api-tests.yml.
CROSS_PROVIDER_FILES=(
  cross-provider-model-switch.test.ts
  glm-to-anthropic-resume.test.ts
  thinking-block-signatures.test.ts
)

REWIND_FILES=(
  rewind-feature.test.ts
  selective-rewind.test.ts
)

SPACE_FILES=(
  space-chat-session.test.ts
  space-edge-cases.test.ts
  space-happy-path-code-review.test.ts
  space-happy-path-full-pipeline.test.ts
  space-happy-path-plan-to-approve.test.ts
  space-happy-path-qa-completion.test.ts
  task-agent-lifecycle.test.ts
  task-agent-skills.test.ts
)

check_workflow_references() {
  local module_name=$1
  local workflow=$2
  shift 2
  local expected=("$@")

  for f in "${expected[@]}"; do
    local test_path="tests/online/$module_name/$f"
    if ! grep -qF "$test_path" "$workflow"; then
      echo "ERROR: $test_path is not referenced in $workflow"
      echo "  -> Add it to the appropriate CI matrix in $workflow"
      ERRORS=$((ERRORS + 1))
    fi
  done
}

check_split_module() {
  local module_name=$1
  local workflow=$2
  shift 2
  local expected=("$@")

  local dir="$ONLINE_DIR/$module_name"
  if [ ! -d "$dir" ]; then
    echo "WARNING: Split module directory $dir does not exist"
    return
  fi

  # Build expected list as newline-separated string for grep matching
  local expected_list=""
  for f in "${expected[@]}"; do
    expected_list="$expected_list$f"$'\n'
  done

  # Check every actual test file is in the expected list
  while IFS= read -r file; do
    local name
    name=$(basename "$file")
    if ! echo "$expected_list" | grep -qxF "$name"; then
      echo "ERROR: $file is not in any CI matrix shard for '$module_name'"
      echo "  -> Add it to the appropriate matrix in $workflow"
      ERRORS=$((ERRORS + 1))
    fi
  done < <(find "$dir" -name "*.test.ts" -type f | sort)

  # Check no expected file is missing from disk (stale reference)
  for f in "${expected[@]}"; do
    if [ ! -f "$dir/$f" ]; then
      echo "ERROR: $dir/$f is listed in matrix but does not exist on disk"
      echo "  -> Remove it from the matrix in $workflow"
      ERRORS=$((ERRORS + 1))
    fi
  done

  check_workflow_references "$module_name" "$workflow" "${expected[@]}"
}

MAIN_WORKFLOW=".github/workflows/main.yml"
REAL_API_WORKFLOW=".github/workflows/real-api-tests.yml"

check_split_module "rpc" "$MAIN_WORKFLOW" "${RPC_FILES[@]}"
check_split_module "room" "$MAIN_WORKFLOW" "${ROOM_FILES[@]:-}"
check_split_module "features" "$MAIN_WORKFLOW" "${FEATURES_FILES[@]}"
check_split_module "providers" "$MAIN_WORKFLOW" "${PROVIDERS_FILES[@]}"
check_split_module "cross-provider" "$REAL_API_WORKFLOW" "${CROSS_PROVIDER_FILES[@]}"
check_split_module "rewind" "$MAIN_WORKFLOW" "${REWIND_FILES[@]}"
check_split_module "space" "$MAIN_WORKFLOW" "${SPACE_FILES[@]}"

# --- 2. Check for new module directories not in the CI matrix ---
# These are directories covered by directory-level test_path (auto-discover).
KNOWN_DIRS="agent components convo coordinator cross-provider features git glm lifecycle mcp providers rewind rpc sandbox sdk space websocket"

for dir in "$ONLINE_DIR"/*/; do
  [ -d "$dir" ] || continue
  dirname=$(basename "$dir")
  if ! echo "$KNOWN_DIRS" | grep -qw "$dirname"; then
    echo "ERROR: New module directory '$dirname' is not in the CI matrix"
    echo "  → Add it to the test-daemon-online matrix in .github/workflows/main.yml"
    ERRORS=$((ERRORS + 1))
  fi
done

# --- Result ---
if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "FAILED: $ERRORS online test coverage issue(s) found."
  echo "See .github/workflows/main.yml test-daemon-online matrix."
  exit 1
fi

echo "All online test files are covered by the CI matrices."
