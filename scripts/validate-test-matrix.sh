#!/bin/bash
# validate-test-matrix.sh — Universal test-coverage guard.
#
# Asserts that every Vitest test file under the covered roots is reachable by
# exactly one CI shard, so a newly-added test file can never be silently
# skipped by CI. Three suites are checked:
#
#   1. daemon unit  — packages/daemon/tests/unit/** + packages/shared/tests/**
#                     The shard definitions are SOURCED from scripts/test-daemon.sh
#                     (the source of truth), so this validator follows shard
#                     changes automatically. NB: daemon unit files import from
#                     `bun:test` but run under Vitest via the daemon shim, so
#                     every *.test.ts / *_test.ts file is expected to be covered.
#   2. web          — packages/web/src/** (single directory glob in
#                     packages/web/vitest.config.ts; one CI job, no shard list).
#   3. daemon online— packages/daemon/tests/online/** (CI matrices in
#                     .github/workflows/main.yml + real-api-tests.yml).
#
# Later suite-rework tasks that move daemon shards to directory globs only need
# to keep scripts/test-daemon.sh's shard_paths() accurate — section 1 reads it
# directly and needs no edits here.
#
# Usage: bash scripts/validate-test-matrix.sh
# Wired into `bun run check` and the CI `check` job (.github/workflows/main.yml).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$REPO_ROOT"

ERRORS=0
err() {
	echo "ERROR: $*" >&2
	ERRORS=$((ERRORS + 1))
}

# ===========================================================================
# 1. DAEMON UNIT TESTS  (source of truth: scripts/test-daemon.sh)
# ===========================================================================
# test-daemon.sh returns early when sourced (source-guard near its bottom),
# exposing SHARDS, shard_paths, migration_shard_paths, TEST_ROOT, REPO_ROOT.
# shellcheck source=test-daemon.sh
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/test-daemon.sh"

UNIT_ROOT="$REPO_ROOT/packages/daemon/tests/unit"
SHARED_ROOT="$REPO_ROOT/packages/shared/tests"

COVERED_TMP="$(mktemp)"
trap 'rm -f "$COVERED_TMP"' EXIT

# Build the covered set: "<relpath>\t<shard>" for every file every shard touches.
# Each shard path-spec is expanded the way Vitest receives it from test-daemon.sh:
#   glob (*)     → each matching file
#   directory    → every *.test.ts / *_test.ts beneath it (recursive)
#   plain file   → itself
# Inlined (not a piped function) so stale-spec detection survives the loop body.
: > "$COVERED_TMP"
for shard in "${SHARDS[@]}"; do
	while IFS= read -r spec; do
		[ -n "$spec" ] || continue
		case "$spec" in
		*\*)
			matched=0
			# shellcheck disable=SC2086  # intentional word-split + glob expansion
			for f in $spec; do
				if [ -f "$f" ]; then
					printf '%s\t%s\n' "${f#"$REPO_ROOT"/}" "$shard" >> "$COVERED_TMP"
					matched=1
				fi
			done
			if [ "$matched" -eq 0 ]; then
				err "daemon unit shard '$shard' glob matched no files: $spec"
				echo "     → fix shard_paths() in scripts/test-daemon.sh" >&2
			fi
			;;
		*)
			if [ -d "$spec" ]; then
				while IFS= read -r f; do
					printf '%s\t%s\n' "${f#"$REPO_ROOT"/}" "$shard" >> "$COVERED_TMP"
				done < <(find "$spec" -type f \( -name '*.test.ts' -o -name '*_test.ts' \))
			elif [ -f "$spec" ]; then
				printf '%s\t%s\n' "${spec#"$REPO_ROOT"/}" "$shard" >> "$COVERED_TMP"
			else
				err "daemon unit shard '$shard' references a path that no longer exists: $spec"
				echo "     → remove it from shard_paths() in scripts/test-daemon.sh" >&2
			fi
			;;
		esac
	done < <(shard_paths "$shard")
done

# Assert every unit/shared test file on disk is covered by exactly one shard.
unit_disk=$(
	find "$UNIT_ROOT" "$SHARED_ROOT" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) |
		wc -l | tr -d ' '
)
while IFS= read -r f; do
	rel="${f#"$REPO_ROOT"/}"
	owner_count=$(awk -F'\t' -v f="$rel" '$1 == f' "$COVERED_TMP" | wc -l | tr -d ' ')
	if [ "$owner_count" -eq 0 ]; then
		err "daemon unit test not covered by any shard: $rel"
		echo "     → add it to the appropriate shard in scripts/test-daemon.sh" >&2
	elif [ "$owner_count" -gt 1 ]; then
		owners=$(awk -F'\t' -v f="$rel" '$1 == f { print $2 }' "$COVERED_TMP" | sort -u | tr '\n' ',' | sed 's/,$//')
		err "daemon unit test covered by $owner_count shards ($owners): $rel"
	fi
done < <(find "$UNIT_ROOT" "$SHARED_ROOT" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) | sort)

unit_covered=$(sort -u "$COVERED_TMP" | wc -l | tr -d ' ')
echo "daemon unit: $unit_disk file(s) on disk, $unit_covered covered"

