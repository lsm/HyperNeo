#!/bin/bash
# test-daemon.sh — Run daemon unit tests with parallel shards and failure summary.
#
# Requires: node + vitest (per-package devDependencies), python3 (for --show-failures)
#
# Usage:
#   ./scripts/test-daemon.sh                # All shards in parallel (fast, no coverage)
#   ./scripts/test-daemon.sh --coverage     # All shards with coverage
#   ./scripts/test-daemon.sh 5-space-a # Run a single shard
#   ./scripts/test-daemon.sh --rerun        # Rerun only previously failing files
#   ./scripts/test-daemon.sh --show-failures # Show failure details from last run
#   ./scripts/test-daemon.sh --verify       # Validate shard config without running tests

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$REPO_ROOT"

export HYPERNEO_ALLOW_ROOT_TEST=1

# Free-tier squeeze (task #1399 rebalance): the CI matrix runs these 6 shards
# — one runner each, ~50s fixed setup per job, so shards are duration-merged
# to keep the whole PR run inside the repo's 20 concurrent runners. Measured
# CI junit times (2026-08-24 rebalance run) per shard:
#   shared 7s · 1-core ~80s (whole tree + migration bucket 0) ·
#   handlers-migrations ~130s · storage-migrations ~105s · 5-space-a/b ~117s
#   each (weighted 2-way over the whole 5-space tree; the 117s migration
#   chain is dealt 3-way across the three directory legs). Rebalance with the
#   CI balance report + test:generate-shard-weights; no shard should exceed
#   ~2min of test time.
SHARDS=(
	shared
	1-core
	handlers-migrations
	storage-migrations
	5-space-a
	5-space-b
)
RESULTS_DIR="$REPO_ROOT/test-results/daemon"
FAILURES_FILE="$RESULTS_DIR/failures.txt"
TEST_ROOT="$REPO_ROOT/packages/daemon/tests/unit"

# Reusable directory sharding by stable hash (no hand-listed file lists).
# shellcheck disable=SC1091 # path is dynamic via $REPO_ROOT
source "$REPO_ROOT/scripts/lib/shard-split.sh"

# ── Hash-split shard configuration ──────────────────────────────────────────
# Oversized directories are split into N buckets by stableHash(repo-root-relative
# path) % N (see scripts/lib/shard-split.sh), so a new test file auto-routes to a
# bucket with NO manual file list. The file LIST is the only thing eliminated —
# rebalancing is editing one number (the split count) plus adding/removing the
# matching -a/-b/… shard entry, never editing individual files (see below).
#
# One line per split. Format:  <prefix>|<split_count>|<globs>[|<weights>]
#   <prefix>       public shard-name prefix; buckets are <prefix>-a, -b, -c, …
#                  with the suffix letter mapping to a 0-based bucket index
#                  (a→0, b→1, … up to z→25).
#   <split_count>  N — the number to edit when rebalancing.
#   <globs>        ';'-separated bash globs (relative to $TEST_ROOT) whose union
#                  is the directory's complete test set. Daemon vitest also runs
#                  `*_test.ts`, so list that glob too wherever such files exist
#                  (--verify's find cross-check covers both suffixes and will
#                  flag a missing one).
#   <weights>      OPTIONAL opt-in to duration-aware bucket assignment: path of
#                  a weights manifest (repo-root-relative, e.g.
#                  scripts/shard-weights.tsv) mapping test files to measured
#                  durations. Files listed there are assigned by greedy
#                  time-packing instead of the hash; files absent keep
#                  stableHash % N, so new test files still auto-route. The
#                  manifest is generated, never hand-edited:
#                  bun run scripts/generate-shard-weights.ts --suite daemon-unit <junit...>
#
# Changing N also means adding/removing the matching -a/-b/… entry in the SHARDS
# list below and in the CI matrix at .github/workflows/main.yml — but a FILE LIST
# is never edited by hand. Validate any change with: ./scripts/test-daemon.sh --verify
HASH_SPLIT_SPECS=(
	"5-space|2|5-space/*.test.ts;5-space/actions/*.test.ts;5-space/agent/*.test.ts;5-space/goals/*.test.ts;5-space/other/*.test.ts;5-space/tools/*.test.ts;5-space/workflow/*.test.ts;5-space/runtime/*.test.ts;5-space/runtime/connectors/*.test.ts;5-space/workspaces/*.test.ts|scripts/shard-weights.tsv"
)

