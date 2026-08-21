#!/bin/bash
# test-online.sh — Resolve a daemon online test module to its test paths.
#
# Companion of scripts/lib/shard-split.sh (the hash-split runner from #911 /
# PR #2441) for the ONLINE suite. The old main.yml matrix hand-listed which
# file belongs to which online shard (rpc-1..4, space-1..2, features-1..2,
# rewind-1..2); those lists rot exactly like the unit 5-space-runtime lists
# did. This script replaces them: a module resolves to either a whole
# directory (glob) or a hash-split bucket of one, so a new online test file
# auto-routes to a shard with NO YAML edit.
#
# Usage:
#   scripts/test-online.sh <module>           # print the module's test paths
#                                             # (daemon-package-relative, one per line)
#   scripts/test-online.sh --verify           # validate config + CI matrix wiring
#   scripts/test-online.sh --list             # print every configured module
#
# CI (test-daemon-online in .github/workflows/main.yml) does:
#   paths=$(scripts/test-online.sh "rpc-b")
#   cd packages/daemon && vitest run --config vitest.online.config.ts $paths
#
# Output paths are daemon-package-relative (tests/online/…): the runner
# executes vitest from packages/daemon, and the vitest.online.config include
# is rooted there, so the paths work as positionals with no rewriting.
#
# When sourced, exposes only ONLINE_MODULES / ONLINE_HASH_SPLIT_SPECS /
# online_module_paths / ONLINE_TEST_ROOT and skips execution (guard at bottom).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
ONLINE_TEST_ROOT="$REPO_ROOT/packages/daemon/tests/online"

# shellcheck disable=SC1091 # path is dynamic via $REPO_ROOT
source "$REPO_ROOT/scripts/lib/shard-split.sh"

# ── Online module configuration ─────────────────────────────────────────────
# ONLINE_MODULES maps a CI matrix module to the directory globs (relative to
# $ONLINE_TEST_ROOT, ';'-separated) it runs. A directory-level module is one
# line; adding a test file under the directory routes automatically.
#
# ONLINE_HASH_SPLIT_SPECS splits oversized directories the same way
# scripts/test-daemon.sh does (stableHash(repo-root-relative path) % N).
# Format:  <prefix>|<split_count>|<globs>[|<weights>]   — see HASH_SPLIT_SPECS
# there; the optional <weights> field opts the split into duration-aware bucket
# packing via a generated weights manifest (scripts/shard-weights.tsv).
# A split module's buckets are <prefix>-a, <prefix>-b, … (a→0, b→1, … ≤ z→25).
#
# Rebalancing a split is a one-number edit here PLUS adding/removing the
# matching -a/-b/… module in the test-daemon-online matrix in
# .github/workflows/main.yml — never editing individual files.
# Validate any change with: scripts/test-online.sh --verify
#
# Split sizing (CI test-step medians, Aug 2026 — see task #912; each job adds
# ~50s fixed setup/coverage overhead):
#   space    4 files  ~178s → 4-way (kills the old 212s space-2 job)
#   rpc     19 files  ~309s → 6-way
#   rewind   2 files  ~159s → 2-way
#   features 4 files  ~119s → 3-way
# The hash balances FILE COUNT, not per-file duration — a bucket holding one
# heavy file (e.g. space-a's task-agent-lifecycle) stays slow. The per-shard
# numbers above are the arithmetic mean; actual buckets ranged ~7–69s test
# time at these counts. Re-check with the next CI balance report.
# Small dirs (agent-sdk/components/convo/coordinator/git/lifecycle/mcp/sdk/
# websocket) stay whole — a split's fixed overhead dominates below ~120s of
# test time. convo is the one dir that CANNOT split: both of its files hash to
# bucket 0 mod 2 (a 2-way split would leave bucket 1 empty), so it stays whole.
ONLINE_HASH_SPLIT_SPECS=(
	"features|3|features/*.test.ts"
	"rewind|2|rewind/*.test.ts"
	"space|4|space/*.test.ts"
	"rpc|6|rpc/*.test.ts"
)

