#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-home-sync-preserve.sh /private/tmp/fresh-run scenario reproduce-or-verify}
SCENARIO=${2:?scenario required}
EXPECTATION=${3:-verify}
case "$RUN" in /private/tmp/*) ;; *) exit 2 ;; esac
[[ ! -e "$RUN" ]]
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/bin"
cat > "$RUN/bin/git" <<'SH'
#!/bin/sh
if [ "$VERIFY_PUBLICATION_GATE" = 1 ]; then
 for arg do
  if [ "$arg" = merge ]; then
   : > "$VERIFY_READY"
   while [ ! -f "$VERIFY_RELEASE" ]; do sleep 0.02; done
  fi
 done
fi
exec /usr/bin/git "$@"
SH
chmod +x "$RUN/bin/git"
GATE=0
case "$SCENARIO" in publish-*) GATE=1 ;; esac
cd "$REPO"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
 NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" GIT_CONFIG_GLOBAL="$RUN/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
 VERIFY_PUBLICATION_GATE="$GATE" VERIFY_READY="$RUN/fetch-ready" VERIFY_RELEASE="$RUN/fetch-release" \
 bun .claude/skills/verify/neo-home-sync-preserve.ts "$RUN" "$SCENARIO" "$EXPECTATION"
