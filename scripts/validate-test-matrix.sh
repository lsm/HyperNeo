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

# Print the FOLDED `run:` command of the ENABLED workflow step whose run command
# contains the literal marker $2 (in file $1). Folds `run: >-`/`|-` blocks AND
# handles single-line `run:`. Empty if no enabled step matches — i.e. the step is
# missing, commented, or disabled (`if: false|never`). Lets the wiring checks
# verify a matrix value actually reaches an enabled runner command.
enabled_run_cmd() {
	awk -v marker="$2" -v job="$3" '
		function emit() { if (runval != "" && index(runval, marker) > 0 && !disabled && !job_disabled && !done && curjob == job) { print runval; done=1 } }
		# A job key (2-space indent under jobs:) starts a fresh job. Emit the
		# PREVIOUS pending step FIRST (while its job_disabled + curjob still apply),
		# then reset and capture the new job name — so emit only fires for the
		# TARGET job (a marker in an UNRELATED job can no longer mask the real
		# runner being disabled/removed in its own job).
		/^[[:space:]]{2}[[:alnum:]_-]+:[[:space:]]*$/ {
			emit(); runval=""; disabled=0; incmd=0; job_disabled=0
			curjob=$0; sub(/^[[:space:]]+/, "", curjob); sub(/:.*$/, "", curjob); next
		}
		# Step boundary: emit the PREVIOUS step now that ALL its properties — including
		# a trailing `if: false` placed after `run:` — have been seen, then reset.
		/^[[:space:]]*-[[:space:]]/ { emit(); runval=""; disabled=0; incmd=0 }
		# if:false|never disables a step (>= 6 indent) or the whole job (<= 4 indent).
		# Accept the optional ${{ }} expression wrapper GitHub allows (if: ${{ false }}).
		/if:[[:space:]]*(\$\{\{[[:space:]]*)?(false|never)([[:space:]]|\}|$)/ { n=0; while (substr($0,n+1,1)==" ") n++; if (n <= 4) job_disabled=1; else disabled=1 }
		# Step-level if: (indent > 4). Permit ONLY an exact always()/success()/true
		# predicate (optionally ${{ }}-wrapped). A compound such as
		# `always() && github.event_name == 'never'` is skipped by GitHub yet contains
		# the `always` substring, so substring-matching would bless a disabled runner
		# while this guard reports it enabled. Any other step-level gate cannot be
		# evaluated and is treated as potentially disabling (conservative).
		/if:/ {
			n=0; while (substr($0,n+1,1)==" ") n++
			if (n > 4) {
				v=$0; sub(/^.*if:[[:space:]]*/, "", v); gsub(/[[:space:]]/, "", v)
				sub(/^\$\{\{/, "", v); sub(/\}\}$/, "", v)
				if (v != "always()" && v != "success()" && v != "true") disabled=1
			}
		}
		/^[[:space:]]*#/ { next }
		# Folded run: keep accumulating; on dedent just stop (NO emit — a later
		# if:false on the same step must be honored, so emit is deferred to the step boundary/END).
		incmd { n=0; while (substr($0,n+1,1)==" ") n++; if (n > runindent) { runval=runval" "$0; next }; incmd=0 }
		/^[[:space:]]*run:[[:space:]]*[>|]/ { incmd=1; n=0; while (substr($0,n+1,1)==" ") n++; runindent=n; runval=$0; next }
		# Single-line run: stash the command only — emit is DEFERRED so a later
		# if:false (which GitHub allows after `run:`) is parsed before the step counts as enabled.
		/^[[:space:]]*run:[[:space:]]+/ { runval=$0; incmd=0; next }
		END { emit() }
	' "$1"
}

# Count ENABLED steps in job (of file) whose folded run command contains marker.
# enabled_run_cmd returns the FIRST such step (done=1), so a second enabled runner
# step in the same job is invisible — copying the runner runs the suite twice
# while the guard sees one. Callers require exactly one.
count_enabled_run_cmds() {
	awk -v marker="$2" -v job="$3" '
		function emit() { if (runval != "" && index(runval, marker) > 0 && !disabled && !job_disabled && curjob == job) count++ }
		/^[[:space:]]{2}[[:alnum:]_-]+:[[:space:]]*$/ { emit(); runval=""; disabled=0; incmd=0; job_disabled=0; curjob=$0; sub(/^[[:space:]]+/, "", curjob); sub(/:.*$/, "", curjob); next }
		/^[[:space:]]*-[[:space:]]/ { emit(); runval=""; disabled=0; incmd=0 }
		/if:[[:space:]]*(\$\{\{[[:space:]]*)?(false|never)([[:space:]]|\}|$)/ { n=0; while (substr($0,n+1,1)==" ") n++; if (n <= 4) job_disabled=1; else disabled=1 }
		/if:/ { n=0; while (substr($0,n+1,1)==" ") n++; if (n > 4) { v=$0; sub(/^.*if:[[:space:]]*/, "", v); gsub(/[[:space:]]/, "", v); sub(/^\$\{\{/, "", v); sub(/\}\}$/, "", v); if (v != "always()" && v != "success()" && v != "true") disabled=1 } }
		/^[[:space:]]*#/ { next }
		incmd { n=0; while (substr($0,n+1,1)==" ") n++; if (n > runindent) { runval=runval" "$0; next }; incmd=0 }
		/^[[:space:]]*run:[[:space:]]*[>|]/ { incmd=1; n=0; while (substr($0,n+1,1)==" ") n++; runindent=n; runval=$0; next }
		/^[[:space:]]*run:[[:space:]]+/ { runval=$0; incmd=0; next }
		END { emit(); print count+0 }
	' "$1"
}

# True (exit 0) if `marker` is EXECUTED by runner command `runval` — i.e. it
# appears OUTSIDE single quotes OR inside a bash/sh -lc/-c body (which the shell
# executes). A marker that appears only inside another quoted argument — e.g.
# `run: echo './scripts/test-daemon.sh ${{ matrix.shard }}'` — is data, not an
# executed command, so the step runs zero tests while the guard stays green.
marker_executed() {
	awk -v runval="$1" -v marker="$2" '
		function strip_quotes(t,   i,c,out,q) {
			out=""; q=0
			for (i=1; i<=length(t); i++) {
				c=substr(t,i,1)
				if (c == "'\''" || c == "\"") q = (q ? 0 : 1)
				else if (!q) out=out c
			}
			return out
		}
		function executed_text(s,   i,n,c,out,sq,dq,qstart,before,content) {
			n=length(s); out=""; sq=0; dq=0
			for (i=1; i<=n; i++) {
				c=substr(s,i,1)
				if (c == "'\''" && !dq) {
					if (!sq) { sq=1; qstart=i; before=substr(s,1,i-1) }
					else { sq=0; content=substr(s,qstart+1,i-qstart-1); if (before ~ /(bash|sh)[[:space:]]+-l?c[[:space:]]*$/) out=out strip_quotes(content) }
				} else if (c == "\"" && !sq) {
					if (!dq) { dq=1; qstart=i; before=substr(s,1,i-1) }
					else { dq=0; content=substr(s,qstart+1,i-qstart-1); if (before ~ /(bash|sh)[[:space:]]+-l?c[[:space:]]*$/) out=out strip_quotes(content) }
				} else if (!sq && !dq) { out=out c }
			}
			return out
		}
		BEGIN { exit (index(executed_text(runval), marker) > 0) ? 0 : 1 }
	'
}

# True (exit 0 = BAD) if the runner command's first token (after run:/run:>-,
# ignoring a leading quote) is a data/no-op command (echo/printf/cat/true/false/:)
# — the marker would be an argument, not executed. An unquoted `echo marker ...`
# bypasses marker_executed (the marker is outside single quotes).
runner_is_data_cmd() {
	local tok
	tok=$(printf '%s' "$1" \
		| sed -E 's/^[[:space:]]*run:[[:space:]]*//' \
		| sed -E 's/^([>|]-)[[:space:]]*//' \
		| sed -E "s/^[\"']//" \
		| sed -E 's/.* -- //' \
		| sed -E 's/^env( [[:alnum:]_]+=[^[:space:]]+)*//' \
		| sed -E 's/^command[[:space:]]+//' \
		| awk '{print $1}')
	case "$tok" in echo|printf|cat|true|false|:|env|command) return 0 ;; *) return 1 ;; esac
}

# True (exit 0 = BAD) if the command after the flaky-runner ` -- ` separator does
# NOT start with the expected runner prefix ($2). The flaky-test-runner hands the
# token after `--` to the shell for execution, so for the wrapped runners it must
# be the actual test runner (`bash -lc '...'` for web/online-main,
# `./scripts/test-daemon.sh` for unit). A wrapper such as `test -n "<marker>"`
# (double-quoted, so marker_executed treats the marker as executed), `echo
# "<marker>"`, or `[ -n "<marker>" ]` makes the step exit 0 while running ZERO
# tests — and a data-command blacklist cannot enumerate every such wrapper, so
# pin the prefix instead. marker_executed already rejects a SINGLE-quoted data
# arg (`echo '<marker>'`); this catches the double-quoted / builtin-wrapper case.
runner_post_sep_starts_with() {
	local after
	after=$(printf '%s' "$1" | sed -E 's/.*[[:space:]]--[[:space:]]//' | sed -E 's/^[[:space:]]+//')
	case "$after" in
		"$2"*) return 1 ;; # the expected runner prefix → OK
		*) return 0 ;;     # any other wrapper/no-op → BAD
	esac
}

# True (exit 0 = BAD) if the EXECUTED portion of the runner command places a
# control-flow `||` or `&&` BEFORE the marker — e.g. `true || <marker>`,
# `bash -lc 'false && cd ... && <marker>'`, or `bash -lc 'true || ... && <marker>'`.
# Bash short-circuits both: `||` skips the right side when the left SUCCEEDS
# (a no-op `true`/`:`), and `&&` skips it when the left FAILS (a no-op `false`),
# so either deadens the marker — the step runs zero tests yet marker_executed
# (purely textual) still reports it run. Callers pass a marker that INCLUDES any
# legit `cd <dir> && ` prefix (so that prefix's `&&` sits INSIDE the marker, not
# before it). Considers only EXECUTED text (outside single quotes, or inside a
# -lc/-c body), so an operator inside a quoted data argument is not misread.
runner_has_dead_prefix() {
	awk -v runval="$1" -v marker="$2" '
		function executed_text(s,   i,n,c,out,sq,dq,qstart,before,content) {
			# Track single (sq) and double (dq) quote regions separately. A quoted
			# string is an ARGUMENT (data) unless it is the body of a `bash/sh -lc/-c`
			# command — so `bash -lc 'vitest'` keeps vitest (executed), but
			# `bash -lc "true" "vitest"` keeps only `true` (the command); the second
			# arg is $0, NOT executed, even though it is double-quoted.
			n=length(s); out=""; sq=0; dq=0
			for (i=1; i<=n; i++) {
				c=substr(s,i,1)
				if (c == "'\''" && !dq) {
					if (!sq) { sq=1; qstart=i; before=substr(s,1,i-1) }
					else { sq=0; content=substr(s,qstart+1,i-qstart-1); if (before ~ /(bash|sh)[[:space:]]+-l?c[[:space:]]*$/) out=out content }
				} else if (c == "\"" && !sq) {
					if (!dq) { dq=1; qstart=i; before=substr(s,1,i-1) }
					else { dq=0; content=substr(s,qstart+1,i-qstart-1); if (before ~ /(bash|sh)[[:space:]]+-l?c[[:space:]]*$/) out=out content }
				} else if (!sq && !dq) { out=out c }
			}
			return out
		}
		BEGIN {
			txt=executed_text(runval); p=index(txt, marker)
			if (p == 0) exit 1
			prefix = substr(txt, 1, p-1)
			# A short-circuit `||`/`&&`, OR a process-terminating command (exit/exec)
			# before the marker — `exit 0; <marker>` ends the shell before the marker
			# is reached, so zero tests run while this guard reports them covered.
			exit ((prefix ~ /(\|\||&&)/) || (prefix ~ /(^|[^[:alnum:]_])(exit|exec)([[:space:];|&]|$)/)) ? 0 : 1
		}
	'
}

# True (exit 0 = BAD) if a no-exec interpreter prefix (bash/sh/zsh/dash -n)
# appears before the marker in the RAW run command. Bash documents -n as "read
# commands but do not execute", so `bash -n ./scripts/test-daemon.sh ...` (or the
# same after the flaky-runner `--`) makes the step exit 0 having run ZERO tests
# while marker_executed (textual) still reports the marker run. The legit runners
# use `bash -lc` (which executes) or invoke the test command directly, so a real
# `-n` flag before the marker is always a bypass. Uses the RAW runval (no quote
# arithmetic): `bash -lc` never carries `-n`, so it cannot false-positive.
runner_has_noexec_interp() {
	awk -v runval="$1" -v marker="$2" '
		BEGIN {
			p = index(runval, marker)
			exit (p > 0 && substr(runval, 1, p-1) ~ /(bash|sh|zsh|dash)[[:space:]]+-n([[:space:]]|$)/) ? 0 : 1
		}
	'
}