ONLINE_MODULES=(
	# Hash-split modules (resolved via ONLINE_HASH_SPLIT_SPECS — do not list
	# here): features-a…features-c, rewind-a/b, space-a…space-d, rpc-a…rpc-f.
	"agent-sdk|agent/*.test.ts"
	"components|components/*.test.ts"
	"convo|convo/*.test.ts"
	"coordinator|coordinator/*.test.ts"
	"git|git/*.test.ts"
	"lifecycle|lifecycle/*.test.ts"
	"mcp|mcp/*.test.ts"
	"sdk|sdk/*.test.ts"
	"websocket|websocket/*.test.ts"
)

# Online test directories intentionally NOT run by the mocked-online matrix.
# validate-test-matrix.sh reads this same variable (it sources this file), so
# the guard and --verify cannot drift apart. Each entry must stay documented:
#   benchmark      : manual-only (describe.skip by default)
#   glm            : disabled — GLM online tests are flaky (commented out in main.yml)
#   providers      : disabled — codex bridge needs OPENAI_API_KEY, copilot has a
#                    credential issue (commented out in main.yml)
#   sandbox        : disabled — not wired to a CI matrix shard
#   cross-provider : real-key shards, manual-only in real-api-tests.yml
ONLINE_EXEMPT_DIRS="benchmark glm providers sandbox cross-provider"

# Map a hash-split module's suffix letter to a 0-based bucket index (a→0 … z→25).
online_suffix_to_index() {
	local s="$1"
	[ "${#s}" -eq 1 ] || return 1
	case "$s" in [a-z]) ;; *) return 1 ;; esac
	echo $(( $(printf '%d' "'$s") - 97 ))
}

# Inverse of online_suffix_to_index: 0→a, 1→b, … (valid for 0..25).
online_index_to_suffix() {
	local i="$1"
	local letters="abcdefghijklmnopqrstuvwxyz"
	[[ "$i" =~ ^[0-9]+$ ]] && [ "$i" -ge 0 ] && [ "$i" -le 25 ] || return 1
	printf '%s' "${letters:i:1}"
}

# Strip the repo-root + packages/daemon prefix from an absolute path, yielding
# the daemon-package-relative form (tests/online/…) the runner passes to vitest.
online_rel_path() {
	printf '%s\n' "${1#"$REPO_ROOT/packages/daemon/"}"
}

# Resolve a hash-split module name (e.g. rpc-b) to its bucket's files.
# Prints daemon-package-relative test paths, 0 on a match, 1 if $1 is not a split.
# A spec with a 4th <weights> field resolves its bucket by duration-aware packing
# (see ONLINE_HASH_SPLIT_SPECS above); the union of buckets is the full glob set
# either way.
online_hash_split_resolve() {
	local module="$1"
	local spec prefix count globs weights suffix bucket
	for spec in "${ONLINE_HASH_SPLIT_SPECS[@]}"; do
		IFS='|' read -r prefix count globs weights <<<"$spec"
		case "$module" in
			"$prefix"-*)
				suffix="${module#"$prefix"-}"
				bucket=$(online_suffix_to_index "$suffix") || return 1
				local abs=() g f
				local IFS=';'
				for g in $globs; do abs+=("$ONLINE_TEST_ROOT/$g"); done
				if [ -n "$weights" ]; then
					while IFS= read -r f; do
						online_rel_path "$f"
					done < <(shard_split_bucket_weighted "$REPO_ROOT" "$REPO_ROOT/$weights" "$count" "$bucket" "${abs[@]}")
				else
					while IFS= read -r f; do
						online_rel_path "$f"
					done < <(shard_split_bucket "$REPO_ROOT" "$count" "$bucket" "${abs[@]}")
				fi
				return $?
				;;
		esac
	done
	return 1
}