# Map a hash-split shard's suffix letter to a 0-based bucket index (a→0 … z→25).
shard_suffix_to_index() {
	local s="$1"
	[ "${#s}" -eq 1 ] || return 1
	case "$s" in [a-z]) ;; *) return 1 ;; esac
	echo $(( $(printf '%d' "'$s") - 97 ))
}

# Inverse of shard_suffix_to_index: 0→a, 1→b, … (valid for 0..25). Used by
# --verify to derive the expected shard name for a bucket index.
shard_index_to_suffix() {
	local i="$1"
	local letters="abcdefghijklmnopqrstuvwxyz"
	[[ "$i" =~ ^[0-9]+$ ]] && [ "$i" -ge 0 ] && [ "$i" -le 25 ] || return 1
	printf '%s' "${letters:i:1}"
}

# Resolve a hash-split shard name (e.g. 5-space-a) to its bucket's files.
# Prints absolute test paths and returns 0 on a match, 1 if $1 is not a hash split.
# A spec with a 4th <weights> field resolves its bucket by duration-aware packing
# (see HASH_SPLIT_SPECS above); the union of buckets is the full glob set either way.
hash_split_resolve() {
	local shard="$1"
	local spec prefix count globs weights suffix bucket
	for spec in "${HASH_SPLIT_SPECS[@]}"; do
		IFS='|' read -r prefix count globs weights <<<"$spec"
		case "$shard" in
			"$prefix"-*)
				suffix="${shard#"$prefix"-}"
				bucket=$(shard_suffix_to_index "$suffix") || return 1
				local abs=() g
				local IFS=';'
				for g in $globs; do abs+=("$TEST_ROOT/$g"); done
				if [ -n "$weights" ]; then
					shard_split_bucket_weighted "$REPO_ROOT" "$REPO_ROOT/$weights" "$count" "$bucket" "${abs[@]}"
				else
					shard_split_bucket "$REPO_ROOT" "$count" "$bucket" "${abs[@]}"
				fi
				return $?
				;;
		esac
	done
	return 1
}