# True (exit 0 = BAD) if a shell comment (`#`) appears in the EXECUTED text
# BEFORE the marker. A folded `run: >-` joins lines with spaces into one shell
# line, so a `#` comments out everything after it: `true # ... <marker>` runs
# `true` (exit 0) and never reaches the marker — ZERO tests run while EVERY other
# detector (marker_executed, dead_prefix, noexec_interp, data_cmd) passes. The
# guard already rejects `#` in test_path values for this reason; this closes the
# same hole on the runner command. Considers only EXECUTED text (outside single
# quotes, or inside a -lc/-c body), so a `#` inside a quoted data argument is not
# misread as a comment. A bare leading `#` (column 1) is a YAML comment, stripped
# before the runval is assembled, so only a whitespace-preceded `#` matters.
runner_has_comment_before_marker() {
	awk -v runval="$1" -v marker="$2" '
		function executed_text(s,   i,n,c,out,sq,dq,qstart,before,content) {
			# Track single (sq) and double (dq) quote regions separately. A quoted
			# string is an ARGUMENT (data) unless it is the body of a `bash/sh -lc/-c`
			# command — so `bash -lc 'vitest'` keeps vitest (executed), but
			# `bash -lc "true" "vitest"` keeps only `true` (the command); the second
			# arg is $0, NOT executed, even though it is double-quoted.
			n=length(s); out=""; sq=0; dq=0
			for (i=1; i<=n; i++) {
				c=substr(s,i,1)
				if (c == "'\''" && !dq) {
					if (!sq) { sq=1; qstart=i; before=substr(s,1,i-1) }
					else { sq=0; content=substr(s,qstart+1,i-qstart-1); if (before ~ /(bash|sh)[[:space:]]+-l?c[[:space:]]*$/) out=out content }
				} else if (c == "\"" && !sq) {
					if (!dq) { dq=1; qstart=i; before=substr(s,1,i-1) }
					else { dq=0; content=substr(s,qstart+1,i-qstart-1); if (before ~ /(bash|sh)[[:space:]]+-l?c[[:space:]]*$/) out=out content }
				} else if (!sq && !dq) { out=out c }
			}
			return out
		}
		BEGIN {
			txt=executed_text(runval); p=index(txt, marker)
			exit (p > 0 && substr(txt, 1, p-1) ~ /[[:space:]]#/) ? 0 : 1
		}
	'
}
# enabled_run_cmd job/step/if scoping so the property is attributed to the runner
# step itself, not an unrelated sibling in the same job.
runner_continue_on_error() {
	awk -v marker="$2" -v job="$3" '
		function emit() { if (runval != "" && index(runval, marker) > 0 && !disabled && !job_disabled && done == 0 && curjob == job) { print ((conerr || job_conerr) ? "BAD" : "OK"); done=1 } }
		/^[[:space:]]{2}[[:alnum:]_-]+:[[:space:]]*$/ {
			emit(); runval=""; disabled=0; incmd=0; job_disabled=0; conerr=0; job_conerr=0
			curjob=$0; sub(/^[[:space:]]+/, "", curjob); sub(/:.*$/, "", curjob); next
		}
		/^[[:space:]]*-[[:space:]]/ { emit(); runval=""; disabled=0; incmd=0; conerr=0 }
		/^[[:space:]]*#/ { next }
		/if:[[:space:]]*(\$\{\{[[:space:]]*)?(false|never)([[:space:]]|\}|$)/ { n=0; while (substr($0,n+1,1)==" ") n++; if (n <= 4) job_disabled=1; else disabled=1 }
		/if:/ {
			n=0; while (substr($0,n+1,1)==" ") n++
			if (n > 4) {
				v=$0; sub(/^.*if:[[:space:]]*/, "", v); gsub(/[[:space:]]/, "", v)
				sub(/^\$\{\{/, "", v); sub(/\}\}$/, "", v)
				if (v != "always()" && v != "success()" && v != "true") disabled=1
			}
		}
		# continue-on-error at job scope (<=4 indent) covers every step; step scope (>4) that step only.
		# Reject ANY value that is not exactly `false` — a truthy expression such as
		# `${{ 1 == 1 }}` or `${{ true }}` masks failures just like literal `true`.
		/continue-on-error:[[:space:]]*/ {
			v=$0; sub(/.*continue-on-error:[[:space:]]*/, "", v); sub(/[[:space:]]*#.*$/, "", v); sub(/[[:space:]]*$/, "", v)
			if (v != "false") { n=0; while (substr($0,n+1,1)==" ") n++; if (n <= 4) job_conerr=1; else conerr=1 }
		}
		incmd { n=0; while (substr($0,n+1,1)==" ") n++; if (n > runindent) { runval=runval" "$0; next }; incmd=0 }
		/^[[:space:]]*run:[[:space:]]*[>|]/ { incmd=1; n=0; while (substr($0,n+1,1)==" ") n++; runindent=n; runval=$0; next }
		/^[[:space:]]*run:[[:space:]]+/ { runval=$0; incmd=0; next }
		END { emit() }
	' "$1" | grep -q '^BAD$'
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
		# Flow form: exclude: [ ... ] on one line — pull every "key: <token>" out.
		# The token runs up to a delimiter (], ,, }, whitespace) so optional YAML
		# quotes (single/double) are captured and then stripped (gsub non-token).
		injob && $0 ~ "^[[:space:]]*exclude:[[:space:]]*\\[" {
			s=$0
			while (match(s, key ":[[:space:]]*[^][,}[:space:]]+")) {
				v=substr(s, RSTART, RLENGTH); sub(".*" key ":[[:space:]]*", "", v); gsub(/[^a-z0-9-]/, "", v); if (v != "") print v
				s=substr(s, RSTART + RLENGTH)
			}
			next
		}
		# Block form: "exclude:" alone, then indented "- key: value" lines.
		injob && $0 ~ "^[[:space:]]*exclude:[[:space:]]*$" { inblock=1; next }
		injob && inblock && !/^[[:space:]]*#/ && !/^[[:space:]]*$/ {
			n=0; while (substr($0,n+1,1)==" ") n++
			if (n <= 8) { inblock=0; next }
			if (match($0, key ":[[:space:]]*[^][,}[:space:]]+")) {
				v=substr($0, RSTART, RLENGTH); sub(".*" key ":[[:space:]]*", "", v); gsub(/[^a-z0-9-]/, "", v); if (v != "") print v
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
	awk -v job="$2" '
		function trim(v) { sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v); return v }
		function flush_rec(   i) {
			if (rmod != "") for (i = 0; i < rpath_n; i++) if (rpaths[i] != "") print rmod "\t" rpaths[i]
			rmod=""; rpath_n=0; folding=0
		}
		function handle_key(line,   v) {
			sub(/^[[:space:]]+/, "", line)
			if (line ~ /^module:[[:space:]]*[^[:space:]]/) {
				sub(/^module:[[:space:]]*/, "", line); line=trim(line); gsub(/[^a-z0-9-]/, "", line); rmod=line
			} else if (line ~ /^test_path:[[:space:]]*[>|]-[[:space:]]*$/) {
				folding=1
			} else if (line ~ /^test_path:[[:space:]]+[^[:space:]>|-]/) {
				sub(/^test_path:[[:space:]]+/, "", line); line=trim(line); if (line != "") rpaths[rpath_n++]=line
			}
		}
		$0 ~ "^  " job ":" { injob=1; next }
		injob && /^  [a-z]/ { flush_rec(); injob=0; next }
		!injob { next }
		!folding && /^[[:space:]]*#/ { next }
		# List item: new record. Parse the dash-line key regardless of key ORDER
		# (module: or test_path: or mock_sdk: — any can be first on the dash line).
		/^[[:space:]]*- / {
			if (rmod != "" || rpath_n > 0) flush_rec()
			mi=0; while (substr($0,mi+1,1)==" ") mi++
			line=$0; sub(/^[[:space:]]*- [[:space:]]*/, "", line); handle_key(line)
			next
		}
		# Property lines: collect module/test_path at indent mi+2 in ANY order;
		# dedent to mi or below flushes the record.
		{
			n=0; while (substr($0,n+1,1)==" ") n++
			if (n <= mi) { flush_rec(); next }
			if (folding) {
				if (n > mi+2) { v=trim($0); if (v != "") rpaths[rpath_n++]=v; next }
				folding=0
			}
			if (n == mi+2) handle_key($0)
		}
	' "$1"
}

# True (exit 0) if vitest config $1 has `    <prop>: <value>` directly under
# test: (4-space indent) with <value> the COMPLETE property — the closing `]` of
# the array must be followed by `,` or EOL, so a `.map()`/expression appended
# after the array (which would narrow execution) is rejected. Regex-escapes the
# value, so a whole-file substring check can no longer be satisfied
# by the same value placed in a nested coverage.<prop> while test.<prop> narrows.
test_prop_has() {
	local val_re
	val_re=$(printf '%s' "$3" | sed 's/[][{}.*\\]/\\&/g')
	_PROP_VAL_RE="$val_re" awk -v prop="$2" '
		/^  test:[[:space:]]*\{?[[:space:]]*$/ { intest=1; next }
		/^  [a-zA-Z]/ { intest=0 }
		intest && $0 ~ "^    " prop ": " ENVIRON["_PROP_VAL_RE"] "(,|$)" { found=1; exit }
		END { exit (found ? 0 : 1) }
	' "$1"
}

# True (exit 0) if vitest config $1 does NOT set `<prop>` directly under test:
# (4-space indent). Guards options like `dir:` that narrow the discovery root
# without touching include/exclude (which test_prop_has pins) — a narrowed dir
# makes files outside it unreachable while the guard still reports them covered.
test_prop_absent() {
	awk -v prop="$2" '
		/^  test:[[:space:]]*\{?[[:space:]]*$/ { intest=1; next }
		/^  [a-zA-Z]/ { intest=0 }
		intest && $0 ~ "^    " prop ":" { found=1; exit }
		END { exit (found ? 1 : 0) }
	' "$1"
}

# Require vitest config $1 (package label $2) to set NONE of the selection-
# changing test options (dir, shard) — each narrows which files run without
# touching include/exclude (which test_prop_has pins), so a narrowed dir/shard
# drops files while this guard reports them covered.
test_no_select_opts() {
	local cfg="$1" pkg="$2" opt
	for opt in dir shard testNamePattern; do
		if ! test_prop_absent "$cfg" "$opt"; then
			err "$pkg/vitest.config.ts sets test.$opt — it narrows which files run while this guard reports them covered"
			echo "     → drop test.$opt (use the default), or update this validator" >&2
		fi
	done
}

# Reject a non-default `root` in a guarded vitest config. Include globs resolve
# relative to root, so an explicit top-level `root:` (the Vite root Vitest
# inherits) or `test.root` relocates the discovery base — the pinned src/**
# include would then describe files the disk walk no longer reports covered. The
# configs use the default (the config-file dir); reject any explicit root.
cfg_reject_root() {
	local cfg="$1" pkg="$2"
	# Top-level root: (2-space indent — a sibling of test:/resolve:).
	if awk 'BEGIN{f=0} /^  root:[[:space:]]/{f=1; exit} END{exit !f}' "$cfg"; then
		err "$pkg config sets a top-level root: — include globs resolve under it instead of the package dir, so the pinned include no longer describes the covered files"
		echo "     → remove root: (use the default), or update this validator" >&2
	fi
	# test.root (4-space, the Vitest test option) — same relocation risk.
	if ! test_prop_absent "$cfg" root; then
		err "$pkg config sets test.root — it relocates the discovery base, so the pinned include no longer describes the covered files"
		echo "     → remove test.root (use the default), or update this validator" >&2
	fi
}

# Reject a `...` spread inside the test: block of a guarded vitest config. A
# spread placed AFTER the pinned include/exclude literal overrides it (JS object
# spread is last-wins) — e.g. `...{ include: ['src/__never__/**/*.test.ts'] }`
# makes Vitest match NO files, yet test_prop_has still finds the earlier pinned
# line and this guard reports every file covered. The legit guarded configs use
# no spreads, so any spread under test: is an override risk. (test_prop_has pins
# a literal LINE; it cannot reason about spreads/computed properties, so ban them.)
reject_config_spread() {
	local cfg="$1" pkg="$2"
	if awk '
		/^  test:[[:space:]]*\{?[[:space:]]*$/ { intest=1; next }
		/^  [a-zA-Z]/ { intest=0 }
		intest && /^[[:space:]]*\.\.\./ { found=1; exit }
		END { exit (found ? 0 : 1) }
	' "$cfg"; then
		err "$pkg/vitest.config.ts has a '...' spread inside test: — a spread after the pinned include/exclude overrides it (JS last-wins), so Vitest may match no files while this guard reports them covered"
		echo "     → inline the include/exclude literal; no spread/computed property under test:" >&2
	fi
}

# The text checks above (test_prop_has, reject_config_spread, …) see only the
# literal in the SOURCE. A post-construction mutation — `const c = defineConfig
# ({...}); c.test!.include = ['one/file']; export default c;` — leaves the source
# literal intact (so they pass) while Vitest resolves the mutated value and runs
# only that file. The only sound defense is to LOAD the config and compare the
# EFFECTIVE test.include/exclude (and absence of dir/shard/testNamePattern) to
# the pinned literals. Uses bun (a hard repo dependency; available in `bun run
# check` and CI). Skipped silently if bun is absent so the guard still runs.
reject_effective_config_drift() {
	local cfg="$1" pkg="$2" exp_inc="$3" exp_exc="$4" detail rc
	command -v bun >/dev/null 2>&1 || return 0
	detail=$(CFG_PATH="$cfg" EXP_INC="$exp_inc" EXP_EXC="$exp_exc" bun -e '
		const INC = process.env.EXP_INC, EXC = process.env.EXP_EXC;
		import(process.env.CFG_PATH).then(m => {
			const t = (m.default || m).test || {};
			const j = JSON.stringify.bind(JSON);
			const drift = [];
			if (j(t.include) !== INC) drift.push("include resolved to " + j(t.include));
			if (j(t.exclude) !== EXC) drift.push("exclude resolved to " + j(t.exclude));
			if (t.dir) drift.push("test.dir=" + t.dir);
			if (t.shard) drift.push("test.shard=" + t.shard);
			if (t.testNamePattern) drift.push("test.testNamePattern set");
			// A plugin config/configResolved hook can narrow test selection at
			// resolution time (invisible to a static import). The sound fix is
			// Vitest resolveConfig (not importable in this env); as defense-in-
			// depth, reject such a hook on any plugin that is not a known framework
			// internal (preact/vite/vitest/@vitejs/prefresh).
			const plugins = ((m.default || m).plugins || []).flat();
			// Exact known framework plugins only — a prefix match would let a local
			// plugin like "vite-narrow-tests" sneak through. Update this set if the
			// web plugin stack changes (the guard fails loudly to force a review).
			const SAFE_PLUGIN = ["preact:config", "vite:preact-jsx", "preact:transform-hook-names", "preact:devtools", "prefresh"];
			for (const p of plugins) {
				if ((typeof p.config === "function" || typeof p.configResolved === "function") && !SAFE_PLUGIN.includes(p.name))
					drift.push("plugin " + (p.name || "?") + " has a config/configResolved hook that could alter test selection");
			}
			if (drift.length) { console.error(drift.join("; ")); process.exit(1); }
			process.exit(0);
		}).catch(e => { console.error("could not load config (" + (e.message.split("\n")[0]) + ")"); process.exit(1); });
	' 2>&1); rc=$?
	[ "$rc" -eq 0 ] && return 0
	err "$pkg/vitest.config.ts effective test config does not match the pinned include/exclude: $detail"
	echo "     → Vitest's resolved config differs from the source literal (post-construction mutation, spread, or computed override); restore a literal 'export default defineConfig({...})'" >&2
}

# Reject matrix `module:` scalars in job (of file) whose value, after stripping
# optional YAML quotes, does not match the strict [a-z0-9-]+ format. The axis and
# include parsers normalize values for comparison, which silently maps a typo like
# `comp_onents` to `components`; GitHub treats them as DISTINCT modules, so the
# real `components` runs with an empty test_path (the whole online suite) while
# the typo becomes an extra combination — and this guard cannot soundly match it.
reject_invalid_module_values() {
	local file="$1" job="$2" _bad_modules
	_bad_modules=$(awk -v job="$job" '
		$0 ~ "^  " job ":" { injob=1; next }
		injob && /^  [a-z]/ { injob=0; next }
		!injob { next }
		# A module: scalar with a value on the line (skips the bare `module:` axis
		# header, whose values are list items handled by the axis parser format check).
		/[[:space:]]module:[[:space:]]*[^[:space:],}]/ {
			v=$0; sub(/.*module:[[:space:]]*/, "", v); sub(/[[:space:],}]*$/, "", v)
			gsub(/^['"'"'"]+|['"'"'"]+$/, "", v)
			if (v != "" && v !~ /^[a-z0-9][a-z0-9-]*$/) print v
		}
	' "$file" | sort -u)
	# Iterate in the CURRENT shell (here-string, not a pipeline) so err()'s
	# ERRORS counter increments — a `| while read` subshell would print but not
	# count, leaving the guard green (exit 0) despite the printed error.
	while IFS= read -r bad; do
		[ -n "$bad" ] || continue
		err "$job matrix has a module value '$bad' with invalid characters — GitHub treats it as a distinct module, so a typo here splits a combination (one side runs with an empty test_path) while this guard cannot match it"
		echo "     → use only lowercase letters, digits, and hyphens in module names" >&2
	done <<< "$_bad_modules"
}

# Reject a `module:` AXIS list item (block form: `module:` then `- item`) whose
# RAW scalar (after stripping optional YAML quotes) does not match
# ^[a-z0-9][a-z0-9-]*$. _axis_modules normalizes items (strips non-token chars)
# before use, so `- comp_onents` would silently become `components` and the guard
# exits 0 — but GitHub treats `comp_onents` as a DISTINCT value (no test_path →
# unfiltered run) while the include record makes a separate `components` combo.
# Validate the raw scalar the way reject_invalid_module_values does for scalars.
reject_invalid_axis_items() {
	local file="$1" job="$2" _bad
	_bad=$(awk -v job="$job" '
		$0 ~ "^  " job ":" { injob=1; next }
		injob && /^  [a-z]/ { injob=0; inaxis=0; next }
		!injob { next }
		injob && /^[[:space:]]*module:[[:space:]]*$/ { inaxis=1; next }
		inaxis && !/^[[:space:]]*#/ && !/^[[:space:]]*- / { inaxis=0; next }
		inaxis && /^[[:space:]]+- [^[:space:]#]/ {
			v=$0; sub(/^[[:space:]]+- [[:space:]]*/, "", v); sub(/[[:space:]].*/, "", v)
			gsub(/^['"'"'"]+|['"'"'"]+$/, "", v)
			if (v != "" && v !~ /^[a-z0-9][a-z0-9-]*$/) print v
		}
	' "$file" | sort -u)
	while IFS= read -r bad; do
		[ -n "$bad" ] || continue
		err "$job matrix has a module axis item '$bad' with invalid characters — GitHub treats it as a distinct value, so it gets no test_path (unfiltered run) while the include record creates a separate combination, and this guard cannot soundly match it"
		echo "     → use only lowercase letters, digits, and hyphens in module axis items" >&2
	done <<< "$_bad"
}

# Reject a matrix include row carrying a key NOT in the allowlist ($3, space-
# separated). An include row with an extra key (e.g. `replica: b`) introduces an
# ADDITIONAL matrix combination GitHub schedules — evading the module-axis and
# sibling-axis checks (those iterate the declared axis and top-level matrix keys,
# not include-row keys), so it silently duplicates runs (paid cross-provider runs
# for real-api). The allowlist is per job (mock_sdk/timeout for mocked-online;
# default_provider/secrets_used/reason for real-api).
reject_include_extra_keys() {
	local file="$1" job="$2" allowed="$3" _keys _k
	_keys=$(awk -v job="$job" '
		$0 ~ "^  " job ":" { injob=1; next }
		injob && /^  [a-z]/ { injob=0; inmatrix=0; ininc=0; next }
		!injob { next }
		/^[[:space:]]{6}matrix:[[:space:]]*$/ { inmatrix=1; ininc=0; next }
		inmatrix && /^[[:space:]]{0,6}[A-Za-z]/ && !/^[[:space:]]*include:/ { ininc=0 }
		inmatrix && /^[[:space:]]*include:[[:space:]]*$/ { ininc=1; next }
		ininc {
			n=0; while (substr($0,n+1,1)==" ") n++
			if (n <= 8 && $0 !~ /^[[:space:]]*$/) { ininc=0; next }
			if (/^[[:space:]]*#/) next
			line=$0; sub(/^[[:space:]]*- /, "", line); sub(/^[[:space:]]+/, "", line)
			if (match(line, /^[a-z_]+:/)) print substr(line, RSTART, RLENGTH-1)
		}
	' "$file" | sort -u)
	while IFS= read -r _k; do
		[ -n "$_k" ] || continue
		case " $allowed " in
			*" $_k "*) ;;
			*) err "$job include row has a non-allowlisted key '$_k:' — GitHub schedules an extra matrix combination for it (duplicate runs), evading the module/sibling-axis checks"
			   echo "     → use only the allowed include-row keys ($allowed) in $job" >&2 ;;
		esac
	done <<< "$_keys"
}

# Reject a matrix include row that has NO non-empty `module`. GitHub still
# schedules a moduleless include row as a combination (with an empty module
# name); if its test_path duplicates another row's, the test runs TWICE (for
# real-api that is a duplicate paid provider run). The per-record test_path
# check and _include_modules only iterate rows that HAVE a module, so a
# moduleless row is otherwise invisible.
reject_moduleless_include_rows() {
	local file="$1" job="$2" _hit
	_hit=$(awk -v job="$job" '
		function flush() { if (in_rec && !has_mod) bad=1 }
		$0 ~ "^  " job ":" { injob=1; next }
		injob && /^  [a-z]/ { flush(); injob=0; ininc=0; in_rec=0; next }
		!injob { next }
		injob && /^[[:space:]]*include:[[:space:]]*$/ { ininc=1; in_rec=0; has_mod=0; next }
		ininc {
			n=0; while (substr($0,n+1,1)==" ") n++
			if (n <= 8 && $0 !~ /^[[:space:]]*$/) { flush(); ininc=0; next }
			if (/^[[:space:]]*#/) next
			if (/^[[:space:]]*- /) {
				flush(); in_rec=1; has_mod=0
				line=$0; sub(/^[[:space:]]*- [[:space:]]*/, "", line); sub(/^[[:space:]]+/, "", line)
				if (line ~ /^module:[[:space:]]*[^[:space:]]/) has_mod=1
				next
			}
			if (in_rec && /^[[:space:]]*module:[[:space:]]*[^[:space:]]/) has_mod=1
		}
		END { flush(); if (bad) print "yes" }
	' "$file")
	if [ -n "$_hit" ]; then
		err "$job has an include row without a non-empty module — GitHub still schedules it as a matrix combination (empty module name), so a duplicate test_path runs the test twice while this guard reports it covered"
		echo "     → add a module to every $job include row" >&2
	fi
}

# True (exit 0 = BAD) if the guarded runner step (run contains marker, in job)
# of file would run under a NON-DEFAULT shell — a step-level `shell:`, or a
# job/workflow `defaults.run.shell`. enabled_run_cmd/marker_executed assume the
# run command is executed by the default shell; a no-exec override such as
# `shell: bash -n {0}` makes the step succeed having run ZERO tests while this
# guard reports them covered. The legit workflows set no shell anywhere.
runner_shell_override() {
	local file="$1" marker="$2" job="$3"
	# (a) A defaults.run.shell applies to the guarded runner ONLY at workflow
	# scope (a top-level `defaults:`, which covers every job) or when nested under
	# the target job. A job-scoped `defaults:` under an UNRELATED job (e.g. `check`)
	# leaves the runner's effective shell unchanged and must not be reported, so
	# track ownership: workflow scope (indent 0) is always relevant; a nested
	# `defaults:` is relevant only when its enclosing job is the target. While
	# inside a defaults block, consume children at strictly deeper indent so a
	# workflow-scope `  run:` is not misread as a job key; a dedent closes it.
	if awk -v job="$job" '
		in_defaults {
			n=0; while (substr($0, n+1, 1)==" ") n++
			if (n <= di) { in_defaults=0 }
			else {
				if (/shell:/ && scope != "other") { found=1; exit }
				next
			}
		}
		/^[[:space:]]{2}[[:alnum:]_-]+:[[:space:]]*$/ {
			curjob=$0; sub(/^[[:space:]]+/, "", curjob); sub(/:.*$/, "", curjob); next
		}
		/^[[:space:]]*defaults:[[:space:]]*$/ {
			di=0; while (substr($0, di+1, 1)==" ") di++
			in_defaults=1
			scope = (di == 0) ? "wf" : (curjob == job ? "job" : "other")
			next
		}
		END { exit !found }
	' "$file"; then
		return 0
	fi
	# (b) A step-level shell: on the runner step itself (run contains marker, in
	# job), mirroring enabled_run_cmd job/step scoping so it is attributed to the
	# runner step, not an unrelated sibling.
	awk -v marker="$marker" -v job="$job" '
		function emit() { if (runval != "" && index(runval, marker) > 0 && curjob == job && !done) { print (step_shell ? "BAD" : "OK"); done=1 } }
		/^[[:space:]]{2}[[:alnum:]_-]+:[[:space:]]*$/ { emit(); runval=""; step_shell=0; curjob=$0; sub(/^[[:space:]]+/, "", curjob); sub(/:.*$/, "", curjob); next }
		/^[[:space:]]*-[[:space:]]/ { emit(); runval=""; step_shell=0 }
		/^[[:space:]]*#/ { next }
		/^[[:space:]]*shell:/ { step_shell=1 }
		incmd { n=0; while (substr($0,n+1,1)==" ") n++; if (n > runindent) { runval=runval" "$0; next }; incmd=0 }
		/^[[:space:]]*run:[[:space:]]*[>|]/ { incmd=1; n=0; while (substr($0,n+1,1)==" ") n++; runindent=n; runval=$0; next }
		/^[[:space:]]*run:[[:space:]]+/ { runval=$0; incmd=0; next }
		END { emit() }
	' "$file" | grep -q '^BAD$'
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
	if ! test_prop_has "$_cfg" include "['tests/**/*.test.ts', 'tests/**/*_test.ts']"; then
		err "$_cfg_pkg/vitest.config.ts test.include is not ['tests/**/*.test.ts', 'tests/**/*_test.ts'] — unit shard paths could be filtered out (a nested coverage.include / appended expression no longer masks it)"
		echo "     → keep the include broad under test:, or update this validator" >&2
	fi
	# Require the EXACT expected exclude per package — daemon legitimately excludes
	# tests/online/** (separate online config). scoped to test.exclude (4-space).
	case "$_cfg_pkg" in
		daemon) _exp_exclude="['node_modules', 'dist', 'tests/online/**']" ;;
		shared) _exp_exclude="['node_modules', 'dist']" ;;
	esac
	if ! test_prop_has "$_cfg" exclude "$_exp_exclude"; then
		err "$_cfg_pkg/vitest.config.ts test.exclude is not $_exp_exclude — a broad/changed glob could filter unit shard paths"
		echo "     → keep the exclude to the expected set under test:, or update this validator" >&2
	fi
	# Selection-changing test options (dir, shard) narrow which files run without
	# touching include/exclude — reject them.
	test_no_select_opts "$_cfg" "$_cfg_pkg"
	# A non-default root relocates the include base; reject it (see cfg_reject_root).
	cfg_reject_root "$_cfg" "$_cfg_pkg"
	# A spread under test: overrides the pinned include/exclude (see reject_config_spread).
	reject_config_spread "$_cfg" "$_cfg_pkg"
	# Effective (resolved) config must match the pinned literal — catches post-
	# construction mutation/spread/computed overrides the text checks can't see.
	case "$_cfg_pkg" in
		daemon) reject_effective_config_drift "$_cfg" "$_cfg_pkg" \
			'["tests/**/*.test.ts","tests/**/*_test.ts"]' '["node_modules","dist","tests/online/**"]' ;;
		shared) reject_effective_config_drift "$_cfg" "$_cfg_pkg" \
			'["tests/**/*.test.ts","tests/**/*_test.ts"]' '["node_modules","dist"]' ;;
	esac
done

COVERED_TMP="$(mktemp)"
UNIT_FILTERS_TMP="$(mktemp)"
trap 'rm -f "$COVERED_TMP" "$UNIT_FILTERS_TMP"' EXIT

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
				# Record file-valued filters (a Vitest positional) for the substring-
				# overlap check below — a dir-expanded file is NOT a positional filter.
				printf '%s\t%s\n' "${spec#"$REPO_ROOT"/}" "$shard" >> "$UNIT_FILTERS_TMP"
			else
				err "daemon unit shard '$shard' references a path that no longer exists: $spec"
				echo "     → remove it from shard_paths() in scripts/test-daemon.sh" >&2
			fi
			;;
		esac
	done < <(shard_paths "$shard")
done

# A covered file must live under a package tests/ dir — the unit/shared configs
# include `tests/**`, so a shard path outside packages/*/tests/ (e.g. a file
# under packages/shared/src/ listed from the shared shard) is counted covered
# here yet filtered out by Vitest's include glob. Reject such owners.
while IFS= read -r _bad; do
	[ -n "$_bad" ] || continue
	err "unit/shared shard path is outside the config include root (packages/*/tests/), so Vitest would filter it out while this guard reports it covered: $_bad"
	echo "     → move it under the package tests/ dir, or drop it from shard_paths()" >&2
done < <(awk -F'\t' '{ print $1 }' "$COVERED_TMP" | grep -vE '^packages/[^/]+/tests/' | sort -u)

# Vitest matches CLI positional filters as path SUBSTRINGS, not exact paths. So a
# file-valued unit shard filter whose path is a substring of a file owned by a
# DIFFERENT shard makes that file run in BOTH shards (the shorter filter selects
# the longer-named file too) — yet the exact-path ownership accounting above
# (one owner per file) stays green. Compare every file-valued positional filter
# against every covered file in another shard; report any substring hit. (Mirrors
# the online section's cross-shard overlap check. shard_paths returns absolute
# paths, so this is defensive — currently zero overlaps — but it pins the
# invariant against a future substring-named pair.)
_unit_overlaps=$(awk -F'\t' '
	FNR==NR { fp[++nf]=$1; fs[nf]=$2; next }
	{ cp[++cf]=$1; cs[cf]=$2 }
	END {
		for (i=1; i<=nf; i++) for (j=1; j<=cf; j++) {
			if (fs[i] == cs[j]) continue          # same shard: not a cross overlap
			if (fp[i] == cp[j]) continue           # the filter itself
			if (index(cp[j], fp[i]) > 0) print fp[i] "\t" fs[i] "\t" cp[j]
		}
	}
' "$UNIT_FILTERS_TMP" "$COVERED_TMP")
if [ -n "$_unit_overlaps" ]; then
	while IFS=$'\t' read -r _filt _fshard _hit; do
		[ -n "$_filt" ] || continue
		err "unit shard '$_fshard' file filter '$_filt' is a substring of '$_hit' (owned by another shard) — Vitest matches positional filters as substrings, so that file runs in BOTH shards while this guard reports each file covered once"
		echo "     → rename the file or scope the filter so it is not a substring of another shard's file" >&2
	done <<< "$_unit_overlaps"
fi

# Every SHARDS entry must also appear in the ACTIVE CI unit matrix. A shard that
# runs locally via test-daemon.sh but is absent from CI would make this guard
# falsely report its files as covered (this is how `shared` — 25 files under
# packages/shared/tests — was silently skipped before being added to the matrix).
# Read the shard axis scoped to test-daemon-shared-unit — the FIRST `shard: [...]`
# anywhere in main.yml could belong to an unrelated job added later, masking a
# shard dropped from the real unit matrix.
unit_matrix=$(awk '
	$0 ~ "^  test-daemon-shared-unit:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; next }
	!injob { next }
	/^[[:space:]]*shard:[[:space:]]*\[/ {
		s=$0; sub(/.*\[/, "", s); sub(/\].*/, "", s)
		n=split(s, a, ","); for (i=1; i<=n; i++) { gsub(/[[:space:]]/, "", a[i]); if (a[i] != "") print a[i] }
	}
' "$REPO_ROOT/.github/workflows/main.yml")
# test-daemon-shared-unit's matrix must have ONLY the `shard:` axis (+ include/
# exclude). A sibling axis (e.g. replica: [a,b]) makes GitHub take the Cartesian
# product, running every unit test once per value (duplicate runs + duplicate
# Coveralls uploads) while this guard reports each file covered once.
_unit_sibling_axes=$(awk '
	$0 ~ "^  test-daemon-shared-unit:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; inmatrix=0; next }
	!injob { next }
	# `matrix:` block lives at 6-space indent under strategy: (4-space). Enter on
	# matrix:, leave on any sibling key at <= 6-space (e.g. steps:) — step keys
	# (uses:/with:/run:) are also 8-space but live under steps:, NOT matrix:.
	/^[[:space:]]{6}matrix:[[:space:]]*$/ { inmatrix=1; next }
	/^[[:space:]]{0,6}[a-z]/ { inmatrix=0 }
	inmatrix && /^[[:space:]]{8}[A-Za-z][A-Za-z0-9_-]*:/ {
		s=$0; sub(/^[[:space:]]+/, "", s); sub(/:.*/, "", s); k=tolower(s)
		if (k != "shard" && k != "include" && k != "exclude") print s
	}
' "$REPO_ROOT/.github/workflows/main.yml")
if [ -n "$_unit_sibling_axes" ]; then
	while IFS= read -r _ax; do
		[ -n "$_ax" ] || continue
		err "test-daemon-shared-unit matrix has an extra axis '$_ax:' — GitHub takes the Cartesian product, so every unit test runs once per value (duplicating runs) while this guard reports each file covered once"
		echo "     → remove the '$_ax:' axis, or model its combinations in this validator" >&2
	done <<< "$_unit_sibling_axes"
fi
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
_unit_run=$(enabled_run_cmd "$REPO_ROOT/.github/workflows/main.yml" 'test-daemon.sh ${{ matrix.shard }}' 'test-daemon-shared-unit')
if [ "$(count_enabled_run_cmds "$REPO_ROOT/.github/workflows/main.yml" 'test-daemon.sh ${{ matrix.shard }}' 'test-daemon-shared-unit')" -gt 1 ]; then
	err "test-daemon-shared-unit has more than one enabled runner step forwarding \${{ matrix.shard }} — each runs the shard (duplicate runs + duplicate Coveralls uploads) while this guard reports each file covered once"
	echo "     → keep exactly one enabled './scripts/test-daemon.sh ...' step" >&2
fi
if [ -z "$_unit_run" ]; then
	err "test-daemon-shared-unit runner is missing, commented, disabled, or does not forward \${{ matrix.shard }} — unit matrix values don't reach the runner"
	echo "     → keep an active, enabled './scripts/test-daemon.sh \${{ matrix.shard }} ...' step" >&2
elif ! marker_executed "$_unit_run" 'test-daemon.sh ${{ matrix.shard }}'; then
	err "test-daemon-shared-unit runner contains the marker but does not EXECUTE it (e.g. it is echoed/quoted as data) — zero tests would run while this guard reports them covered"
	echo "     → invoke test-daemon.sh as a command, not as an argument to echo/another command" >&2
elif runner_is_data_cmd "$_unit_run"; then
	err "test-daemon-shared-unit runner's first command token is a data command (echo/printf/cat) — the marker is an argument, not executed"
	echo "     → invoke test-daemon.sh as a command, not via echo" >&2
elif runner_has_dead_prefix "$_unit_run" 'test-daemon.sh ${{ matrix.shard }}'; then
	err "test-daemon-shared-unit runner places a dead prefix ('||'/'&&'/exit/exec) before test-daemon.sh (e.g. false && ... or true || ...) — Bash short-circuits, so the marker is never reached and zero tests run while this guard reports them covered"
	echo "     → remove the '||' prefix / dead branch before test-daemon.sh" >&2
elif runner_has_noexec_interp "$_unit_run" 'test-daemon.sh ${{ matrix.shard }}'; then
	err "test-daemon-shared-unit runner invokes a no-exec interpreter (e.g. bash -n) before test-daemon.sh — it would syntax-check the script and exit 0 having run ZERO tests while this guard reports them covered"
	echo "     → drop the -n / no-exec interpreter; invoke test-daemon.sh directly" >&2
elif runner_has_comment_before_marker "$_unit_run" 'test-daemon.sh ${{ matrix.shard }}'; then
	err "test-daemon-shared-unit runner has a '#' comment before test-daemon.sh (e.g. `true # ... ./scripts/test-daemon.sh`) — the comment blanks out the test command in CI, so the step runs ZERO tests while this guard reports them covered"
	echo "     → remove the '#' / commented prefix before test-daemon.sh" >&2
elif runner_post_sep_starts_with "$_unit_run" './scripts/test-daemon.sh'; then
	err "test-daemon-shared-unit runner's command after the flaky-runner separator is not './scripts/test-daemon.sh' — a wrapper over the marker (test -n, echo, [) exits 0 while running ZERO tests, and a data-command blacklist cannot enumerate every wrapper, while this guard reports them covered"
	echo "     → keep './scripts/test-daemon.sh ...' as the token after ' -- '" >&2
elif runner_continue_on_error "$REPO_ROOT/.github/workflows/main.yml" 'test-daemon.sh ${{ matrix.shard }}' 'test-daemon-shared-unit'; then
	err "test-daemon-shared-unit runner step (or its job) has continue-on-error: true — a FAILED unit run is marked successful, so coverage stays green while tests are broken"
	echo "     → remove continue-on-error from the test-daemon-shared-unit runner step/job" >&2
elif runner_shell_override "$REPO_ROOT/.github/workflows/main.yml" 'test-daemon.sh ${{ matrix.shard }}' 'test-daemon-shared-unit'; then
	err "test-daemon-shared-unit runner step (or its job) sets a non-default shell — a no-exec shell (e.g. bash -n {0}) would make the step succeed having run ZERO tests while this guard reports them covered"
	echo "     → remove the shell: override (use the default shell)" >&2
else
	# Inspect ONLY the args after `test-daemon.sh` (there is another
	# ${{ matrix.shard }} earlier, inside the --report ...json name). Allowlist
	# ONLY the execution-preserving --coverage flag: test-daemon.sh's other flags
	# (--rerun/--verify/--show-failures) are MODE switches handled before
	# RUN_SHARDS, so in a clean job --rerun/--verify exit 0 having run ZERO tests.
	# A bare positional shard is also rejected (last non-option wins as
	# TARGET_SHARD). After stripping the matrix token and --coverage, any leftover
	# is a mode switch or extra shard and fails.
	_tdargs=$(printf '%s' "$_unit_run" | awk '{ i=index($0,"test-daemon.sh"); print (i>0)? substr($0,i+14) : "" }')
	_extra=$(printf '%s' "$_tdargs" \
		| sed -E -e 's/\$\{\{[[:space:]]*matrix\.shard[[:space:]]*\}\}//g' \
		         -e 's/--coverage//g' \
		| tr -d "[:space:]'")
	# REQUIRE one affirmative --coverage: without it the shard produces no
	# coverage/lcov.info, the lcov-fix step exits success on a missing file, and
	# the Coveralls upload has fail-on-error:false — so the shard can vanish from
	# combined coverage without failing CI. Bare --coverage (space/EOL-terminated)
	# is the affirmative form; --coverage=false does not satisfy it.
	if ! printf '%s' "$_unit_run" | grep -qE -- '--coverage([[:space:]]|$)'; then
		err "test-daemon-shared-unit runner lacks --coverage — no lcov.info is produced, so the shard disappears from combined coverage without failing CI"
		echo "     → keep '--coverage' on the test-daemon.sh invocation" >&2
	elif [ -n "$_extra" ]; then
		err "test-daemon-shared-unit runner has a non-allowlisted arg after \${{ matrix.shard }} (only --coverage is permitted) — a mode flag (--rerun/--verify/--show-failures) would run zero tests, or a bare shard would override matrix.shard"
		echo "     → keep the runner as 'test-daemon.sh \${{ matrix.shard }} --coverage' only" >&2
	fi
fi

# Assert every unit/shared test file on disk is covered by exactly one shard.
unit_disk=$(
	find "$UNIT_ROOT" "$SHARED_ROOT" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) -not -path '*/node_modules/*' -not -path '*/dist/*' |
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
done < <(find "$UNIT_ROOT" "$SHARED_ROOT" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

unit_covered=$(sort -u "$COVERED_TMP" | wc -l | tr -d ' ')
echo "daemon unit: $unit_disk file(s) on disk, $unit_covered covered"

# Scan the WHOLE daemon package for test-shaped files outside tests/unit and
# tests/online — the daemon Vitest config includes only tests/**, so a test file
# under packages/daemon/src/ (or anywhere outside tests/) is invisible to CI.
while IFS= read -r _orphan; do
	[ -n "$_orphan" ] || continue
	err "daemon test file outside tests/unit/ or tests/online/ (CI config includes only tests/**, so this file never runs): ${_orphan#"$REPO_ROOT"/}"
	echo "     → move it under tests/unit/ or tests/online/" >&2
done < <(find "$REPO_ROOT/packages/daemon" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) \
	-not -path '*/tests/unit/*' -not -path '*/tests/online/*' \
	-not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

# A daemon/shared test file with a .tsx suffix is NOT matched by the pinned
# include (`tests/**/*.test.ts` / `*_test.ts` — no .tsx), so it would never run
# yet be invisible to the *.test.ts coverage model. check-test-quality.ts accepts
# .test.tsx, so surface it explicitly rather than let it sit silently uncovered.
while IFS= read -r _tsx; do
	[ -n "$_tsx" ] || continue
	err "daemon/shared test file has a .tsx suffix the pinned Vitest include does not match (it would never run, yet the *.test.ts coverage model ignores it): ${_tsx#"$REPO_ROOT"/}"
	echo "     → rename to .ts, or extend the daemon/shared include to cover .tsx" >&2
done < <(find "$UNIT_ROOT" "$SHARED_ROOT" -type f \( -name '*.test.tsx' -o -name '*.spec.tsx' \) \
	-not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

# ===========================================================================
# 2. WEB TESTS  (packages/web/src/** — single directory glob, one CI matrix)
# ===========================================================================
# The web suite is a `bunx vitest run --shard=i/N` matrix whose `include` glob
# roots at `src/`. Assert the config still does so — a narrowed include would
# orphan src test files with no other signal.
WEB_SRC="$REPO_ROOT/packages/web/src"
WEB_CFG="$REPO_ROOT/packages/web/vitest.config.ts"
# The web suite is a `bunx vitest run --shard=i/N` matrix. Require its `include`
# to be the full src/**/*.{test,spec}.{ts,tsx} glob, so ANY narrowing (dropping
# .tsx, inserting .unit., restricting the suffix, …) is caught rather than
# silently dropping files while this guard reports full coverage. A
# substring/fragment check is not enough — only the exact glob is.
# Scope the glob to `test.include` specifically (4-space indent, directly under
# test:) — NOT a nested coverage.include. A whole-file search can mask a
# so a glob placed in coverage.include would mask a narrowed test.include and
# the guard would still report all files covered while the runner executes only
# the narrowed set. Anchoring the exact indent + glob pins it to test.include.
if ! test_prop_has "$WEB_CFG" include "['src/**/*.{test,spec}.{ts,tsx}']"; then
	err "packages/web/vitest.config.ts test.include is not the full src/**/*.{test,spec}.{ts,tsx} glob — web tests may be orphaned (a nested coverage.include / appended expression no longer masks it)"
	echo "     → restore the full include under test:, or update this validator" >&2
fi
# test.exclude must stay node_modules/dist only — adding a src/ pattern there
# would silently skip those tests while this guard still marks them covered.
# Anchor to `test.exclude` (4-space indent) like the include check above, so a
# `coverage.exclude` holding ['node_modules','dist'] can't mask a narrowed
# test.exclude that drops src tests.
if ! test_prop_has "$WEB_CFG" exclude "['node_modules', 'dist']"; then
	err "packages/web/vitest.config.ts test.exclude is not ['node_modules', 'dist'] — src test files could be excluded (a nested coverage.exclude / appended expression no longer masks it)"
	echo "     → keep test.exclude to node_modules/dist, or update this validator" >&2
fi
# Selection-changing test options (dir, shard) narrow which files run without
# touching include/exclude — reject them.
test_no_select_opts "$WEB_CFG" "packages/web"
# A non-default root relocates the src/** include base; reject it.
cfg_reject_root "$WEB_CFG" "packages/web"
reject_config_spread "$WEB_CFG" "packages/web"
reject_effective_config_drift "$WEB_CFG" "packages/web" \
	'["src/**/*.{test,spec}.{ts,tsx}"]' '["node_modules","dist"]'
# The web suite is split across the test-web matrix via vitest --shard=<i>/<N>:
# vitest distributes test FILES deterministically, so the union of legs 1..N
# runs the whole suite. Pin that wiring — the shard axis must hold exactly the
# values 1..N (each once) with no matrix.exclude and no sibling axes, and the
# runner (checked below) must forward --shard=${{ matrix.shard }}/N with N the
# axis size. A dropped or duplicated axis value, or a fixed --shard that ignores
# the matrix token, leaves part of the suite unrun (or run twice) while this
# guard reports every file covered.
web_matrix=$(awk '
	$0 ~ "^  test-web:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; next }
	!injob { next }
	/^[[:space:]]*shard:[[:space:]]*\[/ {
		s=$0; sub(/.*\[/, "", s); sub(/\].*/, "", s)
		n=split(s, a, ","); for (i=1; i<=n; i++) { gsub(/[[:space:]]/, "", a[i]); if (a[i] != "") print a[i] }
	}
' "$REPO_ROOT/.github/workflows/main.yml")
web_shard_n=$(printf '%s\n' "$web_matrix" | grep -c .)
if [ "$web_shard_n" -eq 0 ]; then
	err "test-web has no 'shard: [ ... ]' matrix axis — the web suite is modeled here as a vitest --shard matrix, so a missing axis means the runner's --shard forwarding no longer matches a scheduled leg set"
	echo "     → restore 'shard: [1, 2]' under test-web's strategy.matrix (and the runner's --shard forwarding), or revert this validator to the single-job model" >&2
fi
while IFS= read -r _bad; do
	[ -n "$_bad" ] || continue
	err "test-web shard axis value '$_bad' is not a positive integer — vitest --shard needs numeric <index>/<total> legs"
	echo "     → use plain integers 1..N in the shard axis" >&2
done < <(printf '%s\n' "$web_matrix" | grep -vE '^[0-9]+$' | sort -u)
if [ "$web_shard_n" -ge 1 ]; then
	for _i in $(seq 1 "$web_shard_n"); do
		_count=$(printf '%s\n' "$web_matrix" | grep -xF "$_i" | wc -l | tr -d ' ')
		if [ "$_count" -ne 1 ]; then
			err "test-web shard axis must list every value 1..$web_shard_n exactly once — value '$_i' appears $_count time(s); a missing value leaves vitest's shard-$_i files unrun while this guard reports them covered, and a duplicate runs its slice twice"
			echo "     → list each of 1..$web_shard_n exactly once in the shard axis" >&2
		fi
	done
fi
_web_excluded=$(matrix_excludes "test-web" "shard")
if [ -n "$_web_excluded" ]; then
	while IFS= read -r _we; do
		[ -n "$_we" ] || continue
		err "test-web shard '$_we' is removed by matrix.exclude — GitHub drops the combination, so vitest's shard-$_we files never run while this guard reports them covered"
		echo "     → remove the exclude entry, or drop the shard from the axis AND shrink the runner's --shard denominator" >&2
	done <<< "$_web_excluded"
fi
_web_sibling_axes=$(awk '
	$0 ~ "^  test-web:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; inmatrix=0; next }
	!injob { next }
	/^[[:space:]]{6}matrix:[[:space:]]*$/ { inmatrix=1; next }
	/^[[:space:]]{0,6}[a-z]/ { inmatrix=0 }
	inmatrix && /^[[:space:]]{8}[A-Za-z][A-Za-z0-9_-]*:/ {
		s=$0; sub(/^[[:space:]]+/, "", s); sub(/:.*/, "", s); k=tolower(s)
		if (k != "shard" && k != "include" && k != "exclude") print s
	}
' "$REPO_ROOT/.github/workflows/main.yml")
if [ -n "$_web_sibling_axes" ]; then
	while IFS= read -r _ax; do
		[ -n "$_ax" ] || continue
		err "test-web matrix has an extra axis '$_ax:' — GitHub takes the Cartesian product, so every web shard runs once per value (duplicate runs + duplicate Coveralls uploads) while this guard reports each file covered once"
		echo "     → remove the '$_ax:' axis, or model its combinations in this validator" >&2
	done <<< "$_web_sibling_axes"
fi

# The web coverage assumes the test-web CI job runs `vitest run` (no positional
# target) in an ENABLED step, so the config include/exclude — plus the matrix
# --shard split — fully determine execution. enabled_run_cmd folds the runner
# command (a `>-` scalar) and skips disabled/commented steps; we then require
# `vitest run` to be followed by a flag (or the closing quote), not a positional
# path — a target on a folded continuation line would otherwise evade an
# end-of-physical-line check.
_web_cmd=$(enabled_run_cmd "$REPO_ROOT/.github/workflows/main.yml" 'cd packages/web && bunx vitest run' 'test-web')
if [ "$(count_enabled_run_cmds "$REPO_ROOT/.github/workflows/main.yml" 'cd packages/web && bunx vitest run' 'test-web')" -gt 1 ]; then
	err "test-web has more than one enabled 'cd packages/web && bunx vitest run' step — each runs the web suite (duplicate runs + duplicate Coveralls uploads) while this guard reports each file covered once"
	echo "     → keep exactly one enabled web runner step" >&2
fi
if [ -z "$_web_cmd" ]; then
	err "test-web runner is missing, commented, or disabled (if: false|never) — web coverage assumption broken"
	echo "     → keep an active, enabled 'cd packages/web && bunx vitest run' step" >&2
elif ! marker_executed "$_web_cmd" 'cd packages/web && bunx vitest run'; then
	err "test-web runner contains the marker but does not EXECUTE it (e.g. it is echoed/quoted as data) — zero tests would run while this guard reports them covered"
	echo "     → invoke 'bunx vitest run' as a command, not as an argument to echo/another command" >&2
elif runner_post_sep_starts_with "$_web_cmd" 'bash -lc'; then
	err "test-web runner's command after the flaky-runner separator is not 'bash -lc' — a wrapper over the marker (test -n, echo, [) exits 0 while running ZERO web tests, and a data-command blacklist cannot enumerate every wrapper, while this guard reports them covered"
	echo "     → keep \"bash -lc 'cd packages/web && bunx vitest run ...'\" as the token after ' -- '" >&2
elif runner_is_data_cmd "$_web_cmd"; then
	err "test-web runner's first command token is a data command (echo/printf/cat) — the marker is an argument, not executed"
	echo "     → invoke 'bunx vitest run' as a command, not via echo" >&2
elif runner_has_dead_prefix "$_web_cmd" 'cd packages/web && bunx vitest run'; then
	err "test-web runner places a dead prefix ('||'/'&&'/exit/exec) before the vitest invocation (e.g. bash -lc 'false && cd packages/web && bunx vitest run' or 'true || ...') — Bash short-circuits, so the marker is never reached and zero web tests run while this guard reports them covered"
	echo "     → remove the '||' prefix / dead branch before 'bunx vitest run'" >&2
elif runner_has_noexec_interp "$_web_cmd" 'cd packages/web && bunx vitest run'; then
	err "test-web runner invokes a no-exec interpreter (e.g. bash -n) before the vitest invocation — it would parse without executing and exit 0 having run ZERO web tests while this guard reports them covered"
	echo "     → drop the -n / no-exec interpreter; run vitest directly" >&2
elif runner_has_comment_before_marker "$_web_cmd" 'cd packages/web && bunx vitest run'; then
	err "test-web runner has a '#' comment before the vitest invocation (e.g. bash -lc 'true # cd packages/web && bunx vitest run') — the comment blanks out vitest in CI, so the step runs ZERO web tests while this guard reports them covered"
	echo "     → remove the '#' / commented prefix before 'bunx vitest run'" >&2
elif runner_continue_on_error "$REPO_ROOT/.github/workflows/main.yml" 'cd packages/web && bunx vitest run' 'test-web'; then
	err "test-web runner step (or its job) has continue-on-error: true — a FAILED web run is marked successful, so coverage stays green while web tests are broken"
	echo "     → remove continue-on-error from the test-web runner step/job" >&2
elif runner_shell_override "$REPO_ROOT/.github/workflows/main.yml" 'cd packages/web && bunx vitest run' 'test-web'; then
	err "test-web runner step (or its job) sets a non-default shell — a no-exec shell (e.g. bash -n {0}) would make the step succeed having run ZERO web tests while this guard reports them covered"
	echo "     → remove the shell: override (use the default shell)" >&2
elif [ "$(printf '%s' "$_web_cmd" | sed 's/.*bunx vitest run//' | grep -oF -- '--shard=' | wc -l | tr -d ' ')" -ne 1 ] ||
     ! printf '%s' "$_web_cmd" | sed 's/.*bunx vitest run//' | grep -qF -- "--shard=\${{ matrix.shard }}/$web_shard_n"; then
	err "test-web runner does not pass exactly one '--shard=\${{ matrix.shard }}/$web_shard_n' — a fixed --shard, a stale denominator, or a missing/duplicated flag makes every leg run the same slice (or a narrower/unsharded set) while this guard reports all files covered"
	echo "     → keep '--shard=\${{ matrix.shard }}/$web_shard_n' as the only --shard flag after 'bunx vitest run'" >&2
elif [ -n "$(printf '%s' "$_web_cmd" \
		| sed 's/.*bunx vitest run//' \
		| sed -E -e 's/[$][{][{][[:space:]]*matrix[.]shard[[:space:]]*[}][}]//g' \
		         -e 's/--reporter[[:space:]]+[^[:space:]]+//g' \
		         -e 's/--reporter=[^[:space:]]+//g' \
		         -e 's/--outputFile\.[[:alnum:]_-]+(=[^[:space:]]+)?//g' \
		         -e 's/--shard=[^[:space:]]+//g' \
		         -e 's/--coverage\.[[:alnum:]_.-]+(=[^[:space:]]+)?//g' \
		         -e 's/--coverage(=[[:space:]]*true)?//g' \
		         -e 's/--color//g' -e 's/--no-color//g' \
		| tr -d "[:space:]'\"")" ]; then
	# Allowlist ONLY coverage-neutral flags (--reporter, --coverage*, --color)
	# plus the matrix-forwarded --shard (validated by the dedicated branch
	# above, so blanket-stripping every --shard token here cannot hide a second,
	# overriding one); do NOT blanket-strip every --flag. Selection-changing
	# flags like --changed, --testNamePattern, or --dir narrow which files run
	# while this guard reports all covered, so anything left after the allowlist
	# (a positional OR an unknown flag) fails.
	err "test-web runner passes a positional filter or non-allowlisted flag to 'vitest run' — web coverage assumption broken (e.g. --changed/--testNamePattern would narrow discovery while this guard reports all files covered)"
	echo "     → keep 'vitest run' bare (only --reporter/--coverage*/--color/--shard flags, no positional or selection-changing flag)" >&2
elif [ "$(printf '%s' "$_web_cmd" | grep -oF 'bunx vitest run' | wc -l | tr -d ' ')" -gt 1 ]; then
	err "test-web runner has multiple 'bunx vitest run' invocations — the first could exit 0 (e.g. --testNamePattern __never__), so the fallback via || never executes"
	echo "     → use exactly one 'bunx vitest run' invocation" >&2
	echo "     → keep 'vitest run' bare (only --reporter/--coverage*/--color/--shard flags, no positional or selection-changing flag)" >&2
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
# Ownership model (task #912): the mocked-online matrix (test-daemon-online in
# main.yml) carries NO hand-listed test_path values anymore. Each matrix module
# is resolved at run time by scripts/test-online.sh — a directory glob for
# small dirs, or a stable-hash bucket (scripts/lib/shard-split.sh) for
# oversized ones — so a new online test file auto-routes to a shard with no
# YAML edit. This guard therefore sources scripts/test-online.sh (it has a
# source-guard and exposes only its config/functions) and derives file
# ownership from online_module_paths() the same way CI does, instead of
# enumerating hand-listed files.
#
# real-api-tests.yml (daemon-real-api) is OUT of that rework: its shards are
# real-key, manual-only, and keep explicit per-file test_path rows, so the
# per-value checks below continue to apply to it unchanged.
ONLINE_DIR="packages/daemon/tests/online"
MAIN_WORKFLOW=".github/workflows/main.yml"
REAL_API_WORKFLOW=".github/workflows/real-api-tests.yml"

# Source of truth for mocked-online module→files resolution. Sourcing is safe:
# test-online.sh returns early when sourced (guard at its bottom) and exports
# only ONLINE_MODULES / ONLINE_HASH_SPLIT_SPECS / online_module_paths /
# online_all_modules / ONLINE_TEST_ROOT.
# shellcheck source=test-online.sh
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/test-online.sh"

# The online runner config (vitest.online.config.ts) determines which matrix
# paths Vitest actually executes — Vitest applies include/exclude even to
# explicitly-passed paths. The include must cover BOTH suffixes this guard
# enumerates (*.test.ts AND *_test.ts): if the config matched only *.test.ts, a
# *_test.ts file under a directory-owned module would be counted as "covered"
# here yet filtered out by Vitest, so its shard would run it zero times. It must
# also not drop tests/online/ via the exclude, or matrix paths could be filtered
# out while this guard (which only checks the matrix) stays green.
ONLINE_CFG="$REPO_ROOT/packages/daemon/vitest.online.config.ts"
if ! test_prop_has "$ONLINE_CFG" include "['tests/online/**/*.test.ts', 'tests/online/**/*_test.ts']"; then
	err "packages/daemon/vitest.online.config.ts test.include must be ['tests/online/**/*.test.ts', 'tests/online/**/*_test.ts'] — a *_test.ts file enumerated as covered must actually be run, not filtered out (a nested coverage.include no longer masks it)"
	echo "     → keep the include covering both *.test.ts and *_test.ts under test:" >&2
fi
# Require the exact exclude (scoped to test.exclude) — node_modules/dist/
# tests/unit/** is the expected set (tests/unit/** keeps the online config from
# picking up unit suites).
if ! test_prop_has "$ONLINE_CFG" exclude "['node_modules', 'dist', 'tests/unit/**']"; then
	err "packages/daemon/vitest.online.config.ts test.exclude is not ['node_modules','dist','tests/unit/**'] — a broad/changed glob could exclude online tests"
	echo "     → keep the exclude to node_modules/dist/tests/unit/** under test:, or update this validator" >&2
fi
# Selection-changing test options (dir, shard) narrow which files run without
# touching include/exclude — reject them.
test_no_select_opts "$ONLINE_CFG" "packages/daemon/vitest.online"
# A non-default root relocates the tests/online/** include base; reject it.
cfg_reject_root "$ONLINE_CFG" "packages/daemon/vitest.online"
reject_config_spread "$ONLINE_CFG" "packages/daemon/vitest.online"
reject_effective_config_drift "$ONLINE_CFG" "packages/daemon/vitest.online" \
	'["tests/online/**/*.test.ts","tests/online/**/*_test.ts"]' '["node_modules","dist","tests/unit/**"]'

# Each guarded test job's job-level if: must EQUAL its pinned predicate (not a
# substring match). A substring search accepts a gate like
# `github.event.inputs.run_e2e_only != 'true' && github.event_name == 'never'`,
# which GitHub evaluates FALSE in normal CI — silently skipping every shard
# while this guard reports its files covered. enabled_run_cmd only catches
# literal if:false/never, so pinning the FULL predicate is what blocks a compound
# always-false gate. (A missing if: is not flagged: it runs the job
# unconditionally, which does not drop coverage.)
_check_job_gate() {
	local job="$1" file="$2" exp="$3" raw gate
	raw=$(awk -v j="$job" '
		$0 ~ "^  " j ":" { injob=1; next }
		injob && /^  [a-z]/ { injob=0; next }
		injob && /^[[:space:]]{4}if:/ { print; exit }
	' "$file")
	gate=$(printf '%s' "$raw" | sed -E "s/^[[:space:]]*if:[[:space:]]*//; s/[[:space:]]*$//")
	if [ -n "$raw" ] && [ "$gate" != "$exp" ]; then
		err "$job job-level if: is not the pinned gate (got: ${gate:-<none>}) — a weakened or compound condition (e.g. an extra && always-false clause) would skip the job in normal CI while this guard reports its files covered"
		echo "     → restore: if: $exp" >&2
	fi
	# A needs: chains this job to another job's result. If that dependency is
	# skipped on ordinary PRs (e.g. a `discover`-style job), GitHub skips this job
	# too (its default success() requirement is unmet), so its tests never run
	# while this guard reports them covered. The guarded jobs have no needs: today;
	# reject any (validate the explicit if: only, not the whole chain, so ban it).
	if awk -v j="$job" '
		$0 ~ "^  " j ":" { injob=1; next }
		injob && /^  [a-z]/ { injob=0; next }
		injob && /^[[:space:]]{4}needs:/ { found=1; exit }
		END { exit !found }
	' "$file"; then
		err "$job has a needs: dependency — a skipped dependency (e.g. a job gated off on ordinary PRs) skips this job too, so its tests never run while this guard reports them covered"
		echo "     → remove needs: from $job (the guarded test jobs must run unconditionally)" >&2
	fi
}
_check_job_gate test-daemon-shared-unit "$MAIN_WORKFLOW" "github.event.inputs.run_e2e_only != 'true'"
_check_job_gate test-web "$MAIN_WORKFLOW" "(github.event_name == 'pull_request' && github.base_ref == 'dev' || github.event_name == 'push' && github.ref == 'refs/heads/dev' || github.event_name == 'workflow_dispatch') && github.event.inputs.run_e2e_only != 'true'"
_check_job_gate test-daemon-online "$MAIN_WORKFLOW" "github.ref_type != 'tag' && github.event.inputs.run_e2e_only != 'true'"
_check_job_gate daemon-real-api "$REAL_API_WORKFLOW" "github.event.inputs.run_e2e_only != 'true'"
# Reject module: scalars with invalid characters (a typo like `comp_onents` is a
# distinct module to GitHub — splits a combination while this guard cannot match).
reject_invalid_module_values "$MAIN_WORKFLOW" test-daemon-online
reject_invalid_module_values "$REAL_API_WORKFLOW" daemon-real-api
# A module axis item with invalid chars is a distinct value to GitHub (no
# test_path → unfiltered run) while the include record makes a separate combo.
reject_invalid_axis_items "$MAIN_WORKFLOW" test-daemon-online
reject_invalid_axis_items "$REAL_API_WORKFLOW" daemon-real-api
# An include row carrying an extra key adds a hidden combination (duplicate runs).
# test-daemon-online include rows now carry module/mock_sdk/timeout only —
# test_path was removed with the hand-listed shards (files resolve via
# scripts/test-online.sh); a test_path row here would silently bypass the
# runner's resolution.
reject_include_extra_keys "$MAIN_WORKFLOW" test-daemon-online "module mock_sdk timeout"
reject_include_extra_keys "$REAL_API_WORKFLOW" daemon-real-api "module test_path default_provider secrets_used reason"
# A moduleless include row is still scheduled (empty module name) → dup runs.
reject_moduleless_include_rows "$MAIN_WORKFLOW" test-daemon-online
reject_moduleless_include_rows "$REAL_API_WORKFLOW" daemon-real-api

# The mocked-online runner must resolve its module through scripts/test-online.sh:
# the matrix no longer carries test_path values, so the runner forwards
# ${{ matrix.module }} to `scripts/test-online.sh <module>` and feeds the
# emitted paths to vitest. The marker picks the runner step itself
# (vitest.online.config.ts in main.yml — NOT the docs `echo "Tests: …"` step),
# so a commented/disabled (if:false) runner, or one swapped for a fixed
# target, fails.
_online_main=$(enabled_run_cmd "$REPO_ROOT/.github/workflows/main.yml" 'vitest.online.config.ts' 'test-daemon-online')
if [ "$(count_enabled_run_cmds "$REPO_ROOT/.github/workflows/main.yml" 'vitest.online.config.ts' 'test-daemon-online')" -gt 1 ]; then
	err "test-daemon-online has more than one enabled runner step — each runs its online shard (duplicate runs) while this guard reports each file covered once"
	echo "     → keep exactly one enabled online runner step" >&2
fi
if [ -z "$_online_main" ]; then
	err "main.yml online runner is missing, commented, or disabled (if: false|never) — online coverage assumption broken"
	echo "     → keep an active, enabled online runner step" >&2
elif ! printf '%s' "$_online_main" | grep -qF 'scripts/test-online.sh ${{ matrix.module }}'; then
	err "main.yml online runner does not resolve its module via 'scripts/test-online.sh \${{ matrix.module }}' — matrix modules would not reach the test selection (a fixed target runs one shard in every job while this guard reports all covered)"
	echo "     → keep '\$(... scripts/test-online.sh \${{ matrix.module }} ...)' in the vitest invocation" >&2
elif ! marker_executed "$_online_main" 'vitest.online.config.ts'; then
	err "main.yml online runner contains the marker but does not EXECUTE it (e.g. it is echoed/quoted as data) — zero tests would run while this guard reports them covered"
	echo "     → invoke vitest as a command, not as an argument to echo/another command" >&2
elif runner_post_sep_starts_with "$_online_main" 'bash -lc'; then
	err "main.yml online runner's command after the flaky-runner separator is not 'bash -lc' — a wrapper over the marker (test -n, echo, [) exits 0 while running ZERO online tests, and a data-command blacklist cannot enumerate every wrapper, while this guard reports them covered"
	echo "     → keep \"bash -lc '... vitest run ...'\" as the token after ' -- '" >&2
elif runner_is_data_cmd "$_online_main"; then
	err "main.yml online runner's first command token is a data command (echo/printf/cat) — the marker is an argument, not executed"
	echo "     → invoke vitest as a command, not via echo" >&2
elif runner_has_dead_prefix "$_online_main" 'cd packages/daemon && node_modules/.bin/vitest run'; then
	err "main.yml online runner places a dead prefix ('||'/'&&'/exit/exec) before vitest (e.g. bash -lc 'false && ... && vitest run' or 'true || ...') — Bash short-circuits, so the marker is never reached and zero online tests run while this guard reports them covered"
	echo "     → remove the '||' prefix / dead branch before 'vitest run'" >&2
elif runner_has_noexec_interp "$_online_main" 'cd packages/daemon && node_modules/.bin/vitest run'; then
	err "main.yml online runner invokes a no-exec interpreter (e.g. bash -n) before vitest — it would parse without executing and exit 0 having run ZERO online tests while this guard reports them covered"
	echo "     → drop the -n / no-exec interpreter; run vitest directly" >&2
elif runner_has_comment_before_marker "$_online_main" 'cd packages/daemon && node_modules/.bin/vitest run'; then
	err "main.yml online runner has a '#' comment before vitest (e.g. bash -lc 'true # ... vitest run') — the comment blanks out vitest in CI, so the step runs ZERO online tests while this guard reports them covered"
	echo "     → remove the '#' / commented prefix before 'vitest run'" >&2
elif runner_continue_on_error "$REPO_ROOT/.github/workflows/main.yml" 'vitest.online.config.ts' 'test-daemon-online'; then
	err "main.yml online runner step (or its job) has continue-on-error: true — a FAILED online run is marked successful, so coverage stays green while online tests are broken"
	echo "     → remove continue-on-error from the test-daemon-online runner step/job" >&2
elif runner_shell_override "$REPO_ROOT/.github/workflows/main.yml" 'vitest.online.config.ts' 'test-daemon-online'; then
	err "main.yml online runner step (or its job) sets a non-default shell — a no-exec shell (e.g. bash -n {0}) would make the step succeed having run ZERO online tests while this guard reports them covered"
	echo "     → remove the shell: override (use the default shell)" >&2
else
	# After `vitest run`, only the resolver-produced $paths (the one selector)
	# and coverage-neutral flags (--config, --coverage*, --reporter,
	# --outputFile.*, --color) may appear. A selection flag like
	# --exclude=<glob> or --testNamePattern would omit files while the ownership
	# walk reports them covered. (The config file itself is guarded separately,
	# so --config is safe.)
	#
	# The resolver assignment (`paths=$(cd ../.. && scripts/test-online.sh
	# <module>)`) is allowlisted with a bracket expression so no '/' delimiter
	# collides; `[^)]*` bounds it to ONE substitution — a greedy `.*` would span
	# first-`$(cd`-to-last-`)` and blank a `--testNamePattern` sandwiched
	# before a trailing second substitution (the resolver body contains no `)`).
	_oextra=$(printf '%s' "$_online_main" \
		| sed 's/.*vitest run//' \
		| sed -E -e 's/paths=[$][(]cd[[:space:]][^)]*[)]//g' \
		         -e 's/[$][{][{][[:space:]]*matrix[.]module[[:space:]]*[}][}]//g' \
		         -e 's/[$]paths//g' \
		         -e 's/--config vitest[.]online[.]config[.]ts//g' \
		         -e 's/--reporter[[:space:]]+[^[:space:]]+//g' \
		         -e 's/--reporter=[^[:space:]]+//g' \
		         -e 's/--coverage[.][[:alnum:]_.-]+(=[^[:space:]]+)?//g' \
		         -e 's/--outputFile[.][[:alnum:]_-]+(=[^[:space:]]+)?//g' \
		         -e 's/--coverage(=[[:space:]]*true)?//g' \
		         -e 's/--color//g' -e 's/--no-color//g' \
		| tr -d "[:space:]")
	# Coverage disabling: --coverage.enabled=false silently produces no LCOV report,
	# and the Coveralls upload has fail-on-error:false, so the shard disappears from
	# coverage results without failing CI.
	if printf '%s' "$_online_main" | grep -qF 'coverage.enabled=false'; then
		err "main.yml online runner disables coverage (coverage.enabled=false) — no LCOV report, shard disappears from coverage results without failing CI"
		echo "     → remove coverage.enabled=false" >&2
	elif ! printf '%s' "$_online_main" | grep -qE -- '--coverage([[:space:]]|$)'; then
		err "main.yml online runner lacks a bare --coverage — no lcov.info is produced, so the shard disappears from combined coverage without failing CI (the --coverage.* sub-options alone do not enable it)"
		echo "     → keep '--coverage' on the vitest invocation" >&2
	elif [ "$(printf '%s' "$_online_main" | grep -oF 'vitest run' | wc -l | tr -d ' ')" -gt 1 ]; then
		err "main.yml online runner has multiple 'vitest run' invocations — the first could exit 0 (e.g. --help), so the fallback never executes"
		echo "     → use exactly one 'vitest run' invocation" >&2
	elif ! printf '%s' "$_online_main" | sed 's/.*vitest run//' | grep -qF '$paths'; then
		err "main.yml online runner has the module resolution only BEFORE 'vitest run' (e.g. resolved to a variable that is then discarded) — vitest would receive no positional and run the entire online suite unfiltered while this guard reports each module covered"
		echo "     → pass the resolved paths as the positional AFTER 'vitest run' (\$paths)" >&2
	elif [ -n "$_oextra" ]; then
		err "main.yml online runner has a selection flag or extra arg after 'vitest run' — e.g. --exclude=<glob>/--testNamePattern would omit files while the ownership walk reports them covered"
		echo "     → keep only the resolved \$paths plus --config/--coverage*/--reporter/--outputFile.* flags" >&2
	fi
fi
_online_real=$(enabled_run_cmd "$REPO_ROOT/.github/workflows/real-api-tests.yml" 'bun test' 'daemon-real-api')
if [ "$(count_enabled_run_cmds "$REPO_ROOT/.github/workflows/real-api-tests.yml" 'bun test' 'daemon-real-api')" -gt 1 ]; then
	err "daemon-real-api has more than one enabled 'bun test' step — a folded second step repeats paid provider calls while this guard reports each file covered once"
	echo "     → keep exactly one enabled 'bun test \${{ matrix.test_path }}' step" >&2
fi
if [ -z "$_online_real" ] || ! printf '%s' "$_online_real" | grep -qF '${{ matrix.test_path }}'; then
	err "real-api-tests.yml online runner is missing, commented, disabled, or does not forward \${{ matrix.test_path }} — online matrix values don't reach the runner"
	echo "     → keep an active, enabled 'bun test \${{ matrix.test_path }}' step" >&2
elif ! marker_executed "$_online_real" 'bun test'; then
	err "real-api-tests.yml runner contains the marker but does not EXECUTE it (e.g. it is echoed/quoted as data) — zero tests would run while this guard reports them covered"
	echo "     → invoke 'bun test' as a command, not as an argument to echo/another command" >&2
elif [ "$(printf '%s' "$_online_real" | sed -E 's/^[[:space:]]*run:[[:space:]]*//' | sed -E 's/^([>|]-)[[:space:]]*//' | sed -E 's/^[ "'"'"']//' | awk '{print $1, $2}')" != "bun test" ]; then
	err "real-API runner's first two tokens are not 'bun test' — 'test' must be Bun's subcommand (e.g. bun -e 'void 0' bun test ... bypasses)"
	echo "     → invoke 'bun test \${{ matrix.test_path }}' as the command" >&2
elif [ "$(printf '%s' "$_online_real" | grep -oF 'bun test' | wc -l | tr -d ' ')" -gt 1 ]; then
	err "real-API runner has multiple 'bun test' invocations — the first could run and exit 0 (e.g. --only with no matches), so the \${{ matrix.test_path }} fallback via || never executes"
	echo "     → use exactly one 'bun test' invocation" >&2
elif runner_continue_on_error "$REPO_ROOT/.github/workflows/real-api-tests.yml" 'bun test' 'daemon-real-api'; then
	err "real-API runner step (or its job) has continue-on-error: true — a FAILED real-API run is marked successful, so CI stays green while paid cross-provider tests are broken"
	echo "     → remove continue-on-error from the daemon-real-api runner step/job" >&2
elif runner_shell_override "$REPO_ROOT/.github/workflows/real-api-tests.yml" 'bun test' 'daemon-real-api'; then
	err "real-API runner step (or its job) sets a non-default shell — a no-exec shell (e.g. bash -n {0}) would make the step succeed having run ZERO real-API tests while this guard reports them covered"
	echo "     → remove the shell: override (use the default shell)" >&2
else
	# After `bun test`, only ${{ matrix.test_path }} may select. A selection flag
	# like --only (test.only only) / --grep / --filter would run ZERO tests on a
	# file of ordinary tests yet exit 0, so every paid real-API shard could
	# silently run nothing while this guard reports its file covered.
	_bextra=$(printf '%s' "$_online_real" \
		| sed 's/.*bun test//' \
		| sed -E -e 's/\$\{\{[[:space:]]*matrix\.test_path[[:space:]]*\}\}//g' \
		| tr -d "[:space:]'")
	if ! printf '%s' "$_online_real" | sed 's/.*bun test//' | grep -qF '${{ matrix.test_path }}'; then
		err "real-api-tests.yml runner has \${{ matrix.test_path }} only BEFORE 'bun test' (e.g. in a MATRIX_PATH= assignment) — bun test would receive no positional and run the entire online suite while this guard reports the file covered"
		echo "     → place \${{ matrix.test_path }} as a positional AFTER 'bun test'" >&2
	elif [ -n "$_bextra" ]; then
		err "real-api-tests.yml runner has an extra arg after 'bun test \${{ matrix.test_path }}' — a selection flag like --only/--grep would run zero tests while this guard reports the file covered"
		echo "     → keep the runner as 'bun test \${{ matrix.test_path }}' with no selection flag or extra positional" >&2
	fi
fi
# The real-API runner executes `bun test <test_path>` from the step's working-
# directory. If it isn't packages/daemon, the tests/online/* patterns match no
# files (bun exits 0 with "filter matched no test files"). Pin it.
_real_wd=$(awk '
	$0 ~ "^  daemon-real-api:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; next }
	!injob { next }
	# working-directory is STEP-SCOPED: reset wd at each step boundary so a
	# working-directory on a PRECEDING step does not leak to the bun-test step.
	/^[[:space:]]*-[[:space:]]/ { wd="" }
	/working-directory:/ { wd=$0; sub(/.*working-directory:[[:space:]]*/, "", wd); sub(/[[:space:]]*$/, "", wd) }
	/run:.*bun test/ { print wd; wd="DEFAULT" }
' "$REAL_API_WORKFLOW")
if [ "$_real_wd" != "packages/daemon" ]; then
	err "daemon-real-api 'bun test' step working-directory is '${_real_wd:-<unset>}' (expected packages/daemon) — tests/online/* patterns would match no files (bun exits 0)"
	echo "     → keep working-directory: packages/daemon on the bun test step" >&2
fi

# Every online `module:` axis entry must be a module scripts/test-online.sh
# can resolve to ≥1 file. An axis module that resolves to nothing makes the
# runner resolve zero positionals → an UNFILTERED vitest run that executes the
# ENTIRE online suite (duplicates tests across jobs, reaches intentionally-
# exempt dirs). Resolution is delegated to the source of truth (test-online.sh)
# rather than re-derived here, so this guard follows split rebalances with no
# edits. test-online.sh --verify (wired into CI separately) covers the deeper
# config↔matrix consistency in both directions.
_axis_modules=$(awk '
	/^  test-daemon-online:/ { injob=1; next }
	injob && /^  [a-z]/ { inaxis=0; injob=0; next }
	injob && /^[[:space:]]*module:[[:space:]]*$/ { inaxis=1; next }
	injob && /^[[:space:]]*include:/ { inaxis=0 }
	# Accept an optional YAML quote around the axis value; strip non-token chars
	# so a quoted entry with no include record is still seen by the orphan check
	# rather than silently ignored.
	inaxis && !/^[[:space:]]*#/ && /^[[:space:]]+- [^[:space:]#]/ {
		v=$0; sub(/^[[:space:]]+- [[:space:]]*/, "", v); sub(/[[:space:]].*/, "", v); gsub(/[^a-z0-9-]/, "", v)
		if (v ~ /^[a-z0-9][a-z0-9-]*$/) print v
	}
' "$MAIN_WORKFLOW")
# The mocked-online matrix no longer carries test_path values (they resolve at
# run time), so the module→value map for main.yml is empty by design; only the
# real-API workflow still has per-file test_path rows for the checks below.
_module_values=""
# Build the mocked-online file→owners map by resolving every axis module
# through scripts/test-online.sh — the same function CI's runner step calls.
# Each entry: "<daemon-package-relative path>\t<module>". Used by the
# resolution-driven ownership walk and the prefix-overlap check below. A file
# owned by two modules (overlapping globs) runs twice — flagged in the walk.
ONLINE_COVERED_TMP="$(mktemp)"
trap 'rm -f "$COVERED_TMP" "$UNIT_FILTERS_TMP" "$ONLINE_COVERED_TMP"' EXIT
for _m in $_axis_modules; do
	_paths=$(online_module_paths "$_m")
	if [ -z "$_paths" ]; then
		err "online matrix module '$_m' resolves to 0 files via scripts/test-online.sh — the runner would receive no positional and run the entire online suite unfiltered"
		echo "     → fix the module (scripts/test-online.sh --verify), or drop it from the module axis" >&2
	fi
	while IFS= read -r _p; do
		[ -n "$_p" ] || continue
		printf '%s\t%s\n' "${_p#packages/daemon/}" "$_m" >> "$ONLINE_COVERED_TMP"
	done <<< "$_paths"
done

# Symmetric check for real-api-tests.yml: its daemon-real-api job is an
# include-only matrix (no `module:` axis), so every include row IS a combination
# that runs `bun test ${{ matrix.test_path }}`. A row without a non-empty
# test_path expands to a bare `bun test`, which `bun test --help` documents as
# "Run all test files" — running the entire online suite (and, with real keys,
# paid provider calls). The main.yml orphan check above doesn't cover this file.
_real_module_values=$(module_values "$REAL_API_WORKFLOW" "daemon-real-api")
# A test_path value must be a plain path — no shell metacharacters. The online
# runners are `bash -lc '... <test_path> ...'`, so a value containing `#` (a YAML
# folded-scalar line that only LOOKS like a comment), `;`, `&`, `|`, or `<`/`>`
# is reinterpreted by the shell: a `#` comments out the rest of the line,
# dropping subsequent paths/flags while this guard reports them covered.
while IFS= read -r _bad; do
	[ -n "$_bad" ] || continue
	err "online test_path value contains shell metacharacters (the bash -lc runner would reinterpret them — e.g. # comments out the rest): $_bad"
	echo "     → keep test_path a plain path (no # ; & | < >)" >&2
done < <(printf '%s\n' "$_module_values" "$_real_module_values" | awk -F'\t' '{print $2}' | grep -vE '^[a-zA-Z0-9./_-]+$' | sort -u)
# Per-RECORD validation (not grouped by module name): each daemon-real-api
# include row IS a combination running `bun test ${{ matrix.test_path }}`, so a
# row without a non-empty test_path expands to a bare `bun test` (which
# `bun test --help` documents as "Run all test files"). Validating per-record —
# not by module name — catches two rows sharing a module where one omits
# test_path (a name-grouped count would let the valid row cover both).
while IFS= read -r _rm; do
	[ -n "$_rm" ] || continue
	err "real-api include row for module '$_rm' has no non-empty test_path — \${{ matrix.test_path }} would expand empty, so 'bun test' runs the entire online suite"
	echo "     → add a test_path to the row, or remove it" >&2
done < <(awk '
	function flush() { if (injob && mod != "" && !has_path) print mod }
	$0 ~ "^  daemon-real-api:" { injob=1; next }
	injob && /^  [a-z]/ { flush(); injob=0; mod=""; has_path=0; folding=0; next }
	!injob { next }
	/^[[:space:]]*#/ { next }
	# Key-order-independent: detect record by any list-item, collect module and
	# test_path from the dash-line key OR subsequent properties at mi+2.
	/^[[:space:]]*- / {
		flush()
		mi=0; while (substr($0,mi+1,1)==" ") mi++
		mod=""; has_path=0; folding=0
		line=$0; sub(/^[[:space:]]*- [[:space:]]*/, "", line); sub(/^[[:space:]]+/, "", line)
		if (line ~ /^module:/) { sub(/^module:[[:space:]]*/, "", line); sub(/[[:space:]]*$/, "", line); gsub(/[^a-z0-9-]/, "", line); mod=line }
		else if (line ~ /^test_path:[[:space:]]*[>|]-[[:space:]]*$/) { folding=1 }
		else if (line ~ /^test_path:[[:space:]]+[^[:space:]>|-]/) { has_path=1 }
		next
	}
	{
		n=0; while (substr($0,n+1,1)==" ") n++
		if (n <= mi) { flush(); mod=""; has_path=0; folding=0; next }
		if (folding) {
			if (n > mi+2) { has_path=1; next }
			folding=0
		}
		if (n == mi+2 && $0 ~ /module:/) {
			v=$0; sub(/.*module:[[:space:]]*/, "", v); sub(/[[:space:]]*$/, "", v); gsub(/[^a-z0-9-]/, "", v); mod=v
		}
		else if (n == mi+2 && $0 ~ /test_path:[[:space:]]*[>|]-[[:space:]]*$/) { folding=1 }
		else if (n == mi+2 && $0 ~ /test_path:[[:space:]]+[^[:space:]>|-]/) { has_path=1 }
	}
	END { flush() }
' "$REAL_API_WORKFLOW")

# daemon-real-api's matrix must be include-only (no sibling axis). A sibling
# axis (e.g. replica: [a,b]) takes the Cartesian product, running every PAID
# cross-provider test once per value. Allowed matrix keys: include/exclude only.
_real_sibling_axes=$(awk '
	$0 ~ "^  daemon-real-api:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; inmatrix=0; next }
	!injob { next }
	/^[[:space:]]{6}matrix:[[:space:]]*$/ { inmatrix=1; next }
	/^[[:space:]]{0,6}[a-z]/ { inmatrix=0 }
	inmatrix && /^[[:space:]]{8}[A-Za-z][A-Za-z0-9_-]*:/ {
		s=$0; sub(/^[[:space:]]+/, "", s); sub(/:.*/, "", s); k=tolower(s)
		if (k != "include" && k != "exclude") print s
	}
' "$REAL_API_WORKFLOW")
if [ -n "$_real_sibling_axes" ]; then
	while IFS= read -r _ax; do
		[ -n "$_ax" ] || continue
		err "daemon-real-api matrix has an extra axis '$_ax:' — GitHub takes the Cartesian product, so every paid cross-provider test runs once per value"
		echo "     → remove the '$_ax:' axis" >&2
	done <<< "$_real_sibling_axes"
fi

# Symmetric to the unit and mocked-online exclude checks: a `matrix.exclude`
# under daemon-real-api drops an include row, but `_real_module_values` reads
# the include block raw, so every downstream ownership check would still treat
# that row (and its test_path) as scheduled. Reject excludes outright — this
# guard models disabling a real-API shard by commenting out its include row, so
# a matrix.exclude (keyed on module, test_path, or any other field) is a silent
# drop this guard cannot soundly model. Detect ANY non-empty exclude (block or
# flow form, regardless of key) rather than a single key, so a test_path-keyed
# exclude cannot slip past a module-only check.
_real_excluded=$(awk '
	$0 ~ "^  daemon-real-api:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; inmatrix=0; inexclude=0; next }
	!injob { next }
	/^[[:space:]]{6}matrix:[[:space:]]*$/ { inmatrix=1; next }
	/^[[:space:]]{0,6}[a-z]/ { inmatrix=0; inexclude=0 }
	# Flow form: exclude: [ ... ] with at least one non-whitespace entry.
	inmatrix && $0 ~ "^[[:space:]]*exclude:[[:space:]]*\\[[^]]*\\]" {
		body=$0; sub(/^[^[]*\[/, "", body); sub(/\][^]]*$/, "", body); gsub(/[[:space:]]/, "", body)
		if (body != "") { print "flow"; exit }
		next
	}
	# Block form: "exclude:" alone, then any indented "- ..." list item.
	inmatrix && $0 ~ "^[[:space:]]*exclude:[[:space:]]*$" { inexclude=1; next }
	inmatrix && inexclude {
		n=0; while (substr($0,n+1,1)==" ") n++
		if (n <= 8) { inexclude=0; next }
		if ($0 ~ /^[[:space:]]*-[[:space:]]/) { print "block"; exit }
	}
' "$REAL_API_WORKFLOW")
if [ -n "$_real_excluded" ]; then
	err "daemon-real-api matrix has a matrix.exclude — GitHub drops those include rows, so their test_path values never run while this guard reports them covered"
	echo "     → remove the exclude, or disable the module by commenting out its include row in $REAL_API_WORKFLOW" >&2
fi

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

# test-daemon-online's matrix must have ONLY the `module:` axis (+ include/
# exclude). A sibling axis (e.g. replica: [a,b]) takes the Cartesian product,
# running every mocked-online shard once per value (duplicate runs + concurrent
# duplicate Coveralls uploads).
_online_sibling_axes=$(awk '
	$0 ~ "^  test-daemon-online:" { injob=1; next }
	injob && /^  [a-z]/ { injob=0; inmatrix=0; next }
	!injob { next }
	/^[[:space:]]{6}matrix:[[:space:]]*$/ { inmatrix=1; next }
	/^[[:space:]]{0,6}[a-z]/ { inmatrix=0 }
	inmatrix && /^[[:space:]]{8}[A-Za-z][A-Za-z0-9_-]*:/ {
		s=$0; sub(/^[[:space:]]+/, "", s); sub(/:.*/, "", s); k=tolower(s)
		if (k != "module" && k != "include" && k != "exclude") print s
	}
' "$MAIN_WORKFLOW")
if [ -n "$_online_sibling_axes" ]; then
	while IFS= read -r _ax; do
		[ -n "$_ax" ] || continue
		err "test-daemon-online matrix has an extra axis '$_ax:' — GitHub takes the Cartesian product, so every online shard runs once per value (duplicate runs)"
		echo "     → remove the '$_ax:' axis" >&2
	done <<< "$_online_sibling_axes"
fi

# Every active `include:` module must ALSO be in the `module:` axis. GitHub
# treats an include row whose module is NOT in the axis as an ADDITIONAL
# combination (it cannot augment any existing axis entry), so it silently
# schedules a job this guard never authorized — running a test_path even for a
# module that was intentionally disabled (e.g. glm, which sits in EXEMPT_DIRS
# precisely because it is commented out of the axis). The checks above only
# iterate `_axis_modules`, so such an include-only row is otherwise invisible.
_include_modules=$(awk '
	$0 ~ "^  test-daemon-online:" { injob=1; next }
	injob && /^  [a-z]/ { if (mod != "") { print mod; mod="" }; injob=0; next }
	!injob { next }
	/^[[:space:]]*#/ { next }
	# Key-order-independent: detect record by any list-item, collect module from
	# the dash-line key OR a subsequent property at mi+2, regardless of order.
	/^[[:space:]]*- / {
		if (mod != "") { print mod; mod="" }
		mi=0; while (substr($0,mi+1,1)==" ") mi++
		line=$0; sub(/^[[:space:]]*- [[:space:]]*/, "", line); sub(/^[[:space:]]+/, "", line)
		if (line ~ /^module:/) { sub(/^module:[[:space:]]*/, "", line); sub(/[[:space:]]*$/, "", line); gsub(/[^a-z0-9-]/, "", line); mod=line }
		next
	}
	{
		n=0; while (substr($0,n+1,1)==" ") n++
		if (n <= mi) { if (mod != "") { print mod; mod="" }; next }
		if (n == mi+2 && $0 ~ /^[[:space:]]*module:/) {
			v=$0; sub(/.*module:[[:space:]]*/, "", v); sub(/[[:space:]]*$/, "", v); gsub(/[^a-z0-9-]/, "", v); mod=v
		}
	}
	END { if (mod != "") print mod }
' "$MAIN_WORKFLOW")
for _im in $_include_modules; do
	if ! printf '%s\n' "$_axis_modules" | grep -qxF "$_im"; then
		err "online include row for module '$_im' is not in the module: axis — GitHub creates an extra matrix combination for it, running its test_path even if the module was intentionally disabled"
		echo "     → add '$_im' to the module: axis, or comment out / remove the include row" >&2
	fi
done
# Each axis module must have EXACTLY ONE include record. GitHub applies ALL
# matching include records to the single axis combination (later test_path
# REPLACES earlier augmentation, not a second job), so two records for one module
# leave the earlier record's file uncovered in CI while _module_values reports
# both paths.
for _m in $_axis_modules; do
	_rcount=$(printf '%s\n' "$_include_modules" | grep -xF "$_m" | wc -l | tr -d ' ')
	if [ "$_rcount" -gt 1 ]; then
		err "online module '$_m' has $_rcount include records — GitHub applies all to one combination (later test_path replaces earlier), so the earlier record's file would not run while this guard reports it covered"
		echo "     → merge into one include record, or rename the duplicate module" >&2
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
# real. Exact-value parsing (the job-scoped module→test_path maps) is what makes
# ".bak" visible — the disk file's path is a substring of ".bak", so the old
# substring grep reported it covered.
while IFS= read -r _tp; do
	[ -n "$_tp" ] || continue
	_full="$REPO_ROOT/packages/daemon/$_tp"
	if [ ! -e "$_full" ]; then
		err "online test_path value '$_tp' does not exist on disk — CI would run zero files for that shard"
		echo "     → fix the path, or remove the matrix row" >&2
	elif [ -d "$_full" ]; then
		case "$_tp" in
			tests/online/*) ;;
			*)
				err "online test_path directory '$_tp' is not under tests/online/ — CI could run a non-online suite (e.g. tests/unit)"
				echo "     → point test_path at a directory under tests/online/" >&2
				;;
		esac
		# Directory-level test_path: Vitest auto-discovers test files under it, so
		# the directory must contain at least one — otherwise the filter matches
		# nothing and `bun test`/`vitest` exits 0 having run ZERO tests (a hole the
		# per-disk-file walk below cannot see, since it has no file to flag).
		if ! find "$_full" -type f \( -name '*.test.ts' -o -name '*_test.ts' \) -print -quit | grep -q .; then
			err "online test_path directory '$_tp' contains no test files — CI would run zero files for that shard"
			echo "     → add a test file under it, point test_path at a specific file, or remove the matrix row" >&2
		fi
	else
		# File-level test_path: must be an actual test file under tests/online/
		# with a recognized suffix. `bun test src/app.ts` matches no test files and
		# exits 0, so a non-test path would run zero tests while the guard reports
		# it covered.
		case "$_tp" in
			tests/online/*.test.ts|tests/online/*_test.ts) ;;
			*)
				err "online test_path file '$_tp' is not a test file under tests/online/ (need a *.test.ts/*_test.ts under tests/online/) — CI would match no test files"
				echo "     → point test_path at a tests/online/*.test.ts file, or a directory" >&2
				;;
		esac
	fi
# Job-scoped: only test_path values from the guarded jobs' include records
# (test-daemon-online / daemon-real-api), so an unrelated job reusing the
# conventional `test_path` matrix key (e.g. an E2E/CLI job) is NOT fed to this
# online validator.
done < <(printf '%s\n' "$_module_values" "$_real_module_values" | awk -F'\t' '$2 != "" {print $2}' | sort -u)

# Detect overlapping positional filter prefixes. Vitest treats positional
# filters as substring matches, so `tests/online/sdk` also matches files under
# `tests/online/sdk-extra`, and `rpc-agent.test.ts` matches
# `rpc-agent.test.ts.bak` — those tests run twice. Compare ALL values (files
# and directories) from BOTH sources: the real-API test_path values AND the
# mocked modules' resolved paths (both daemon-package-relative, so a mocked
# module's resolution and a real-API row prefix-overlapping is caught too).
_dir_overlap=$( { awk -F'\t' '{ print $1 }' "$ONLINE_COVERED_TMP" | sort -u; \
	printf '%s\n' "$_real_module_values" | awk -F'\t' '{print $2}' | sort -u; } \
	| awk '
		{ vals[NR]=$0 }
		END {
			for (i=1;i<=NR;i++) for (j=1;j<=NR;j++) {
				if (i==j) continue
				a=vals[i]; b=vals[j]
				if (a != "" && index(b, a) == 1) print a " > " b
			}
		}
	')
if [ -n "$_dir_overlap" ]; then
	while IFS= read -r _line; do
		[ -n "$_line" ] || continue
		err "overlapping directory test_path filters: $_line — Vitest treats positional filters as substring matches, so files match both shards (duplicate runs)"
		echo "     → rename to avoid prefix overlap, or merge into one shard" >&2
	done <<< "$_dir_overlap"
fi

# ── Mocked-online ownership (resolution-driven) ─────────────────────────────
# The mocked-online matrix no longer lists files; ownership is derived by
# resolving every axis module through scripts/test-online.sh (the same
# function CI's runner step calls) and building a file→owners map. A real-API
# file may not also be owned by a mocked module (duplicate shard ownership
# across workflows); the real-API workflow keeps its explicit per-file rows
# (checked separately below).
#
# Real-key cross-provider tests must be present in real-api-tests.yml.
CROSS_PROVIDER_FILES=(
	cross-provider-model-switch.test.ts
	glm-to-anthropic-resume.test.ts
	thinking-block-signatures.test.ts
)

for _cpf in "${CROSS_PROVIDER_FILES[@]}"; do
	_tp="tests/online/cross-provider/$_cpf"
	_hits=$(awk -F'\t' -v p="$_tp" '$2 == p' <<<"$_real_module_values" | wc -l | tr -d ' ')
	if [ "$_hits" -eq 0 ]; then
		err "$_tp is not a test_path value in its designated workflow $REAL_API_WORKFLOW"
		echo "     → add it to a matrix row in $REAL_API_WORKFLOW" >&2
	elif [ "$_hits" -gt 1 ]; then
		err "$_tp is a test_path value in $_hits rows of $REAL_API_WORKFLOW — duplicate shard ownership (would run twice, paid calls)"
		echo "     → list it in exactly one matrix row" >&2
	fi
done

# (The mocked-online file→owners map ONLINE_COVERED_TMP is built earlier,
# right after _axis_modules is parsed — the prefix-overlap check needs it.)

# A mocked module must not own a real-API file: the real workflow runs it with
# real keys (paid calls); a mocked duplicate runs it again through Dev Proxy.
while IFS= read -r _p; do
	[ -n "$_p" ] || continue
	if [ "$(awk -F'\t' -v p="$_p" '$2 == p' <<<"$_real_module_values" | wc -l | tr -d ' ')" -gt 0 ]; then
		err "online test is owned by both a mocked module and a real-API shard (duplicate shard ownership): $_p"
		echo "     → exclude it from the mocked module's globs in scripts/test-online.sh, or drop the real-API row" >&2
	fi
done < <(awk -F'\t' '{print $1}' "$ONLINE_COVERED_TMP" | sort -u)

# A module directory is "covered" iff some mocked module's resolution owns its
# files; otherwise it must be exempt (intentionally disabled) or owned by a
# real-API row (cross-provider). Deriving coverage from the resolution —
# instead of a static allow-list — catches a directory whose CI shard was
# removed or commented out (e.g. glm/providers below). The exempt list is
# shared with scripts/test-online.sh (ONLINE_EXEMPT_DIRS, sourced above), so
# this guard and test-online.sh --verify cannot drift apart. cross-provider
# sits in that list too (real-API-only; mocked ownership of its files is
# rejected in the per-file walk below).
EXEMPT_DIRS="$ONLINE_EXEMPT_DIRS"
for dir in "$ONLINE_DIR"/*/; do
	[ -d "$dir" ] || continue
	dirname=$(basename "$dir")
	if [ "$dirname" != "cross-provider" ] && [[ " $EXEMPT_DIRS " == *" $dirname "* ]]; then
		# Exempt dirs are intentionally not run, so NO owner may exist — neither
		# a mocked module resolution nor a real-API test_path under it. The map
		# ($1) and real-API values ($2) are both daemon-package-relative
		# (tests/online/<dir>/…), so the patterns share that prefix.
		file_under=$(awk -F'\t' -v p="^tests/online/$dirname/" '$1 ~ p' "$ONLINE_COVERED_TMP" | wc -l | tr -d ' ')
		real_under=$(awk -F'\t' -v p="^tests/online/$dirname/" '$2 ~ p' <<<"$_real_module_values" | wc -l | tr -d ' ')
		if [ "${file_under:-0}" -gt 0 ] || [ "${real_under:-0}" -gt 0 ]; then
			err "online exempt directory 'tests/online/$dirname' has an owner (a mocked module resolution or a real-API test_path under it) — that would re-enable an intentionally disabled module"
			echo "     → remove the owner, or drop the dir from ONLINE_EXEMPT_DIRS in scripts/test-online.sh" >&2
		fi
		continue
	fi
	# Per-file ownership: exactly one mocked owner per test file (cross-provider
	# files are owned by real-API rows instead and checked above).
	while IFS= read -r f; do
		# The map stores daemon-package-relative paths (tests/online/<dir>/<rel>)
		# — what online_module_paths emits — so key the lookup on that, not the
		# basename (a nested file whose basename collides with a root-level entry
		# must not be conflated).
		rel="${f#"$ONLINE_DIR"/}"
		owners=$(awk -F'\t' -v f="tests/online/$rel" '$1 == f { print $2 }' "$ONLINE_COVERED_TMP" | sort -u)
		owner_count=$(printf '%s\n' "$owners" | grep -c . || true)
		real_refs=$(awk -F'\t' -v p="tests/online/$rel" '$2 == p' <<<"$_real_module_values" | wc -l | tr -d ' ')
		if [ "$dirname" = "cross-provider" ]; then
			# cross-provider is real-API-only: a mocked owner duplicates paid runs.
			if [ "$owner_count" -gt 0 ]; then
				err "tests/online/$rel is owned by mocked module(s) '$(printf '%s,' "$owners" | sed 's/,$//')' but cross-provider is real-API-only — duplicate shard ownership"
				echo "     → remove cross-provider from the mocked module globs in scripts/test-online.sh" >&2
			elif [ "$real_refs" -ne 1 ]; then
				err "tests/online/$rel has $real_refs real-API test_path references (expected exactly 1)"
				echo "     → list it in exactly one real-API matrix row, or add it to EXEMPT_DIRS" >&2
			fi
			continue
		fi
		if [ "$owner_count" -eq 0 ] && [ "$real_refs" -eq 0 ]; then
			err "online test not covered by any active CI shard: tests/online/$rel"
			echo "     → add its directory to a module in scripts/test-online.sh (or to EXEMPT_DIRS if the module is disabled)" >&2
		elif [ "$owner_count" -gt 1 ]; then
			err "tests/online/$rel has $owner_count mocked module owners ($(printf '%s,' "$owners" | sed 's/,$//')) — duplicate shard ownership (runs twice)"
			echo "     → scope the module globs in scripts/test-online.sh so each file has exactly one owner" >&2
		elif [ "$owner_count" -ge 1 ] && [ "$real_refs" -gt 0 ]; then
			err "tests/online/$rel has both a mocked owner and $real_refs real-API reference(s) — duplicate shard ownership"
			echo "     → keep it in exactly one workflow" >&2
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