# Map an online module name to its test paths (daemon-package-relative, one
# per line). Returns 0 on success, 1 for an unknown module.
online_module_paths() {
	local module="$1"
	local resolved
	if resolved=$(online_hash_split_resolve "$module"); then
		# An empty bucket still resolves; --verify and the runner's empty guard
		# (main.yml) catch that case loudly.
		[ -n "$resolved" ] || return 0
		printf '%s\n' "$resolved"
		return 0
	fi

	local entry name globs
	for entry in "${ONLINE_MODULES[@]}"; do
		IFS='|' read -r name globs <<<"$entry"
		if [ "$name" = "$module" ]; then
			local g pat f
			local IFS=';'
			for g in $globs; do
				# Unquoted $pat: bash expands the glob here. Expanding
				# "$ONLINE_TEST_ROOT/$g" quoted (as in test-daemon.sh) would
				# leave the pattern literal.
				pat="$ONLINE_TEST_ROOT/$g"
				for f in $pat; do
					[ -f "$f" ] && online_rel_path "$f"
				done
			done
			return 0
		fi
	done
	return 1
}

# Every configured module name (hash-split buckets + directory modules), one
# per line — used by --verify and --list.
online_all_modules() {
	local spec prefix count _globs bi suffix
	for spec in "${ONLINE_HASH_SPLIT_SPECS[@]}"; do
		IFS='|' read -r prefix count _globs <<<"$spec"
		bi=0
		while [ "$bi" -lt "$count" ]; do
			if suffix=$(online_index_to_suffix "$bi"); then
				printf '%s-%s\n' "$prefix" "$suffix"
			fi
			bi=$((bi + 1))
		done
	done
	local entry name _globs2
	for entry in "${ONLINE_MODULES[@]}"; do
		IFS='|' read -r name _globs2 <<<"$entry"
		printf '%s\n' "$name"
	done
}

