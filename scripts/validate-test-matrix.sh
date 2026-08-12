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

# Print the FOLDED `run:` command of the ENABLED workflow step whose run command
# contains the literal marker $2 (in file $1). Folds `run: >-`/`|-` blocks AND
# handles single-line `run:`. Empty if no enabled step matches — i.e. the step is
# missing, commented, or disabled (`if: false|never`). Lets the wiring checks
# verify a matrix value actually reaches an enabled runner command.
enabled_run_cmd() {
	awk -v marker="$2" '
		function emit() { if (runval != "" && index(runval, marker) > 0 && !disabled && !job_disabled && !done) { print runval; done=1 } }
		# A job key (2-space indent under jobs:) starts a fresh job; reset its condition.
		/^[[:space:]]{2}[[:alnum:]_-]+:[[:space:]]*$/ { job_disabled=0 }
		/^[[:space:]]*-[[:space:]]/ { emit(); runval=""; disabled=0; incmd=0 }
		# if:false|never disables a step (>= 6 indent) or the whole job (<= 4 indent).
		# Accept the optional ${{ }} expression wrapper GitHub allows (if: ${{ false }}).
		/if:[[:space:]]*(\$\{\{[[:space:]]*)?(false|never)([[:space:]]|\}|$)/ { n=0; while (substr($0,n+1,1)==" ") n++; if (n <= 4) job_disabled=1; else disabled=1 }
		/^[[:space:]]*#/ { next }
		incmd { n=0; while (substr($0,n+1,1)==" ") n++; if (n > runindent) { runval=runval" "$0; next }; emit(); runval=""; incmd=0 }
		/^[[:space:]]*run:[[:space:]]*[>|]/ { incmd=1; n=0; while (substr($0,n+1,1)==" ") n++; runindent=n; runval=$0; next }
		/^[[:space:]]*run:[[:space:]]+/ { runval=$0; emit(); runval=""; incmd=0; next }
		END { emit() }
	' "$1"
}

# Count ACTIVE lines in workflow $1 that are a test_path VALUE for path $2 —
# either a folded bare-path line (`  tests/online/...`) or a single-line
# `test_path: tests/online/...`. Excludes a docs `echo tests/online/...` line
# (which has `echo` before the path) and comments. Dots are escaped.
test_path_value_hits() {
	local re
	re=$(printf '%s' "$2" | sed 's/[.]/\\&/g')
	grep -hE "(^[[:space:]]*${re}([[:space:]]|$))|(test_path:[[:space:]]*${re}([[:space:]]|$))" "$1" 2>/dev/null \
		| grep -cvE '^[[:space:]]*(#|//)'
}

# Print every ACTIVE test_path VALUE from workflow $1 — both the inline single
# form (`test_path: <value>`) and the folded multi form (`test_path: >-` / `|-`
# followed by indented value lines, which GitHub joins with spaces into one
# `${{ matrix.test_path }}`). Comments are skipped. Emitting the EXACT values
# (rather than substring-grepping disk files) lets the caller verify each one
# resolves to a real file/dir on disk — a typo like ".bak" or a stale path
# otherwise makes the shard's filter match nothing while this guard, which only
# checks that real files are referenced, stays green.
online_test_path_values() {
	awk '
		function trim(v) { sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v); return v }
		/^[[:space:]]*#/ { next }
		# Folded block marker: test_path: >-  or  test_path: |-
		/^[[:space:]]*test_path:[[:space:]]*[>|]-[[:space:]]*$/ {
			folding=1; base=0; while (substr($0, base+1, 1)==" ") base++; next
		}
		folding {
			n=0; while (substr($0, n+1, 1)==" ") n++
			if (n > base) { v=trim($0); if (v != "") print v; next }
			folding=0
			# fall through: a dedented line may open a new inline test_path
		}
		# Inline single value: the value starts with a non-space, non-fold-marker char
		/^[[:space:]]*test_path:[[:space:]]+[^[:space:]>|-]/ {
			v=$0; sub(/^[[:space:]]*test_path:[[:space:]]+/, "", v); v=trim(v); if (v != "") print v
		}
	' "$1"
}

