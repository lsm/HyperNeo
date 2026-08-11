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

# Every SHARDS entry must also appear in the ACTIVE CI unit matrix. A shard that
# runs locally via test-daemon.sh but is absent from CI would make this guard
# falsely report its files as covered (this is how `shared` — 25 files under
# packages/shared/tests — was silently skipped before being added to the matrix).
unit_matrix=$(grep -E "^[[:space:]]*shard:[[:space:]]*\[" "$REPO_ROOT/.github/workflows/main.yml" \
	| head -n1 | sed -E 's/.*\[//; s/\].*//' | tr ',' '\n' | tr -d ' ')
for shard in "${SHARDS[@]}"; do
	if ! printf '%s\n' "$unit_matrix" | grep -qxF "$shard"; then
		err "daemon unit shard '$shard' is declared in test-daemon.sh SHARDS but missing from the CI unit matrix"
		echo "     → add it to the test-daemon-shared-unit matrix in .github/workflows/main.yml (or drop it from SHARDS)" >&2
	fi
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
# The web suite is a single `bunx vitest run` job. Verify its `include` glob
# still covers the full src test set — rooted at src/** AND spanning {test,spec}
# — so a narrowed include (e.g. src/**/*.unit.test.ts, which still contains
# src/**) cannot silently drop files while this guard reports full coverage.
include_line=$(grep -E "include:[[:space:]]*\[" "$WEB_CFG" | head -n1)
if [ -z "$include_line" ] \
	|| ! printf '%s' "$include_line" | grep -q 'src/\*\*' \
	|| ! printf '%s' "$include_line" | grep -q '{test,spec}'; then
	err "packages/web/vitest.config.ts 'include' no longer covers src/**/*.{test,spec} — web tests may be orphaned"
	echo "     → keep the include rooted at src/** spanning {test,spec}, or update this validator" >&2
fi

# Web test files outside the src/** include are not run by web CI. Each must be
# under src/ or listed in WEB_EXEMPT (with a reason), or it is flagged — none is
# silently ignored.
WEB_EXEMPT=(
	# pre-existing orphan: imports `bun:test` (web Vitest has no bun:test shim)
	# and sits outside src/. Migration tracked separately.
	"packages/web/tests/file-utils.test.ts"
)
web_count=0
while IFS= read -r f; do
	web_count=$((web_count + 1))
	rel="${f#"$REPO_ROOT"/}"
	case "$rel" in
	packages/web/src/*) ;;  # covered by the src/** include glob
	*)
		exempt=0
		for e in "${WEB_EXEMPT[@]}"; do [ "$rel" = "$e" ] && exempt=1 && break; done
		if [ "$exempt" -ne 1 ]; then
			err "web test file outside the src/ include root (not run by web CI): $rel"
			echo "     → move it under src/, or add it to WEB_EXEMPT with a reason" >&2
		fi
		;;
	esac
done < <(find "$REPO_ROOT/packages/web" -type d \( -name node_modules -o -name dist \) -prune -o \
	-type f \( -name '*.test.ts' -o -name '*.test.tsx' \
	-o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print | sort)
echo "web: $web_count test file(s) in packages/web/ (${#WEB_EXEMPT[@]} exempt outside src/)"

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

# A module directory is "covered" iff some ACTIVE (non-commented) workflow line
# references tests/online/<dir>; otherwise it must be listed in EXEMPT_DIRS
# (intentionally disabled). Deriving coverage from active references — instead
# of a static KNOWN_DIRS allow-list — catches a directory whose CI shard was
# removed or commented out (e.g. glm/providers below), which an allow-list would
# silently keep reporting as covered.
#
# Each EXEMPT_DIRS entry is a directory intentionally NOT run by CI, documented
# so the exemption is explicit rather than hidden in an allow-list:
#   benchmark : manual-only (describe.skip by default)
#   glm       : disabled — GLM online tests are flaky (commented out in main.yml)
#   providers : disabled — codex bridge needs OPENAI_API_KEY, copilot has a
#               credential issue (commented out in main.yml)
#   sandbox   : disabled — not wired to a CI matrix shard
EXEMPT_DIRS="benchmark glm providers sandbox"
# Split modules are checked file-by-file above via check_split_module (explicit
# file lists); skip them here so a directory isn't double-judged.
SPLIT_DIRS="rpc room features providers cross-provider rewind space"
for dir in "$ONLINE_DIR"/*/; do
	[ -d "$dir" ] || continue
	dirname=$(basename "$dir")
	if [[ " $EXEMPT_DIRS " == *" $dirname "* ]] || [[ " $SPLIT_DIRS " == *" $dirname "* ]]; then
		continue
	fi
	# A directory-level reference (test_path: tests/online/<dir>) covers every
	# file under it. Match tests/online/<dir> NOT followed by a character that
	# could extend the dir name ('/', alnum, '-', '_'), so a reference to
	# tests/online/rpc-foo is not mistaken for tests/online/rpc, and a file-level
	# path like tests/online/agent/<file> is not mistaken for the whole dir.
	dir_refs=$(grep -hE "tests/online/$dirname([^/[:alnum:]_-]|$)" "$MAIN_WORKFLOW" "$REAL_API_WORKFLOW" 2>/dev/null \
		| grep -cvE '^[[:space:]]*#')
	if [ "${dir_refs:-0}" -gt 0 ]; then
		continue
	fi
	# No directory-level reference: each file needs its own active reference,
	# so a single-file module (e.g. agent) can't hide an uncovered sibling.
	while IFS= read -r f; do
		fname=$(basename "$f")
		file_refs=$(grep -hF "tests/online/$dirname/$fname" "$MAIN_WORKFLOW" "$REAL_API_WORKFLOW" 2>/dev/null \
			| grep -cvE '^[[:space:]]*#')
		if [ "${file_refs:-0}" -eq 0 ]; then
			err "online test not covered by any active CI shard: tests/online/$dirname/$fname"
			echo "     → add it to a matrix in $MAIN_WORKFLOW (or to EXEMPT_DIRS if the module is disabled)" >&2
		fi
	done < <(find "$dir" -name "*.test.ts" -type f | sort)
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
echo "Exempt (intentionally disabled) online dirs: ${EXEMPT_DIRS}"
