#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
run=$(mktemp -d "${TMPDIR:-/tmp}/release-ci-gate.XXXXXX")
trap 'rm -rf "$run"' EXIT
mkdir "$run/bin"
cat > "$run/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
[[ " $* " == *" run list "* && " $* " == *" --workflow=main.yml "* && " $* " == *" --branch=dev "* && " $* " == *" --event=push "* && " $* " == *" --commit=$EXPECTED_SHA "* ]] || exit 23
cat "$GH_FIXTURE"
EOF
chmod +x "$run/bin/gh"
export PATH="$run/bin:$PATH" GITHUB_REPOSITORY=example/repository GH_FIXTURE="$run/runs.json"
export EXPECTED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
good='{"databaseId":123,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headBranch":"dev","event":"push","status":"completed","conclusion":"success"}'
check() {
  expected=$1
  printf '%s\n' "$2" > "$GH_FIXTURE"
  if bash "$root/scripts/release-ci-gate.sh" "$EXPECTED_SHA" > "$run/output" 2>&1; then actual=pass; else actual=fail; fi
  if [[ "$actual" != "$expected" ]]; then cat "$run/output"; echo "Expected $expected, got $actual"; exit 1; fi
}
check pass "[$good]"
check fail '[]'
check fail "[${good/\"success\"/\"failure\"}]"
check fail "[${good/\"success\"/\"cancelled\"}]"
check fail "[${good/\"completed\"/\"in_progress\"}]"
check fail "[${good/\"success\"/null}]"
check fail "[${good/\"dev\"/\"other\"}]"
check fail "[${good/\"push\"/\"workflow_dispatch\"}]"
check fail "[${good/$EXPECTED_SHA/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}]"
check fail "[${good/\"success\"/\"failure\"},$good]"
check fail 'not json'
if bash "$root/scripts/release-ci-gate.sh" not-a-sha > "$run/output" 2>&1; then
  echo 'Invalid SHA was accepted'; exit 1
fi
rm "$GH_FIXTURE"
if bash "$root/scripts/release-ci-gate.sh" "$EXPECTED_SHA" > "$run/output" 2>&1; then
  echo 'Failed GitHub lookup was accepted'; exit 1
fi
echo 'PASS: only the latest completed successful dev push for the exact commit is accepted'
