#!/bin/bash
set -euo pipefail

port=${1:?daemon port required}
out=${2:?evidence directory required}
verify=.claude/skills/verify
mkdir -p "$out"
trap '"$verify/stop.sh" "$RUN"; cp "$RUN/daemon.log" "$out/daemon.log"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$verify/launch.sh" "$port" "$RUN"
export VERIFY_PORT="$port" HYPERNEO_DATA_DIR="$RUN/data"

rpc() {
  bun "$verify/rpc.ts" "$1" "$2"
}

rpc rpc:providers.create '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' |
  jq -e '.reply | select(has("error") | not)' >/dev/null

init_repo() {
  local folder="$1" branch="$2"
  git init -q -b "$branch" "$folder"
  env -i PATH=/usr/bin:/bin HOME="$RUN/home" GIT_AUTHOR_NAME=Fixture \
    GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture \
    GIT_COMMITTER_EMAIL=fixture@example.invalid git -C "$folder" commit -q --allow-empty -m 'Fixture base'
}

repo="$RUN/Example"
init_repo "$repo" dev

create_archive() {
  local title="$1" folder="${2:-$repo}" id params checkout worktree
  id=$(rpc rpc:session.create "$(jq -nc --arg path "$folder" --arg title "$title" \
    '{workspacePath:$path,title:$title,worktreeMode:"worktree"}')" | jq -er '.reply.sessionId')
  params=$(jq -nc --arg id "$id" '{sessionId:$id}')
  checkout=$(rpc rpc:session.get "$params" | jq -e '.reply.session.worktree')
  jq -e '.branch' <<< "$checkout" > "$out/$title-branch.json"
  worktree=$(jq -er '.worktreePath' <<< "$checkout")
  test -d "$worktree" || return 1
  rpc rpc:session.archive "$params" | jq -e '.reply | select(.success)' > "$out/$title-archive.json"
  test ! -e "$worktree" || return 1
  printf '%s\n' "$id"
}

id=$(create_archive RPC)
params=$(jq -nc --arg id "$id" '{sessionId:$id}')
rpc rpc:session.unarchive "$params" > "$out/unarchive.json"
jq -e '.reply.success and .reply.worktreeBaseBranch == "dev"' "$out/unarchive.json"
rpc rpc:session.get "$params" > "$out/restored.json"
jq -e '.reply.session | .status == "active" and .archivedAt == null' "$out/restored.json"
worktree=$(jq -er '.reply.session.worktree.worktreePath' "$out/restored.json")
test "$(git -C "$worktree" rev-parse HEAD)" = "$(git -C "$repo" rev-parse dev)"
echo 'PASS: archived RPC session restored on dev (1 session)'

recorded_id=$(create_archive Recorded)
recorded_branch=$(jq -r . "$out/Recorded-branch.json")
recorded_tip=$(env -i PATH=/usr/bin:/bin HOME="$RUN/home" GIT_AUTHOR_NAME=Fixture \
  GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture \
  GIT_COMMITTER_EMAIL=fixture@example.invalid git -C "$repo" commit-tree 'dev^{tree}' -p dev -m 'Recorded branch tip')
git -C "$repo" branch "$recorded_branch" "$recorded_tip"
recorded_params=$(jq -nc --arg id "$recorded_id" '{sessionId:$id}')
rpc neo.session.unarchive "$recorded_params" > "$out/neo-unarchive.json"
jq -e '.reply | (.value // .) | .success and .worktreeBaseBranch != "dev"' "$out/neo-unarchive.json"
rpc rpc:session.get "$recorded_params" > "$out/neo-restored.json"
recorded_tree=$(jq -er '.reply.session.worktree.worktreePath' "$out/neo-restored.json")
test "$(git -C "$recorded_tree" rev-parse HEAD)" = "$recorded_tip"
test "$(git -C "$repo" rev-parse "$recorded_branch")" = "$recorded_tip"
echo 'PASS: Neo operation restored the recorded branch tip (1 session)'

main_repo="$RUN/Main"
init_repo "$main_repo" main
main_id=$(create_archive 'Main fallback' "$main_repo")
main_params=$(jq -nc --arg id "$main_id" '{sessionId:$id}')
rpc rpc:session.unarchive "$main_params" > "$out/main-unarchive.json"
jq -e '.reply.success and .reply.worktreeBaseBranch == "main"' "$out/main-unarchive.json"
rpc rpc:session.get "$main_params" > "$out/main-restored.json"
main_tree=$(jq -er '.reply.session | select(.status == "active" and .archivedAt == null) | .worktree.worktreePath' "$out/main-restored.json")
test "$(git -C "$main_tree" rev-parse HEAD)" = "$(git -C "$main_repo" rev-parse main)"
echo 'PASS: archived RPC session restored on main without dev (1 session)'


desktop=$(create_archive 'Desktop restore')
phone=$(create_archive 'Phone restore')
mkdir "$RUN/Other"
rpc rpc:workspace.add "$(jq -nc --arg path "$RUN/Other" '{path:$path}')" >/dev/null
other=$(rpc rpc:session.create "$(jq -nc --arg path "$RUN/Other"   '{workspacePath:$path,title:"Other archived chat",worktreeMode:"direct"}')" | jq -er '.reply.sessionId')
rpc rpc:session.archive "$(jq -nc --arg id "$other" '{sessionId:$id}')" | jq -e '.reply.success'
node "$verify/session-unarchive-web.mjs" "$out" "$desktop" "$phone"