# Print every value for `key:` (e.g. shard / module) that appears under a
# `matrix.exclude:` block in job $1 of main.yml. Handles BOTH YAML forms:
#   block:  exclude:        flow:  exclude: [{ shard: shared }, { shard: 1-core }]
#             - shard: shared
# Excludes drop GitHub combinations, so a shard/module present in the raw axis
# but excluded never runs — the callers treat these as absent from CI rather than
# accept their files as falsely covered.
matrix_excludes() {
	local job="$1" key="$2"
	awk -v job="$1" -v key="$2" '
		$0 ~ "^  " job ":" { injob=1; next }
		injob && /^  [a-z]/ { injob=0 }
		# Flow form: exclude: [ ... ] on one line — pull every "key: <token>" out of it.
		injob && $0 ~ "^[[:space:]]*exclude:[[:space:]]*\\[" {
			s=$0
			while (match(s, key ":[[:space:]]*[a-z0-9-]+")) {
				v=substr(s, RSTART, RLENGTH); sub(".*" key ":[[:space:]]*", "", v); print v
				s=substr(s, RSTART + RLENGTH)
			}
			next
		}
		# Block form: "exclude:" alone, then indented "- key: value" lines.
		injob && $0 ~ "^[[:space:]]*exclude:[[:space:]]*$" { inblock=1; next }
		injob && inblock && !/^[[:space:]]*#/ && !/^[[:space:]]*$/ {
			n=0; while (substr($0,n+1,1)==" ") n++
			if (n <= 8) { inblock=0; next }
			if (match($0, key ":[[:space:]]*[a-z0-9-]+")) {
				v=substr($0, RSTART, RLENGTH); sub(".*" key ":[[:space:]]*", "", v); print v
			}
		}
	' "$REPO_ROOT/.github/workflows/main.yml"
}

# Print a module→value map (one `module<TAB>value` line per test_path value) for
# workflow file $1, parsing the FOLDED-scalar CONTENTS — not just the `>-`/`|-`
# marker (the marker is non-space, so a naive `test_path:[[:space:]]*[^[:space:]]`
# test wrongly accepts `test_path: >-` with no value as nonempty). Lets callers
# count ACTUAL values per module so an empty test_path is caught.
module_values() {
	awk '
		function trim(v) { sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v); return v }
		/^[[:space:]]*#/ { next }
		/^[[:space:]]*- module:[[:space:]]*[a-z0-9-]+/ {
			mod=$0; sub(/^[[:space:]]*- module:[[:space:]]*/, "", mod); sub(/[[:space:]]*$/, "", mod)
			folding=0; next
		}
		mod && /test_path:[[:space:]]*[>|]-[[:space:]]*$/ { folding=1; base=0; while (substr($0, base+1, 1)==" ") base++; next }
		folding {
			n=0; while (substr($0, n+1, 1)==" ") n++
			if (n > base) { v=trim($0); if (v != "") print mod "\t" v; next }
			folding=0
		}
		mod && /test_path:[[:space:]]+[^[:space:]>|-]/ {
			v=$0; sub(/^.*test_path:[[:space:]]+/, "", v); v=trim(v); if (v != "") print mod "\t" v
		}
	' "$1"
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
# matrix.exclude under test-daemon-shared-unit drops combinations GitHub would
# otherwise schedule. A shard present in the raw `shard:` axis but excluded
# never runs, so accepting it as covered (it's in the raw axis) is a false
# positive. Parse excludes (block OR flow form) and treat those shards as
# absent from CI.
_unit_excluded=$(matrix_excludes "test-daemon-shared-unit" "shard")
for shard in "${SHARDS[@]}"; do
	# A shard removed by matrix.exclude is dropped by GitHub — its files never
	# run, so it must be treated as not-in-CI even though it appears in the raw
	# axis above. (Check before the exactly-once axis test.)
	if printf '%s\n' "$_unit_excluded" | grep -qxF "$shard"; then
		err "daemon unit shard '$shard' is in the CI unit matrix but removed by matrix.exclude — GitHub drops the combination, so its files never run while this guard reports them covered"
		echo "     → remove the exclude entry, or drop the shard from SHARDS in scripts/test-daemon.sh" >&2
		continue
	fi
	# Exactly-once: a shard must appear in the matrix once. Missing = its files
	# never run; duplicated = GitHub schedules it twice (duplicate test runs +
	# coverage uploads under the same flag).
	count=$(printf '%s\n' "$unit_matrix" | grep -xF "$shard" | wc -l | tr -d ' ')
	if [ "$count" -eq 0 ]; then
		err "daemon unit shard '$shard' is declared in test-daemon.sh SHARDS but missing from the CI unit matrix"
		echo "     → add it to the test-daemon-shared-unit matrix in .github/workflows/main.yml (or drop it from SHARDS)" >&2
	elif [ "$count" -gt 1 ]; then
		err "daemon unit shard '$shard' appears $count times in the CI unit matrix — duplicate (would run twice)"
		echo "     → list each shard exactly once" >&2
	fi
