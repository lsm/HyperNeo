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

# Count ACTIVE (non-commented) lines in file $1 containing the fixed string $2.
# Config/workflow checks use this so a commented-out line can't satisfy them.
# Filters lines starting with `#` (YAML/JSON), `//` (TS line comment), or `/*`
# (TS block comment that opens the line). NOTE: we deliberately do NOT strip
# `/* ... */` spans, because the legitimate include/exclude globs contain `/**/`
# (e.g. tests/**/*.test.ts) which is textually identical to an empty block
# comment — a regex strip would mangle the patterns. A mid-line block comment
# hiding a pattern is a residual requiring a TS-aware parser.
active_hits() { grep -hF "$2" "$1" 2>/dev/null | grep -cvE '^[[:space:]]*(#|//|/\*)'; }

# ===========================================================================
# 1. DAEMON UNIT TESTS  (source of truth: scripts/test-daemon.sh)
# ===========================================================================
# test-daemon.sh returns early when sourced (source-guard near its bottom),
# exposing SHARDS, shard_paths, migration_shard_paths, TEST_ROOT, REPO_ROOT.
# shellcheck source=test-daemon.sh
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/test-daemon.sh"

UNIT_ROOT="$REPO_ROOT/packages/daemon/tests/unit"
# Scan the WHOLE shared package (not just tests/) so a source-adjacent test
# (e.g. src/types/x.test.ts) can't sit outside the shared vitest `tests/**`
# include — and thus off CI — while this guard reports full coverage.
SHARED_ROOT="$REPO_ROOT/packages/shared"

# Unit runner configs (daemon + shared) determine which shard paths Vitest
# actually runs — Vitest applies include/exclude even to explicit paths. Mirror
# the online/web config guards so narrowing a unit config can't filter shard
# paths while this guard stays green.
for _cfg in "$REPO_ROOT/packages/daemon/vitest.config.ts" "$REPO_ROOT/packages/shared/vitest.config.ts"; do
	_cfg_pkg=$(basename "$(dirname "$_cfg")")
	if [ "$(active_hits "$_cfg" "include: ['tests/**/*.test.ts', 'tests/**/*_test.ts']")" -eq 0 ]; then
		err "$_cfg_pkg/vitest.config.ts active include is not ['tests/**/*.test.ts', 'tests/**/*_test.ts'] — unit shard paths could be filtered out"
		echo "     → keep the include broad, or update this validator" >&2
	fi
	# Require the EXACT expected exclude (per package) — a substring check for
	# tests/unit/|src/ misses a broad glob like tests/** that would filter every
	# unit shard path. daemon legitimately excludes tests/online/** (separate
	# online config).
	case "$_cfg_pkg" in
		daemon) _exp_exclude="exclude: ['node_modules', 'dist', 'tests/online/**']" ;;
		shared) _exp_exclude="exclude: ['node_modules', 'dist']" ;;
	esac
	if [ "$(active_hits "$_cfg" "$_exp_exclude")" -eq 0 ]; then
		err "$_cfg_pkg/vitest.config.ts active exclude is not the expected \"$_exp_exclude\" — a broad/changed glob could filter unit shard paths"
		echo "     → keep the exclude to the expected set, or update this validator" >&2
	fi
done

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

# The matrix value must actually reach the runner: assert the test-daemon-shared-
# unit job forwards ${{ matrix.shard }} to test-daemon.sh. Replacing it with a
# fixed shard would run that one shard in every matrix job while this guard
# still reported every shard's files as covered.
if [ "$(active_hits "$REPO_ROOT/.github/workflows/main.yml" 'test-daemon.sh ${{ matrix.shard }}')" -eq 0 ]; then
	err "test-daemon-shared-unit job does not forward \${{ matrix.shard }} to test-daemon.sh — unit matrix values don't reach the runner"
	echo "     → keep './scripts/test-daemon.sh \${{ matrix.shard }} ...' in the unit job" >&2
fi

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
# The web suite is a single `bunx vitest run` job. Require its `include` to be
# the full src/**/*.{test,spec}.{ts,tsx} glob, so ANY narrowing (dropping .tsx,
# inserting .unit., restricting the suffix, …) is caught rather than silently
# dropping files while this guard reports full coverage. A substring/fragment
# check is not enough — only the exact glob is.
if [ "$(active_hits "$WEB_CFG" 'src/**/*.{test,spec}.{ts,tsx}')" -eq 0 ]; then
	err "packages/web/vitest.config.ts active include is not the full src/**/*.{test,spec}.{ts,tsx} glob — web tests may be orphaned"
	echo "     → restore the full include, or update this validator" >&2