# Validate the shard configuration without running any tests:
#   - every shard in SHARDS resolves to at least one existing file;
#   - each hash-split's split_count is consistent with SHARDS (every bucket
#     -a/-b/… has a SHARDS entry, and none is stale) — catches a rebalance that
#     bumps N without wiring in the new bucket, which would silently drop a
#     whole bucket from CI;
#   - each hash-split's globs capture its directory tree exactly. The cross-check
#     uses an independent `find` over BOTH daemon test suffixes (*.test.ts and
#     *_test.ts, matching vitest.config) so its net is strictly wider than the
#     spec globs — a file the globs miss (new suffix, new subdir) shows up as
#     find_count != total and fails --verify;
#   - buckets partition that set with no overlap (weighted specs partition by
#     their PACKED assignment — the one CI actually runs);
#   - a spec with a <weights> manifest gets a manifest audit (present,
#     well-formed, no stale paths) plus per-bucket TIME balance in the report;
#   - per-bucket balance is reported, and an empty bucket is warned about.
# Exits non-zero on any error. Used by CI (see .github/workflows/main.yml).
verify_shards() {
	local errors=0
	local warnings=0
	local shard paths p

	echo "Verifying daemon shard configuration..."

	# 1. Every declared shard resolves to at least one existing path.
	for shard in "${SHARDS[@]}"; do
		paths=($(shard_paths "$shard"))
		if [ "${#paths[@]}" -eq 0 ]; then
			echo "  ERROR: shard '$shard' resolved to 0 files" >&2
			errors=$((errors + 1))
			continue
		fi
		for p in "${paths[@]}"; do
			if [ ! -e "$p" ]; then
				echo "  ERROR: shard '$shard' references missing path: $p" >&2
				errors=$((errors + 1))
			fi
		done
	done

	# 2. Each hash-split is internally consistent and covers its directory tree.
	local spec prefix count globs weights manifest
	for spec in "${HASH_SPLIT_SPECS[@]}"; do
		IFS='|' read -r prefix count globs weights <<<"$spec"
		manifest=""
		if [ -n "$weights" ]; then
			manifest="$REPO_ROOT/$weights"
		fi

		# 2a. split_count ↔ SHARDS + CI-matrix consistency. Derive the expected
		# bucket shard names (prefix-a … prefix-<letter(count-1)>) and require
		# each to be in SHARDS AND in the CI matrix workflow file, with no stray
		# prefix-* entries in SHARDS. Otherwise bumping N silently drops a bucket
		# from CI (the union check below is an identity and won't catch it).
		local bi=0 expected=() suffix ename found
		while [ "$bi" -lt "$count" ]; do
			if suffix=$(shard_index_to_suffix "$bi"); then
				expected+=("$prefix-$suffix")
			else
				echo "  ERROR: '$prefix' split_count=$count exceeds the a-z bucket range" >&2
				errors=$((errors + 1))
				break
			fi
			bi=$((bi + 1))
		done
		local workflow="$REPO_ROOT/.github/workflows/main.yml"
		# Parse the active shard matrix once: extract the `shard: [...]` flow
		# sequence and normalize to one token per line. Membership is checked
		# against THIS parsed list (grep -qxF per token), never by grepping the
		# whole file — a commented-out matrix entry (`# 5-space-b`) must
		# not satisfy the check, or CI silently drops the bucket.
		local matrix_tokens=""
		if [ -f "$workflow" ]; then
			matrix_tokens=$(grep -E '^[[:space:]]*shard:[[:space:]]*\[' "$workflow" \
				| head -n1 \
				| sed -E 's/^[^[]*\[//; s/\].*$//' \
				| tr ',' '\n' \
				| sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
		fi
		if [ -z "$matrix_tokens" ]; then
			echo "  ERROR: could not parse a 'shard: [...]' matrix in $workflow -- --verify can't confirm CI wiring" >&2
			errors=$((errors + 1))
		fi
		if [ "${#expected[@]}" -gt 0 ]; then
			for ename in "${expected[@]}"; do
				if ! printf '%s\n' "${SHARDS[@]}" | grep -qxF "$ename"; then
					echo "  ERROR: '$ename' is missing from SHARDS (split_count=$count for '$prefix'). Add it + the CI matrix entry, or lower split_count." >&2
					errors=$((errors + 1))
				fi
				if [ -n "$matrix_tokens" ] && ! printf '%s\n' "$matrix_tokens" | grep -qxF "$ename"; then
					echo "  ERROR: '$ename' is in SHARDS but missing from the active shard matrix in .github/workflows/main.yml" >&2
					errors=$((errors + 1))
				fi
			done
			for shard in "${SHARDS[@]}"; do
				case "$shard" in
					"$prefix"-*)
						found=0
						for ename in "${expected[@]}"; do [ "$ename" = "$shard" ] && found=1 && break; done
						if [ "$found" -eq 0 ]; then
							echo "  ERROR: SHARDS has '$shard' but split_count=$count for '$prefix'. Remove it or raise split_count." >&2
							errors=$((errors + 1))
						fi
						;;
				esac
			done
		fi

		# 2b. Globs capture the directory tree. Expand globs and the directories
		# they scope; the find cross-check enumerates BOTH daemon test suffixes so
		# its net is wider than the spec globs.
		local abs=() g dirs=()
		local IFS=';'
		for g in $globs; do
			abs+=("$TEST_ROOT/$g")
			dirs+=("$TEST_ROOT/$(dirname "$g")")
		done

		# 2b-w. A spec that opts into a weights manifest gets the manifest audit:
		# present on disk, well-formed lines, no stale paths, and a coverage
		# summary (weighted vs hash-fallback). A rotted manifest fails loudly
		# here instead of silently degrading to hash-only balance.
		if [ -n "$manifest" ]; then
			if ! shard_split_weights_check "$REPO_ROOT" "$manifest" "$count" "${abs[@]}"; then
				errors=$((errors + 1))
			fi
		fi

		local total find_count
		total=$(shard_split_count "$REPO_ROOT" "${abs[@]}")
		# Independent enumeration over both *.test.ts and *_test.ts (vitest runs
		# both); -type f excludes the directories themselves. A glob that misses
		# a new file/suffix/subdir surfaces as find_count != total.
		find_count=$(find "${dirs[@]}" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) | sort -u | wc -l | tr -d ' ')
		if [ "$find_count" -ne "$total" ]; then
			echo "  ERROR: '$prefix' globs match $total file(s) but find reports $find_count (both suffixes) — a glob is missing files (e.g. a *_test.ts)" >&2
			errors=$((errors + 1))
		fi

		# 2c. Union of all buckets must equal the total (no file dropped/doubled).
		# Weighted specs union their PACKED buckets — the assignment CI runs.
		local i=0 union=""
		while [ "$i" -lt "$count" ]; do
			if [ -n "$manifest" ]; then
				union+=$(shard_split_bucket_weighted "$REPO_ROOT" "$manifest" "$count" "$i" "${abs[@]}")$'\n'
			else
				union+=$(shard_split_bucket "$REPO_ROOT" "$count" "$i" "${abs[@]}")$'\n'
			fi
			i=$((i + 1))
		done
		local union_unique
		union_unique=$(printf '%s' "$union" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')
		if [ "$union_unique" -ne "$total" ]; then
			echo "  ERROR: '$prefix' buckets cover $union_unique/$total files (expected exact coverage)" >&2
			errors=$((errors + 1))
		fi

		# 2d. Report balance; warn on empty buckets (a CI shard would run nothing).
		# Weighted specs also report the packed TIME per bucket (sum of measured
		# durations) — the balance dimension that motivated the manifest.
		local rep zero z
		if [ -n "$manifest" ]; then
			rep=$(shard_split_report_weighted "$REPO_ROOT" "$manifest" "$count" "${abs[@]}")
			printf '  %-18s %d-way split, %d files (duration-weighted via %s):\n' "$prefix" "$count" "$total" "$weights"
			printf '%s\n' "$rep" | awk -F'\t' '{printf "      bucket %s: %s file(s), %.1fs weighted\n", $1, $2, $3 / 1000}'
		else
			rep=$(shard_split_report "$REPO_ROOT" "$count" "${abs[@]}")
			printf '  %-18s %d-way split, %d files:\n' "$prefix" "$count" "$total"
			printf '%s\n' "$rep" | awk -F'\t' '{printf "      bucket %s: %s file(s)\n", $1, $2}'
		fi
		zero=$(printf '%s\n' "$rep" | awk -F'\t' '$2 == 0 {print $1}')
		for z in $zero; do
			echo "  WARNING: '$prefix' bucket $z resolved to 0 files — a CI shard would run nothing" >&2
			warnings=$((warnings + 1))
		done
	done

	if [ "$errors" -gt 0 ]; then
		echo ""
		echo "FAILED: $errors shard configuration error(s)." >&2
		exit 1
	fi
	echo ""
	if [ "$warnings" -gt 0 ]; then
		echo "Shard configuration OK with $warnings warning(s)."
	else
		echo "Shard configuration OK."
	fi
}

