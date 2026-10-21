#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-home-read-sync.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) exit 2 ;; esac
[[ ! -e "$RUN" ]]
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cat > "$RUN/bin/git" <<'SH'
#!/bin/sh
for arg do
 if [ "$arg" = fetch ]; then printf 'pull\n' >> "$VERIFY_PULLS"; fi
done
exec /usr/bin/git "$@"
SH
chmod +x "$RUN/bin/git"
cd "$REPO"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
 TMPDIR="$RUN" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_WORKSPACE_PATH="$RUN" \
 GIT_CONFIG_GLOBAL="$RUN/gitconfig" GIT_CONFIG_NOSYSTEM=1 VERIFY_PULLS="$RUN/evidence/pulls" \
 bun .claude/skills/verify/neo-home-read-sync.ts "$RUN"