done

# The matrix value must reach an ENABLED runner. enabled_run_cmd finds the
# folded run command of the enabled step containing the marker; empty means the
# unit runner is missing, commented, or disabled (if:false), or no longer
# forwards ${{ matrix.shard }}. (Replacing it with a fixed shard would run one
# shard in every matrix job while this guard reported all as covered.)
if [ -z "$(enabled_run_cmd "$REPO_ROOT/.github/workflows/main.yml" 'test-daemon.sh ${{ matrix.shard }}')" ]; then
	err "test-daemon-shared-unit runner is missing, commented, disabled, or does not forward \${{ matrix.shard }} — unit matrix values don't reach the runner"
	echo "     → keep an active, enabled './scripts/test-daemon.sh \${{ matrix.shard }} ...' step" >&2
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
# positional target) in an ENABLED step, so the config include/exclude fully
# determine execution. enabled_run_cmd folds the runner command (a `>-` scalar)
# and skips disabled/commented steps; we then require `vitest run` to be followed
# by a flag (or the closing quote), not a positional path — a target on a folded
# continuation line would otherwise evade an end-of-physical-line check.
_web_cmd=$(enabled_run_cmd "$REPO_ROOT/.github/workflows/main.yml" 'cd packages/web && bunx vitest run')
if [ -z "$_web_cmd" ]; then
	err "test-web runner is missing, commented, or disabled (if: false|never) — web coverage assumption broken"
	echo "     → keep an active, enabled 'cd packages/web && bunx vitest run' step" >&2