fi
# test.exclude must stay node_modules/dist only — adding a src/ pattern there
# would silently skip those tests while this guard still marks them covered.
if [ "$(active_hits "$WEB_CFG" "exclude: ['node_modules', 'dist']")" -eq 0 ]; then
	err "packages/web/vitest.config.ts active test exclude is not ['node_modules', 'dist'] — src test files could be excluded"
	echo "     → keep test.exclude to node_modules/dist, or update this validator" >&2
fi
# The web coverage assumes the test-web CI job runs a bare `vitest run` (no
# targeted path), so the config include/exclude fully determine execution. If
# that step is removed, disabled, or replaced with a targeted invocation, every
# src/ file would still be reported covered while CI no longer runs the suite.
# Anchored at end-of-line: a bare `vitest run` (no targeted path) puts `run` at
# the end of the line; `vitest run src/foo.test.ts` would not match.
# The web coverage assumes the test-web CI job runs a bare `vitest run` (no
# targeted path) in an ACTIVE, ENABLED step. Searching raw text would match a
# commented-out command (`# … vitest run`) or a step disabled with `if: false`.
# The awk tracks per-step `if: false|never`, skips comment lines, and requires
# the bare run line to be in an enabled step.
if ! awk '
	/^[[:space:]]*-[[:space:]]/ { disabled=0 }
	/if:[[:space:]]*(false|never)([[:space:]]|$)/ { disabled=1 }
	/^[[:space:]]*#/ { next }
	/cd packages\/web && bunx vitest run[[:space:]]*$/ { found=1; if (!disabled) active=1 }
	END { exit !(found && active) }
' "$REPO_ROOT/.github/workflows/main.yml"; then
	err "test-web CI job's bare 'cd packages/web && bunx vitest run' is missing, commented, or in a disabled (if: false|never) step — web coverage assumption broken"
	echo "     → keep an active, enabled bare vitest run step" >&2
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

# The online runner config (vitest.online.config.ts) determines which matrix
# paths Vitest actually executes — Vitest applies include/exclude even to
# explicitly-passed paths. Assert the include stays broad and the exclude
# doesn't drop tests/online/, or matrix paths could be filtered out while this
# guard (which only checks the matrix) stays green.
ONLINE_CFG="$REPO_ROOT/packages/daemon/vitest.online.config.ts"
if [ "$(active_hits "$ONLINE_CFG" "include: ['tests/online/**/*.test.ts']")" -eq 0 ]; then
	err "packages/daemon/vitest.online.config.ts active include is not tests/online/**/*.test.ts — online matrix paths could be filtered out"
	echo "     → keep the include broad, or update this validator" >&2
fi
# Require the exact exclude — a substring check for "tests/online/" misses a
# broad glob (e.g. tests/** or **/legacy/**) that would silently exclude online
# tests. node_modules/dist/tests/unit/** is the expected set (tests/unit/** keeps
# the online config from picking up unit suites).
if [ "$(active_hits "$ONLINE_CFG" "exclude: ['node_modules', 'dist', 'tests/unit/**']")" -eq 0 ]; then
	err "packages/daemon/vitest.online.config.ts active exclude is not ['node_modules','dist','tests/unit/**'] — a broad/changed glob could exclude online tests"
	echo "     → keep the exclude to node_modules/dist/tests/unit/**, or update this validator" >&2
fi

# Online matrix test_path values must reach the RUNNER command. Scope to lines
# that both interpolate ${{ matrix.test_path }} AND invoke the runner (`bun test`
# / `vitest`) — a docs `echo "Tests: ${{ matrix.test_path }}"` step must not
# satisfy this, and swapping the runner for a fixed target must fail.
for _wf in "$REPO_ROOT/.github/workflows/main.yml" "$REPO_ROOT/.github/workflows/real-api-tests.yml"; do
	_runner_uses=$(grep -hF '${{ matrix.test_path }}' "$_wf" 2>/dev/null \
		| grep -vE '^[[:space:]]*(#|//)' \
		| grep -cE 'bun test|vitest')
	if [ "${_runner_uses:-0}" -eq 0 ]; then
		err "$(basename "$_wf") online runner no longer consumes \${{ matrix.test_path }} (no active 'bun test'/'vitest' line with it) — online matrix values don't reach the runner"
		echo "     → keep '\${{ matrix.test_path }}' on the runner command" >&2
	fi
done

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