# Validate the online module configuration without running any tests. Mirrors
# verify_shards() in scripts/test-daemon.sh:
#   - every configured module resolves to ≥1 existing file, and every resolved
#     path is a real test file (no stale glob);
#   - each hash-split's split_count matches the modules the CI matrix actually
#     runs (no bucket silently dropped, no stale bucket);
#   - the matrix module axis matches the configured module set EXACTLY (a
#     matrix module with no config row runs zero files; a configured module
#     missing from the matrix never runs);
#   - buckets partition their directory's complete test set (find cross-check
#     over both daemon suffixes, so a glob missing a *_test.ts fails); weighted
#     specs partition by their PACKED assignment and get a manifest audit plus
#     per-bucket TIME balance in the report;
#   - exempt dirs (intentionally disabled modules) are documented here.
# Exits non-zero on any error.
verify_online_modules() {
	local errors=0
	local workflow="$REPO_ROOT/.github/workflows/main.yml"

	echo "Verifying daemon online module configuration..."

	# 1. Every configured module resolves to at least one existing test file.
	local module paths p
	while IFS= read -r module; do
		paths=$(online_module_paths "$module")
		if [ -z "$paths" ]; then
			echo "  ERROR: online module '$module' resolved to 0 files" >&2
			errors=$((errors + 1))
			continue
		fi
		while IFS= read -r p; do
			# Paths are daemon-package-relative; re-anchor for the disk check.
			if [ ! -f "$REPO_ROOT/packages/daemon/$p" ]; then
				echo "  ERROR: online module '$module' references missing path: $p" >&2
				errors=$((errors + 1))
			fi
		done <<<"$paths"
	done < <(online_all_modules)

	# 2. Hash-split specs: bucket names ↔ split_count, and glob coverage of the
	#    directory tree (union == find, no overlap).
	local spec prefix count globs weights manifest
	for spec in "${ONLINE_HASH_SPLIT_SPECS[@]}"; do
		IFS='|' read -r prefix count globs weights <<<"$spec"
		manifest=""
		if [ -n "$weights" ]; then
			manifest="$REPO_ROOT/$weights"
		fi

		local abs=() g dirs=()
		local IFS=';'
		for g in $globs; do
			abs+=("$ONLINE_TEST_ROOT/$g")
			dirs+=("$ONLINE_TEST_ROOT/$(dirname "$g")")
		done

		# A spec that opts into a weights manifest gets the manifest audit:
		# present on disk, well-formed lines, no stale paths, coverage summary.
		if [ -n "$manifest" ]; then
			if ! shard_split_weights_check "$REPO_ROOT" "$manifest" "$count" "${abs[@]}"; then
				errors=$((errors + 1))
			fi
		fi

		local total find_count
		total=$(shard_split_count "$REPO_ROOT" "${abs[@]}")
		find_count=$(find "${dirs[@]}" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) | sort -u | wc -l | tr -d ' ')
		if [ "$find_count" -ne "$total" ]; then
			echo "  ERROR: '$prefix' globs match $total file(s) but find reports $find_count (both suffixes) — a glob is missing files (e.g. a *_test.ts)" >&2
			errors=$((errors + 1))
		fi

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

		local rep zero z
		if [ -n "$manifest" ]; then
			rep=$(shard_split_report_weighted "$REPO_ROOT" "$manifest" "$count" "${abs[@]}")
			printf '  %-12s %d-way split, %d files (duration-weighted via %s):\n' "$prefix" "$count" "$total" "$weights"
			printf '%s\n' "$rep" | awk -F'\t' '{printf "      bucket %s: %s file(s), %.1fs weighted\n", $1, $2, $3 / 1000}'
		else
			rep=$(shard_split_report "$REPO_ROOT" "$count" "${abs[@]}")
			printf '  %-12s %d-way split, %d files:\n' "$prefix" "$count" "$total"
			printf '%s\n' "$rep" | awk -F'\t' '{printf "      bucket %s: %s file(s)\n", $1, $2}'
		fi
		zero=$(printf '%s\n' "$rep" | awk -F'\t' '$2 == 0 {print $1}')
		for z in $zero; do
			echo "  ERROR: '$prefix' bucket $z resolved to 0 files — a CI job would run nothing" >&2
			errors=$((errors + 1))
		done
	done

	# 3. Directory modules: the glob set must cover every test file under the
	#    module's directory tree (same find cross-check per module).
	for entry in "${ONLINE_MODULES[@]}"; do
		IFS='|' read -r module globs <<<"$entry"
		local abs=() g dirs=()
		local IFS=';'
		for g in $globs; do
			abs+=("$ONLINE_TEST_ROOT/$g")
			dirs+=("$ONLINE_TEST_ROOT/$(dirname "$g")")
		done
		local total find_count
		total=$(shard_split_count "$REPO_ROOT" "${abs[@]}")
		find_count=$(find "${dirs[@]}" -maxdepth 1 -type f \( -name '*.test.ts' -o -name '*_test.ts' \) | sort -u | wc -l | tr -d ' ')
		if [ "$find_count" -ne "$total" ]; then
			echo "  ERROR: module '$module' globs match $total file(s) but find reports $find_count under $(basename "${dirs[0]}") — a glob is missing files" >&2
			errors=$((errors + 1))
		fi
		if [ "$total" -eq 0 ]; then
			echo "  ERROR: module '$module' resolved to 0 files" >&2
			errors=$((errors + 1))
		fi
	done

	# 4. CI matrix wiring: the active module axis must match the configured
	#    module set exactly, in both directions.
	local matrix_modules=""
	if [ -f "$workflow" ]; then
		matrix_modules=$(awk '
			$0 ~ "^  test-daemon-online:" { injob=1; next }
			injob && /^  [a-z]/ { injob=0; next }
			!injob { next }
			injob && /^[[:space:]]*module:[[:space:]]*$/ { inaxis=1; next }
			injob && /^[[:space:]]*include:/ { inaxis=0 }
			inaxis && !/^[[:space:]]*#/ && /^[[:space:]]+- [^[:space:]#]/ {
				v=$0; sub(/^[[:space:]]+- [[:space:]]*/, "", v); sub(/[[:space:]].*/, "", v); gsub(/[^a-z0-9-]/, "", v)
				if (v != "") print v
			}
		' "$workflow")
	fi
	if [ -z "$matrix_modules" ]; then
		echo "  ERROR: could not parse the module: axis of test-daemon-online in $workflow" >&2
		errors=$((errors + 1))
	fi
	local m
	local configured_all
	configured_all=$(online_all_modules)
	while IFS= read -r m; do
		[ -n "$m" ] || continue
		if ! grep -qxF "$m" <<<"$configured_all"; then
			echo "  ERROR: CI matrix module '$m' is not configured in scripts/test-online.sh (it would run zero files)" >&2
			errors=$((errors + 1))
		fi
	done <<<"$matrix_modules"
	while IFS= read -r m; do
		[ -n "$m" ] || continue
		if ! printf '%s\n' "$matrix_modules" | grep -qxF "$m"; then
			echo "  ERROR: configured module '$m' is missing from the test-daemon-online matrix in .github/workflows/main.yml — its files never run in CI" >&2
			errors=$((errors + 1))
		fi
	done < <(online_all_modules)
	local dups
	dups=$(printf '%s\n' "$matrix_modules" | sort | uniq -d)
	if [ -n "$dups" ]; then
		while IFS= read -r m; do
			[ -n "$m" ] || continue
			echo "  ERROR: module '$m' appears more than once in the CI matrix" >&2
			errors=$((errors + 1))
		done <<<"$dups"
	fi

	# 5. Every online test file on disk must be owned by exactly one configured
	#    module (or live in a documented exempt dir — see ONLINE_EXEMPT_DIRS).
	#    covered_all is daemon-package-relative (tests/online/…), so the disk
	#    walk's absolute paths get the same prefix stripped before comparing.
	local dir dn covered_all
	covered_all=$(online_all_modules | while IFS= read -r module; do online_module_paths "$module"; done | sort -u)
	for dir in "$ONLINE_TEST_ROOT"/*/; do
		[ -d "$dir" ] || continue
		dn=$(basename "$dir")
		if [[ " $ONLINE_EXEMPT_DIRS " == *" $dn "* ]]; then continue; fi
		while IFS= read -r f; do
			local rel="${f#"$REPO_ROOT/packages/daemon/"}"
			if ! grep -qxF "$rel" <<<"$covered_all"; then
				echo "  ERROR: online test file not covered by any module: $rel" >&2
				echo "     → add its directory glob to scripts/test-online.sh (or document the dir as exempt)" >&2
				errors=$((errors + 1))
			fi
		done < <(find "$dir" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) | sort)
	done

	if [ "$errors" -gt 0 ]; then
		echo ""
		echo "FAILED: $errors online module configuration error(s)." >&2
		exit 1
	fi
	echo ""
	echo "Online module configuration OK."
}

# When sourced (e.g. by scripts/validate-test-matrix.sh) expose only the
# definitions above; executing the file directly resolves modules.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
	return 0
fi

# ── CLI ─────────────────────────────────────────────────────────────────────
case "${1:-}" in
--verify)
	verify_online_modules
	exit $?
	;;
--list)
	online_all_modules
	exit 0
	;;
-*)
	echo "usage: scripts/test-online.sh <module> | --verify | --list" >&2
	exit 2
	;;
esac

if [ "$#" -ne 1 ]; then
	echo "usage: scripts/test-online.sh <module> | --verify | --list" >&2
	exit 2
fi

if ! paths=$(online_module_paths "$1"); then
	echo "Unknown online module '$1'. Known modules:" >&2
	online_all_modules >&2
	exit 1
fi
if [ -z "$paths" ]; then
	echo "Online module '$1' resolved to 0 files (bucket empty?)." >&2
	exit 1
fi
printf '%s\n' "$paths"