# ===========================================================================
# 2. WEB TESTS  (packages/web/src/** — single directory glob, one CI job)
# ===========================================================================
# The web suite is a single `bunx vitest run` job whose `include` glob roots at
# `src/`. Assert the config still does so — a future shard split or narrowed
# include would orphan src test files with no other signal.
WEB_SRC="$REPO_ROOT/packages/web/src"
WEB_CFG="$REPO_ROOT/packages/web/vitest.config.ts"
if ! grep -qE "include:[[:space:]]*\[[^]]*src/\*\*" "$WEB_CFG"; then
	err "packages/web/vitest.config.ts `include` no longer covers src/** — web tests may be orphaned"
	echo "     → keep the include glob rooted at src/ or update this validator" >&2
fi

web_count=0
while IFS= read -r f; do
	web_count=$((web_count + 1))
	rel="${f#"$REPO_ROOT"/}"
	case "$rel" in
	packages/web/src/*) ;;  # covered by the src/** glob
	*) err "web test file outside the src/ include root (not run by web CI): $rel" ;;
	esac
done < <(find "$WEB_SRC" -type f \( -name '*.test.ts' -o -name '*.test.tsx' \
	-o -name '*.spec.ts' -o -name '*.spec.tsx' \) | sort)
echo "web: $web_count test file(s) under src/"

# ===========================================================================
# 3. DAEMON ONLINE TESTS  (CI matrices: main.yml + real-api-tests.yml)
# ===========================================================================
# These arrays must stay in sync with the test_path values in
# .github/workflows/main.yml (test-daemon-online) and
# .github/workflows/real-api-tests.yml (daemon-real-api). Split modules use
# explicit file lists; the rest are directory-level (auto-discover).
ONLINE_DIR="packages/daemon/tests/online"
MAIN_WORKFLOW=".github/workflows/main.yml"
REAL_API_WORKFLOW=".github/workflows/real-api-tests.yml"

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

# room/* shards are commented out in main.yml (Room retirement, Task #186); the
# 'room' directory no longer exists in tests/online/.
ROOM_FILES=()

FEATURES_FILES=(
	auto-title.test.ts
	github-poll-job.test.ts
	message-delivery-mode-queue.test.ts
	message-persistence.test.ts
)

PROVIDERS_FILES=(
	anthropic-to-copilot-bridge-provider.test.ts
	# CI shard disabled (requires OPENAI_API_KEY) — kept here so the validator
	# does not flag it as an uncovered file on disk.
	anthropic-to-codex-bridge-provider.test.ts
)

# Real-key cross-provider tests must be present in real-api-tests.yml.
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
	prompt-too-long-kimi-recovery.test.ts
)

check_workflow_references() {
	local module_name=$1
	local workflow=$2
	shift 2
	local expected=("$@")

	for f in "${expected[@]}"; do
		local test_path="tests/online/$module_name/$f"
		if ! grep -qF "$test_path" "$workflow"; then
			err "$test_path is not referenced in $workflow"
			echo "     → add it to the appropriate CI matrix in $workflow" >&2
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
		echo "WARNING: split module directory $dir does not exist"
		return
	fi

	# Every actual test file must be in the expected list.
	local expected_list=""
	local f
	for f in "${expected[@]}"; do
		expected_list="$expected_list$f"$'\n'
	done
	while IFS= read -r file; do
		local name
		name=$(basename "$file")
		if ! grep -qxF "$name" <<< "$expected_list"; then
			err "$file is not in any CI matrix shard for '$module_name'"
			echo "     → add it to the appropriate matrix in $workflow" >&2
		fi
	done < <(find "$dir" -name "*.test.ts" -type f | sort)

	# No expected file may be missing from disk (stale reference).
	for f in "${expected[@]}"; do
		if [ ! -f "$dir/$f" ]; then
			err "$dir/$f is listed in matrix but does not exist on disk"
			echo "     → remove it from the matrix in $workflow" >&2
		fi
	done

	check_workflow_references "$module_name" "$workflow" "${expected[@]}"
}

check_split_module "rpc" "$MAIN_WORKFLOW" "${RPC_FILES[@]}"
check_split_module "room" "$MAIN_WORKFLOW" "${ROOM_FILES[@]:-}"
check_split_module "features" "$MAIN_WORKFLOW" "${FEATURES_FILES[@]}"
check_split_module "providers" "$MAIN_WORKFLOW" "${PROVIDERS_FILES[@]}"
check_split_module "cross-provider" "$REAL_API_WORKFLOW" "${CROSS_PROVIDER_FILES[@]}"
check_split_module "rewind" "$MAIN_WORKFLOW" "${REWIND_FILES[@]}"
check_split_module "space" "$MAIN_WORKFLOW" "${SPACE_FILES[@]}"

# New module directories must be added to a CI matrix (auto-discover shards).
KNOWN_DIRS="agent components convo coordinator cross-provider features git glm lifecycle mcp providers rewind rpc sandbox sdk space websocket"
EXEMPT_DIRS="benchmark"
for dir in "$ONLINE_DIR"/*/; do
	[ -d "$dir" ] || continue
	dirname=$(basename "$dir")
	if [[ " $EXEMPT_DIRS " == *" $dirname "* ]]; then
		continue
	fi
	if [[ " $KNOWN_DIRS " != *" $dirname "* ]]; then
		err "new online module directory '$dirname' is not in the CI matrix"
		echo "     → add it to the test-daemon-online matrix in $MAIN_WORKFLOW" >&2
	fi
done

# ===========================================================================
# Result
# ===========================================================================
if [ "$ERRORS" -gt 0 ]; then
	echo ""
	echo "FAILED: $ERRORS test-coverage issue(s) found."
	exit 1
fi

echo ""
echo "All test files are covered by the CI matrices (unit + web + online)."