# providers/* online tests are intentionally disabled (codex bridge needs
# OPENAI_API_KEY, copilot has a credential issue — matrix entries commented out
# in main.yml), so the directory is in EXEMPT_DIRS below rather than checked
# here.

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
		# ACTIVE (non-commented) references only — a commented-out matrix entry
		# or a header comment must not satisfy this check, or a disabled shard
		# would still pass while its tests disappear from CI.
		# Count ACTIVE (non-commented) references across BOTH workflows. A split
		# file listed in its designated workflow AND echoed/added in the other
		# would run twice (wasted CI / paid real-provider calls), so the count
		# must be exactly one across the union.
		local active
		active=$(grep -hF "$test_path" "$MAIN_WORKFLOW" "$REAL_API_WORKFLOW" 2>/dev/null | grep -cvE '^[[:space:]]*#')
		if [ "${active:-0}" -eq 0 ]; then
			err "$test_path has no active reference in any CI workflow"
			echo "     → add it to the active matrix in $workflow" >&2
		elif [ "$active" -gt 1 ]; then
			err "$test_path has $active active references across workflows — duplicate shard ownership"
			echo "     → list it in exactly one matrix row in one workflow" >&2
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
		# Compare the module-RELATIVE path (not basename): a nested file whose
		# basename collides with a root-level entry (e.g. rpc/nested/x.test.ts
		# vs rpc/x.test.ts) must not be treated as the root file.
		local rel="${file#"$dir"/}"
		if ! grep -qxF "$rel" <<< "$expected_list"; then
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
	if [ "${dir_refs:-0}" -gt 1 ]; then
		# Exactly-one-shard contract: a directory referenced by two matrix rows
		# (or both workflows) runs every file under it twice — wasted CI and, for
		# real-provider shards, paid calls.
		err "online module directory '$dirname' has $dir_refs active directory-level references — duplicate shard ownership"
		echo "     → list it in exactly one matrix row" >&2
	fi
	if [ "${dir_refs:-0}" -gt 0 ]; then
		# Directory-level coverage: every file under it already runs once via the
		# dir row, so an ADDITIONAL file-level row for any of those files would
		# run it again — compare dir + file ownership together (can't have both).
		while IFS= read -r f; do
			rel="${f#"${dir%/}"/}"
			file_refs=$(grep -hF "tests/online/$dirname/$rel" "$MAIN_WORKFLOW" "$REAL_API_WORKFLOW" 2>/dev/null \
				| grep -cvE '^[[:space:]]*#')
			if [ "${file_refs:-0}" -gt 0 ]; then
				err "tests/online/$dirname/$rel is covered by both a directory-level row and a file-level row — duplicate shard ownership"
				echo "     → remove the file-level row (the directory-level row already covers it)" >&2
			fi
		done < <(find "$dir" -name "*.test.ts" -type f | sort)
		continue
	fi
	# No directory-level reference: each file needs its own active reference,
	# so a single-file module (e.g. agent) can't hide an uncovered sibling.
	# Match the module-RELATIVE path (not basename): a nested file whose basename
	# collides with a root-level entry (agent/nested/x.test.ts vs agent/x.test.ts)
	# must not be treated as the root file.
	while IFS= read -r f; do
		# $dir ends in '/' (from the */ glob) — normalize so the prefix strip
		# yields the module-relative path (e.g. nested/x.test.ts), not the full path.
		rel="${f#"${dir%/}"/}"
		file_refs=$(grep -hF "tests/online/$dirname/$rel" "$MAIN_WORKFLOW" "$REAL_API_WORKFLOW" 2>/dev/null \
			| grep -cvE '^[[:space:]]*#')
		if [ "${file_refs:-0}" -eq 0 ]; then
			err "online test not covered by any active CI shard: tests/online/$dirname/$rel"
			echo "     → add it to a matrix in $MAIN_WORKFLOW (or to EXEMPT_DIRS if the module is disabled)" >&2
		elif [ "$file_refs" -gt 1 ]; then
			err "tests/online/$dirname/$rel has $file_refs active references — duplicate shard ownership"
			echo "     → list it in exactly one matrix row" >&2
		fi
	done < <(find "$dir" -name "*.test.ts" -type f | sort)
done

# A test file placed directly under tests/online/ (not in a module subdir) is
# owned by no matrix row — every matrix test_path is tests/online/<module>/…, so
# a root-level file would never run while this guard (which only walks subdirs
# above) stays silent. Flag any.
while IFS= read -r f; do
	err "online test file directly under tests/online/ (no module dir owns it): ${f#"$REPO_ROOT"/}"
	echo "     → move it under a module dir that has a CI matrix shard" >&2
done < <(find "$ONLINE_DIR" -maxdepth 1 -name "*.test.ts" -type f | sort)

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