elif [ -n "$(printf '%s' "$_web_cmd" \
		| sed 's/.*bunx vitest run//' \
		| sed -E -e 's/--reporter[[:space:]]+[^[:space:]]+//g' \
		         -e 's/--[[:alnum:]._-]+=[^[:space:]]+//g' \
		         -e 's/--[[:alnum:]_-]+//g' \
		| tr -d "[:space:]'\"")" ]; then
	# Strip known flags (--reporter <val>, --flag=<val>, bare --flags) after
	# `vitest run`; any leftover token is a positional [filter] (path OR a bare
	# word like `components`) that selects a subset of files — Vitest accepts
	# filters anywhere in the arg list, even after options.
	err "test-web runner passes a positional filter to 'vitest run' — web coverage assumption broken (only some files would run)"
	echo "     → keep 'vitest run' bare (flags only, no positional path)" >&2
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
# explicitly-passed paths. The include must cover BOTH suffixes this guard
# enumerates (*.test.ts AND *_test.ts): if the config matched only *.test.ts, a
# *_test.ts file under a directory-owned module would be counted as "covered"
# here yet filtered out by Vitest, so its shard would run it zero times. It must
# also not drop tests/online/ via the exclude, or matrix paths could be filtered
# out while this guard (which only checks the matrix) stays green.
ONLINE_CFG="$REPO_ROOT/packages/daemon/vitest.online.config.ts"
if [ "$(active_hits "$ONLINE_CFG" "include: ['tests/online/**/*.test.ts', 'tests/online/**/*_test.ts']")" -eq 0 ]; then
	err "packages/daemon/vitest.online.config.ts active include must be ['tests/online/**/*.test.ts', 'tests/online/**/*_test.ts'] — a *_test.ts file enumerated as covered must actually be run, not filtered out"
	echo "     → keep the include covering both *.test.ts and *_test.ts" >&2
fi
# Require the exact exclude — a substring check for "tests/online/" misses a
# broad glob (e.g. tests/** or **/legacy/**) that would silently exclude online
# tests. node_modules/dist/tests/unit/** is the expected set (tests/unit/** keeps
# the online config from picking up unit suites).
if [ "$(active_hits "$ONLINE_CFG" "exclude: ['node_modules', 'dist', 'tests/unit/**']")" -eq 0 ]; then
	err "packages/daemon/vitest.online.config.ts active exclude is not ['node_modules','dist','tests/unit/**'] — a broad/changed glob could exclude online tests"
	echo "     → keep the exclude to node_modules/dist/tests/unit/**, or update this validator" >&2
fi

# Online matrix test_path values must reach an ENABLED runner that forwards
# ${{ matrix.test_path }}. The marker picks the runner step itself
# (vitest.online.config.ts in main.yml; `bun test` in real-api — NOT the docs
# `echo "Tests: …"` step), so a commented/disabled (if:false) runner, or one
# swapped for a fixed target, fails.
_online_main=$(enabled_run_cmd "$REPO_ROOT/.github/workflows/main.yml" 'vitest.online.config.ts')
if [ -z "$_online_main" ] || ! printf '%s' "$_online_main" | grep -qF '${{ matrix.test_path }}'; then
	err "main.yml online runner is missing, commented, disabled, or does not forward \${{ matrix.test_path }} — online matrix values don't reach the runner"
	echo "     → keep an active, enabled 'vitest ... \${{ matrix.test_path }}' step" >&2
fi
_online_real=$(enabled_run_cmd "$REPO_ROOT/.github/workflows/real-api-tests.yml" 'bun test')
if [ -z "$_online_real" ] || ! printf '%s' "$_online_real" | grep -qF '${{ matrix.test_path }}'; then
	err "real-api-tests.yml online runner is missing, commented, disabled, or does not forward \${{ matrix.test_path }} — online matrix values don't reach the runner"
	echo "     → keep an active, enabled 'bun test \${{ matrix.test_path }}' step" >&2
fi

# Every online `module:` axis entry must have an include record with a non-empty
# test_path. An axis module with no include gets an EMPTY ${{ matrix.test_path }},
# so the runner becomes an UNFILTERED vitest/bun run that executes the ENTIRE
# online suite (duplicates tests across jobs, reaches intentionally-exempt dirs).
_axis_modules=$(awk '
	/^  test-daemon-online:/ { injob=1 }
	injob && /^[[:space:]]*module:[[:space:]]*$/ { inaxis=1; next }
	injob && /^[[:space:]]*include:/ { inaxis=0 }
	inaxis && !/^[[:space:]]*#/ && /^[[:space:]]+- [a-z][a-z0-9-]+[[:space:]]*$/ { sub(/^[[:space:]]+- /, ""); print }
' "$MAIN_WORKFLOW")
# Build a module→value map (parses folded-scalar CONTENTS, not just the marker —
# see module_values) so the orphan check can count ACTUAL values per module.
_module_values=$(module_values "$MAIN_WORKFLOW")
for _m in $_axis_modules; do
	_count=$(printf '%s\n' "$_module_values" | awk -F'\t' -v m="$_m" '$1 == m { c++ } END { print c+0 }')
	if [ "$_count" -eq 0 ]; then
		err "online matrix module '$_m' has no include record with a non-empty test_path — \${{ matrix.test_path }} would be empty (or a folded >- with no values) → unfiltered run of the entire online suite"
		echo "     → add an include: entry for '$_m' with a test_path, or drop it from the module axis" >&2
	fi
done

# Symmetric check for real-api-tests.yml: its daemon-real-api job is an
# include-only matrix (no `module:` axis), so every include row IS a combination
# that runs `bun test ${{ matrix.test_path }}`. A row without a non-empty
# test_path expands to a bare `bun test`, which `bun test --help` documents as
# "Run all test files" — running the entire online suite (and, with real keys,
# paid provider calls). The main.yml orphan check above doesn't cover this file.
_real_module_values=$(module_values "$REAL_API_WORKFLOW")
_real_include_modules=$(awk '
	/^[[:space:]]*#/ { next }
	/^[[:space:]]*- module:[[:space:]]*[a-z0-9-]+/ {
		m=$0; sub(/^[[:space:]]*- module:[[:space:]]*/, "", m); sub(/[[:space:]]*$/, "", m); print m
	}
' "$REAL_API_WORKFLOW")
for _rm in $_real_include_modules; do
	_rcount=$(printf '%s\n' "$_real_module_values" | awk -F'\t' -v m="$_rm" '$1 == m { c++ } END { print c+0 }')
	if [ "$_rcount" -eq 0 ]; then
		err "real-api include row for module '$_rm' has no non-empty test_path — \${{ matrix.test_path }} would expand empty, so 'bun test' runs the entire online suite"
		echo "     → add a test_path to the row, or remove it" >&2
	fi
done

# Every active module-axis value must occur EXACTLY once. GitHub expands each
# axis entry into a separate job, so a duplicated value (e.g. two `- components`
# rows sharing one include) runs the same test_path twice — wasted CI and, for
# real-provider shards, paid calls. The orphan check above only verifies each
# name resolves to a path; it never counts occurrences.
_dup_axis=$(printf '%s\n' "$_axis_modules" | sort | uniq -d)
if [ -n "$_dup_axis" ]; then
	while IFS= read -r _d; do
		[ -n "$_d" ] || continue
		err "online module-axis value '$_d' appears more than once — GitHub expands both entries, running the same test_path in duplicate jobs"
		echo "     → list each module exactly once in the module: axis" >&2
	done <<< "$_dup_axis"
fi

# Every active `include:` module must ALSO be in the `module:` axis. GitHub
# treats an include row whose module is NOT in the axis as an ADDITIONAL
# combination (it cannot augment any existing axis entry), so it silently
# schedules a job this guard never authorized — running a test_path even for a
# module that was intentionally disabled (e.g. glm, which sits in EXEMPT_DIRS
# precisely because it is commented out of the axis). The checks above only
# iterate `_axis_modules`, so such an include-only row is otherwise invisible.
_include_modules=$(awk '
	/^[[:space:]]*#/ { next }
	/^[[:space:]]*- module:[[:space:]]*[a-z0-9-]+/ {
		m=$0; sub(/^[[:space:]]*- module:[[:space:]]*/, "", m); sub(/[[:space:]]*$/, "", m); print m
	}
' "$MAIN_WORKFLOW")
for _im in $_include_modules; do
	if ! printf '%s\n' "$_axis_modules" | grep -qxF "$_im"; then
		err "online include row for module '$_im' is not in the module: axis — GitHub creates an extra matrix combination for it, running its test_path even if the module was intentionally disabled"
		echo "     → add '$_im' to the module: axis, or comment out / remove the include row" >&2
	fi
done

# Symmetric to the unit exclude check: a `matrix.exclude` under
# test-daemon-online drops a module combination, but `_axis_modules` reads the
# raw axis, so every downstream ownership check would still treat that module
# (and its directory's tests) as scheduled. Reject excludes outright — this
# guard models disabling via EXEMPT_DIRS / commenting out the axis entry, so a
# matrix.exclude is a configuration it cannot soundly validate.
_online_excluded=$(matrix_excludes "test-daemon-online" "module")
if [ -n "$_online_excluded" ]; then
	while IFS= read -r _em; do
		[ -n "$_em" ] || continue
		err "online module '$_em' is excluded via matrix.exclude — GitHub drops the combination, so its tests never run while this guard reports them covered"
		echo "     → remove the exclude, or disable the module by commenting out its axis entry / listing its dir in EXEMPT_DIRS" >&2
	done <<< "$_online_excluded"
fi

# Every test_path VALUE (inline or folded, either workflow) must resolve to a
# real file or directory on disk. A typo (e.g. a ".bak" suffix) or stale path
# makes the shard's `bun test`/`vitest` filter match nothing, so that job exits 0
# having run ZERO files — a coverage hole the per-disk-file walk below cannot
# see: it only checks that real files are referenced, not that references are
# real. Exact-value parsing (online_test_path_values) is what makes ".bak"
# visible — the disk file's path is a substring of ".bak", so the old substring
# grep reported it covered.
while IFS= read -r _tp; do
	[ -n "$_tp" ] || continue
	_full="$REPO_ROOT/packages/daemon/$_tp"
	if [ ! -e "$_full" ]; then
		err "online test_path value '$_tp' does not exist on disk — CI would run zero files for that shard"
		echo "     → fix the path, or remove the matrix row" >&2
	elif [ -d "$_full" ]; then
		# Directory-level test_path: Vitest auto-discovers test files under it, so
		# the directory must contain at least one — otherwise the filter matches
		# nothing and `bun test`/`vitest` exits 0 having run ZERO tests (a hole the
		# per-disk-file walk below cannot see, since it has no file to flag).
		if ! find "$_full" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) -print -quit | grep -q .; then
			err "online test_path directory '$_tp' contains no test files — CI would run zero files for that shard"
			echo "     → add a test file under it, point test_path at a specific file, or remove the matrix row" >&2
		fi
	fi
done < <(online_test_path_values "$MAIN_WORKFLOW"; online_test_path_values "$REAL_API_WORKFLOW")

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
	task-agent-lifecycle.test.ts
	task-agent-skills.test.ts
	prompt-too-long-kimi-recovery.test.ts
)

check_workflow_references() {
	local module_name=$1
	local workflow=$2
	shift 2
	local expected=("$@")
	local other_wf
	if [ "$workflow" = "$MAIN_WORKFLOW" ]; then other_wf="$REAL_API_WORKFLOW"; else other_wf="$MAIN_WORKFLOW"; fi

	for f in "${expected[@]}"; do
		local test_path="tests/online/$module_name/$f"
		# A split file must be a test_path VALUE in its DESIGNATED workflow, and
		# NOT in the other (a docs echo mentioning the path doesn't count; a file
		# moved to the other workflow is a missing owner here + a duplicate there).
		local designated other
		designated=$(test_path_value_hits "$workflow" "$test_path")
		other=$(test_path_value_hits "$other_wf" "$test_path")
		if [ "${designated:-0}" -eq 0 ]; then
			err "$test_path is not a test_path value in its designated workflow $workflow"
			echo "     → add it to a matrix row in $workflow" >&2
		elif [ "${designated:-0}" -gt 1 ]; then
			err "$test_path is a test_path value in $designated rows of $workflow — duplicate shard ownership (would run twice)"
			echo "     → list it in exactly one matrix row" >&2
		elif [ "${other:-0}" -gt 0 ]; then
			err "$test_path is a test_path value in both $workflow and $other_wf — duplicate shard ownership"
			echo "     → list it in exactly one workflow" >&2
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
		# A split module with expected files whose directory vanished means CI's
		# test_path filters match nothing — `bun test`/`vitest` exit 0 with "filters
		# did not match any test files", so every matrix job stays green with zero
		# tests run. That's a coverage hole, not a warning. Only an intentionally
		# empty module (e.g. room) stays a warning. Count non-empty expected entries
		# (an empty ROOM_FILES=[] can arrive as one empty-string arg via ${arr[@]:-}).
		local n=0 f
		for f in "${expected[@]}"; do [ -n "$f" ] && n=$((n + 1)); done
		if [ "$n" -gt 0 ]; then
			err "split module directory $dir is missing but $workflow expects $n test_path(s) — CI would run zero tests"
			echo "     → restore the directory, or clear the module's expected files" >&2
		else
			echo "WARNING: split module directory $dir does not exist (empty module)"
		fi
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
	done < <(find "$dir" \( -name "*.test.ts" -o -name "*_test.ts" \) -type f | sort)

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
	# A directory-level reference (test_path: tests/online/<dir>) covers every
	# file under it. Require the `test_path:` prefix so a docs/echo line that
	# merely mentions the path can't pose as coverage. Match tests/online/<dir>
	# NOT followed by a char that could extend the dir name.
	dir_refs=$(grep -hE "tests/online/$dirname([^/[:alnum:]_-]|$)" "$MAIN_WORKFLOW" "$REAL_API_WORKFLOW" 2>/dev/null \
		| grep -F 'test_path:' \
		| grep -cvE '^[[:space:]]*#')
	if [[ " $EXEMPT_DIRS " == *" $dirname "* ]] || [[ " $SPLIT_DIRS " == *" $dirname "* ]]; then
		# Exempt dirs are intentionally not run; split dirs are owned file-by-file
		# via check_split_module. A DIRECTORY-level test_path owner is wrong either
		# way: it re-enables a disabled module (exempt), or runs every file under
		# the dir AGAIN on top of the explicit rows (split) — duplicating tests
		# and, for real-API split modules like cross-provider, repeating paid
		# provider calls. The old code `continue`d before checking, hiding it.
		if [ "${dir_refs:-0}" -gt 0 ]; then
			err "online directory 'tests/online/$dirname' has a directory-level test_path owner but is a split/exempt module — files under it would run on top of their explicit rows (or re-enable a disabled module)"
			echo "     → point test_path at specific files (split module), or remove the row (exempt module)" >&2
		fi
		continue
	fi
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
			# EXACT test_path value match (test_path_value_hits anchors the path
			# with a trailing whitespace/EOL), not a substring grep — otherwise a
			# typo'd longer value like "x.test.ts.bak" substring-matches the real
			# file and hides the duplicate.
			_tp="tests/online/$dirname/$rel"
			file_refs=$(( $(test_path_value_hits "$MAIN_WORKFLOW" "$_tp") + $(test_path_value_hits "$REAL_API_WORKFLOW" "$_tp") ))
			if [ "${file_refs:-0}" -gt 0 ]; then
				err "tests/online/$dirname/$rel is covered by both a directory-level row and a file-level row — duplicate shard ownership"
				echo "     → remove the file-level row (the directory-level row already covers it)" >&2
			fi
		done < <(find "$dir" \( -name "*.test.ts" -o -name "*_test.ts" \) -type f | sort)
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
		# EXACT test_path value match (test_path_value_hits anchors the path with a
		# trailing whitespace/EOL), not a substring grep. A substring grep would
		# report a disk file covered when the matrix actually points at a longer
		# typo'd value (e.g. "agent-session-sdk.test.ts.bak"): the real path is a
		# substring of ".bak", so it matches, yet the shard filter matches nothing
		# and runs zero files. (Stale values are also caught by the exact-value
		# existence check above.)
		_tp="tests/online/$dirname/$rel"
		file_refs=$(( $(test_path_value_hits "$MAIN_WORKFLOW" "$_tp") + $(test_path_value_hits "$REAL_API_WORKFLOW" "$_tp") ))
		if [ "${file_refs:-0}" -eq 0 ]; then
			err "online test not covered by any active CI shard: tests/online/$dirname/$rel"
			echo "     → add it to a matrix in $MAIN_WORKFLOW (or to EXEMPT_DIRS if the module is disabled)" >&2
		elif [ "$file_refs" -gt 1 ]; then
			err "tests/online/$dirname/$rel has $file_refs active references — duplicate shard ownership"
			echo "     → list it in exactly one matrix row" >&2
		fi
	done < <(find "$dir" \( -name "*.test.ts" -o -name "*_test.ts" \) -type f | sort)
done

# A test file placed directly under tests/online/ (not in a module subdir) is
# owned by no matrix row — every matrix test_path is tests/online/<module>/…, so
# a root-level file would never run while this guard (which only walks subdirs
# above) stays silent. Flag any.
while IFS= read -r f; do
	err "online test file directly under tests/online/ (no module dir owns it): ${f#"$REPO_ROOT"/}"
	echo "     → move it under a module dir that has a CI matrix shard" >&2
done < <(find "$ONLINE_DIR" -maxdepth 1 \( -name "*.test.ts" -o -name "*_test.ts" \) -type f | sort)

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