# Split storage migration tests dynamically so new files are picked up without
# editing this script. Bash glob order is deterministic. The 117s migration
# chain is dealt 3-way (modulo over glob order) across the 1-core,
# handlers-migrations, and storage-migrations legs so no single leg carries it
# all (task #1399 rebalance).
migration_shard_paths() {
	local bucket="$1"
	local files=(
		"$TEST_ROOT/4-space-storage/storage"/migration*.test.ts
		"$TEST_ROOT/4-space-storage/storage/migrations"/*.test.ts
		"$TEST_ROOT/4-space-storage/storage/migrations"/*_test.ts
	)
	local index=0
	local file

	for file in "${files[@]}"; do
		[ -e "$file" ] || continue
		if [ $((index % 3)) -eq "$bucket" ]; then
			printf '%s\n' "$file"
		fi
		index=$((index + 1))
	done
}

# Map shard name to one or more test paths. Shards are balanced by CI wall time.
shard_paths() {
	# Hash-split shards (e.g. 5-space-a/b) are resolved dynamically by
	# stable hash — no hand-listed files. See HASH_SPLIT_SPECS above.
	local resolved
	if resolved=$(hash_split_resolve "$1"); then
		printf '%s\n' "$resolved"
		return 0
	fi

	case "$1" in
	shared)
		# Under Vitest each test file is module-isolated, so the old "shared first"
		# ordering (to avoid bun mock.module leakage) no longer applies; shared runs
		# here with its own vitest config.
		printf '%s\n' "$REPO_ROOT/packages/shared/tests"
		;;
	1-core)
		# The whole 1-core tree plus its helpers/lib satellites (~80s measured)
		# and migration bucket 0 — one unsplit leg (task #1399 rebalance: the
		# former 2-way split made two ~40s legs while online legs carried ~150s).
		# Directory args are recursive in vitest; a new 1-core subdirectory is
		# picked up automatically.
		printf '%s\n' \
			"$TEST_ROOT/1-core" \
			"$TEST_ROOT/helpers" \
			"$TEST_ROOT/lib/acp" \
			"$TEST_ROOT/lib/job-handlers" \
			"$TEST_ROOT/lib/runtime-server.test.ts" \
			"$TEST_ROOT/lib/runtime-spawn.test.ts"
		migration_shard_paths 0
		;;
	handlers-migrations)
		# The whole 2-handlers tree plus migration bucket 1. A new 2-handlers
		# subdirectory must be listed here — validate-test-matrix.sh fails
		# loudly on any uncovered unit test file, so it cannot be silently
		# dropped from CI.
		printf '%s\n' \
			"$TEST_ROOT/2-handlers/db-query" \
			"$TEST_ROOT/2-handlers/github" \
			"$TEST_ROOT/2-handlers/job-handlers" \
			"$TEST_ROOT/2-handlers/mcp" \
			"$TEST_ROOT/2-handlers/routes" \
			"$TEST_ROOT/2-handlers/rpc" \
			"$TEST_ROOT/2-handlers/rpc-handlers" \
			"$TEST_ROOT/2-handlers/short-id"
		migration_shard_paths 1
		;;
	storage-migrations)
		# 4-space-storage (non-migration files) plus migration bucket 2.
		printf '%s\n' "$TEST_ROOT/4-space-storage"/*.test.ts "$TEST_ROOT/4-space-storage/app"
		for file in "$TEST_ROOT/4-space-storage/storage"/*.test.ts; do
			case "$(basename "$file")" in
			migration-*) ;;
			*) printf '%s\n' "$file" ;;
			esac
		done
		migration_shard_paths 2
		;;
	# 5-space-a/b are resolved by hash_split_resolve above
	# (duration-weighted packing over the full tree, so no file is ever
	# hand-listed or dropped).
	*)
		return 1
		;;
	esac
}

# When sourced (e.g. by scripts/validate-test-matrix.sh) expose only the shard
# definitions above (SHARDS, HASH_SPLIT_SPECS, shard_paths, migration_shard_paths,
# hash_split_resolve, TEST_ROOT) and skip the test-execution logic below.
# Executing this file directly runs tests as before (BASH_SOURCE[0] == $0 → the
# guard is skipped).
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
	return 0
fi

# Parse arguments
COVERAGE=false
RERUN=false
SHOW_FAILURES=false
VERIFY=false
TARGET_SHARD=""

for arg in "$@"; do
	case "$arg" in
	--coverage)       COVERAGE=true ;;
	--rerun)          RERUN=true ;;
	--show-failures)  SHOW_FAILURES=true ;;
	--verify)         VERIFY=true ;;
	*)                TARGET_SHARD="$arg" ;;
	esac
done

# --- Verify shard configuration (no tests run) ---
# Exits after validating that every shard resolves and every hash-split covers
# its directory. Used by CI to guard against silent file-drop regressions.
if [ "$VERIFY" = true ]; then
	verify_shards
	exit $?
fi

mkdir -p "$RESULTS_DIR"

# --- Show failures from last run ---
if [ "$SHOW_FAILURES" = true ]; then
	shard_count=0
	for shard in "${SHARDS[@]}"; do
		junit="$RESULTS_DIR/junit-${shard}.xml"
		[ -f "$junit" ] || continue

		fail_count=$(grep '<testsuites' "$junit" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
		[ "${fail_count:-0}" -eq 0 ] && continue

		shard_count=$((shard_count + 1))
		echo "--- $shard ---"

		python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$junit')
for tc in tree.iter('testcase'):
    if tc.find('failure') is not None:
        # classname is the file path in vitest junit (there is no `file=`/
        # `line=`); printing both as "?" made --show-failures useless.
        print(f\"{tc.get('classname', '?')}\")
        print(f\"  {tc.get('name', '?')}\")
" 2>/dev/null
		echo ""
	done

	if [ "$shard_count" -eq 0 ]; then
		echo "No failures found in last run (or no junit files exist)."
		echo "Run ./scripts/test-daemon.sh first."
	else
		echo ""
		echo "To rerun failing tests:"
		echo "  ./scripts/test-daemon.sh --rerun"
	fi
	exit 0
fi

# --- Rerun mode ---
if [ "$RERUN" = true ]; then
	if [ ! -f "$FAILURES_FILE" ] || [ ! -s "$FAILURES_FILE" ]; then
		echo "No previous failures found. Run full tests first."
		exit 0
	fi
	FAILING_FILES=$(cat "$FAILURES_FILE")
	FILE_COUNT=$(echo "$FAILING_FILES" | wc -l | tr -d ' ')
	echo "Rerunning $FILE_COUNT failing test file(s)..."
	# Apply the same generous budget as the migration shards when a failing file
	# is a migration test (see run_shard) so a rerun doesn't re-flake on timeout.
	# Match both layouts: migration tests under `migrations/` AND top-level
	# `migration-*.test.ts` files directly under `storage/` (both are assigned to
	# the migration shards, so a --rerun must keep the same budget).
	RERUN_TIMEOUT_FLAGS=""
	if echo "$FAILING_FILES" | grep -qE "migrations/|migration-[0-9]+[^/]*(\.test|_test)\.[jt]s"; then
		RERUN_TIMEOUT_FLAGS="--testTimeout=30000 --hookTimeout=30000"
	fi
	# shellcheck disable=SC2086
	(cd "$REPO_ROOT/packages/daemon" && NODE_ENV=test node_modules/.bin/vitest run $RERUN_TIMEOUT_FLAGS $FAILING_FILES)
	exit $?
fi

# --- Determine shards to run ---
if [ -n "$TARGET_SHARD" ]; then
	RUN_SHARDS=("$TARGET_SHARD")
else
	RUN_SHARDS=("${SHARDS[@]}")
fi

# Build coverage flags (Vitest v8 coverage)
COV_FLAGS=""
if [ "$COVERAGE" = true ]; then
	COV_FLAGS="--coverage --coverage.reporter=text --coverage.reporter=lcov --coverage.reportsDirectory=coverage"
fi

# --- Run shards in parallel ---
PIDS=()

WALL_START=$(date +%s)

echo "Running daemon unit tests (${#RUN_SHARDS[@]} shard(s))..."
echo ""

# Run one shard under Vitest. Routes to the owning package's vitest config:
# `shared` runs from packages/shared; everything else runs from packages/daemon.
# Emits junit XML to $JUNIT_FILE and full output to $LOG_FILE.
run_shard() {
	local shard="$1"
	local junit_file="$2"
	local log_file="$3"
	shift 3
	local pkg_dir
	if [ "$shard" = "shared" ]; then
		pkg_dir="$REPO_ROOT/packages/shared"
	else
		pkg_dir="$REPO_ROOT/packages/daemon"
	fi

	# Migration-carrying shards (both merged halves) replay the full migration
	# chain on a fresh on-disk SQLite DB per test. That is I/O-heavy and
	# intermittently exceeds vitest's 5s test / 10s hook defaults under CI
	# parallel load — a different migration test flakes on different runs
	# (28/29/33/34/35-36/47/94). Give the whole shard a generous budget instead
	# of hardening each file one-by-one.
	local timeout_flags=""
	case "$shard" in
		1-core | *-migrations) timeout_flags="--testTimeout=30000 --hookTimeout=30000" ;;
	esac

	# shellcheck disable=SC2086
	(
		cd "$pkg_dir" || exit 1
		NODE_ENV=test node_modules/.bin/vitest run \
			--reporter=dot \
			--reporter=junit \
			--outputFile.junit="$junit_file" \
			$COV_FLAGS \
			$timeout_flags \
			"$@"
	) >"$log_file" 2>&1
}

for shard in "${RUN_SHARDS[@]}"; do
	JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
	LOG_FILE="$RESULTS_DIR/output-${shard}.log"
	rm -f "$JUNIT_FILE" "$LOG_FILE"
	TEST_PATHS=($(shard_paths "$shard"))
	if [ "${#TEST_PATHS[@]}" -eq 0 ]; then
		echo "Shard '$shard' resolved to 0 test files." >&2
		echo "  (Unknown shard name, or a hash-split bucket that is empty.)" >&2
		echo "  Known shards: ${SHARDS[*]}" >&2
		exit 1
	fi

	# Migration tests rebuild full old schemas and re-run the entire migration
	# suite for idempotency checks — legitimately heavy work that flakes at
	# vitest's 5s default under parallel shard load (migration-45/53 timeouts
	# blocked this PR across rounds 11/19/21). Give the migration-carrying
	# shards a generous per-test timeout; other shards keep the default.
	case "$shard" in
		*-migrations) EXTRA_FLAGS="--test-timeout=30000" ;;
		*) EXTRA_FLAGS="" ;;
	esac

	# shellcheck disable=SC2086
	run_shard "$shard" "$JUNIT_FILE" "$LOG_FILE" $EXTRA_FLAGS "${TEST_PATHS[@]}" &

	PIDS+=($!)
done

# Wait for all shards
for pid in "${PIDS[@]}"; do
	wait "$pid" 2>/dev/null || true
done

# --- Parse results from junit XML ---
TOTAL_TESTS=0
TOTAL_FAILS=0
TOTAL_SKIPS=0
TOTAL_TIME_MS=0
HAD_FAILURE=0

: > "$FAILURES_FILE"

printf "%-22s %8s %8s %8s %8s\n" "Shard" "Tests" "Pass" "Fail" "Time"
printf "%-22s %8s %8s %8s %8s\n" "----------------------" "--------" "--------" "--------" "--------"

for shard in "${RUN_SHARDS[@]}"; do
	JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
	LOG_FILE="$RESULTS_DIR/output-${shard}.log"

	if [ ! -f "$JUNIT_FILE" ]; then
		printf "%-22s %8s %8s %8s %8s\n" "$shard" "ERROR" "-" "-" "-"
		HAD_FAILURE=1
		if [ -f "$LOG_FILE" ]; then
			echo "  Last output from $shard:"
			tail -5 "$LOG_FILE" | sed 's/^/    /'
		fi
		continue
	fi

	# Extract counts from the root <testsuites> element
	root_attrs=$(grep '<testsuites' "$JUNIT_FILE")
	tests=$(echo "$root_attrs" | grep -o 'tests="[0-9]*"' | grep -o '[0-9]*')
	failures=$(echo "$root_attrs" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
	skipped=$(echo "$root_attrs" | grep -o 'skipped="[0-9]*"' | grep -o '[0-9]*')
	time_s=$(echo "$root_attrs" | grep -o 'time="[0-9.]*"' | sed 's/time="//;s/"//')
	time_ms=$(awk "BEGIN {printf \"%.0f\", ${time_s:-0} * 1000}")

	tests=${tests:-0}
	failures=${failures:-0}
	skipped=${skipped:-0}
	time_ms=${time_ms:-0}
	passed=$((tests - failures - skipped))

	TOTAL_TESTS=$((TOTAL_TESTS + tests))
	TOTAL_FAILS=$((TOTAL_FAILS + failures))
	TOTAL_SKIPS=$((TOTAL_SKIPS + skipped))
	TOTAL_TIME_MS=$((TOTAL_TIME_MS + time_ms))

	fmt_time=$(awk "BEGIN {printf \"%.1f\", $time_ms / 1000}")

	printf "%-22s %8s %8s %8s %7ss\n" "$shard" "$tests" "$passed" "$failures" "$fmt_time"

	if [ "$failures" -gt 0 ]; then
		HAD_FAILURE=1
		# Collect failing test files for `--rerun`. Vitest's junit <testcase>
		# carries the file path in `classname` (there is no `file=` attribute),
		# so grepping `file="..."` always comes up empty and `--rerun` reported
		# "No previous failures". Pull classname from failing cases instead.
		python3 - "$JUNIT_FILE" "$FAILURES_FILE" <<'PYEOF'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
fails = sorted({tc.get('classname') for tc in root.iter('testcase')
                if tc.find('failure') is not None and tc.get('classname')})
if fails:
    with open(sys.argv[2], 'a') as f:
        f.write('\n'.join(fails) + '\n')
PYEOF
		# Surface each failing test + its assertion message from the junit XML so
		# the detail is visible in the CI console (vitest output is otherwise only
		# in a per-shard log file that isn't uploaded as an artifact).
		echo ""
		echo "============================== failures: $shard =============================="
		python3 - "$JUNIT_FILE" <<'PYEOF'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
for tc in root.iter('testcase'):
    fail = tc.find('failure')
    if fail is None:
        continue
    name = tc.get('name', '?')
    cls = tc.get('classname', '?')
    msg = (fail.get('message') or fail.text or '').strip()
    print(f"FAIL {cls} > {name}")
    if msg:
        for line in msg.splitlines()[:15]:
            print(f"     {line}")
        print()
PYEOF
		echo "=============================================================================="
	fi
done

fmt_total=$(awk "BEGIN {printf \"%.1f\", $TOTAL_TIME_MS / 1000}")

printf "%-22s %8s %8s %8s %8s\n" "----------------------" "--------" "--------" "--------" "--------"
printf "%-22s %8s %8s %8s %7ss\n" "TOTAL" "$TOTAL_TESTS" "$((TOTAL_TESTS - TOTAL_FAILS - TOTAL_SKIPS))" "$TOTAL_FAILS" "$fmt_total"

WALL_END=$(date +%s)
WALL_SECS=$((WALL_END - WALL_START))

if [ "$HAD_FAILURE" -eq 1 ]; then
	echo ""
	FAIL_COUNT=$(sort -u "$FAILURES_FILE" | wc -l | tr -d ' ')
	echo "FAILURES ($FAIL_COUNT file(s)):"
	sort -u "$FAILURES_FILE" | while IFS= read -r file; do
		echo "  $file"
	done
	echo ""
	# Dump per-shard log output on failure so CI runners can diagnose the issue
	# without having to download junit artifacts. Only dump shards that failed.
	if [ -n "${CI:-}" ] || [ "${TEST_DAEMON_DUMP_ON_FAIL:-}" = "1" ]; then
		for shard in "${RUN_SHARDS[@]}"; do
			JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
			LOG_FILE="$RESULTS_DIR/output-${shard}.log"
			[ -f "$JUNIT_FILE" ] || continue
			shard_fails=$(grep '<testsuites' "$JUNIT_FILE" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
			if [ "${shard_fails:-0}" -gt 0 ] && [ -f "$LOG_FILE" ]; then
				echo "========================================================================"
				echo "Shard output: $shard"
				echo "========================================================================"
				cat "$LOG_FILE"
				echo "========================================================================"
				echo ""
			fi
		done
	fi
	echo "To rerun failing tests:"
	echo "  ./scripts/test-daemon.sh --rerun"
else
	echo ""
	echo "All tests passed!"
fi

echo "Wall time: ${WALL_SECS}s"

exit "$HAD_FAILURE"
