#!/usr/bin/env bash
set -euo pipefail
BIN=${1:?compiled daemon binary required}
CLI=${2:?fixture Claude binary required}
RUN=${3:?fresh absolute run directory required}
PORT=${4:-9413}
MODE=${5:-npm}
case "$RUN" in /*) ;; *) exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 ]]
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/package"
cp "$CLI" "$RUN/package/claude"
tar -czf "$RUN/fixture.tgz" -C "$RUN" package
cat > "$RUN/bin/npm" <<SCRIPT
#!/bin/sh
printf '%s\n' "\$@" > "$RUN/npm-args"
/bin/cp "$RUN/fixture.tgz" "\$4/fixture.tgz"
printf '%s\n' "\$4/fixture.tgz"
SCRIPT
cat > "$RUN/bin/curl" <<'SCRIPT'
#!/bin/sh
exit 7
SCRIPT
if [[ "$MODE" == npm-failure || "$MODE" == npm-network ]]; then
  cat > "$RUN/bin/npm" <<SCRIPT
#!/bin/sh
printf '%s\n' "\$@" > "$RUN/npm-args"
printf 'npm error code ECONNRESET\nprivate-token-example' >&2
exit 7
SCRIPT
  cat > "$RUN/bin/pnpm" <<SCRIPT
#!/bin/sh
printf called > "$RUN/pnpm-called"
exit 1
SCRIPT
  cat > "$RUN/bin/curl" <<SCRIPT
#!/bin/sh
printf called > "$RUN/curl-called"
exit 1
SCRIPT
  chmod +x "$RUN/bin/pnpm"
fi
if [[ "$MODE" == pnpm-failure ]]; then
  rm "$RUN/bin/npm"
  INTEGRITY=$(openssl dgst -sha512 -binary "$RUN/fixture.tgz" | openssl base64 -A)
  cat > "$RUN/bin/pnpm" <<SCRIPT
#!/bin/sh
printf called > "$RUN/pnpm-called"
exit 1
SCRIPT
  cat > "$RUN/bin/curl" <<SCRIPT
#!/bin/sh
printf called > "$RUN/curl-called"
case "\$*" in
  *-fL*) while [ "\$1" != '-o' ]; do shift; done; /bin/cp "$RUN/fixture.tgz" "\$2" ;;
  *) printf '%s' '{"dist":{"tarball":"https://registry.example.test/fixture.tgz","integrity":"sha512-$INTEGRITY"}}' ;;
esac
SCRIPT
  chmod +x "$RUN/bin/pnpm"
else
  chmod +x "$RUN/bin/npm"
fi
chmod +x "$RUN/bin/curl"
env -i HOME="$RUN/home" PATH="$RUN/bin:/usr/bin:/bin:/usr/sbin" TMPDIR="$RUN" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" "$BIN" --port "$PORT" --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  if grep -qE '\[SDK\] Claude Code binary (ready|unavailable)' "$RUN/daemon.log"; then break; fi
  kill -0 "$PID" || break
  sleep 0.25
done
if [[ -f "$RUN/npm-args" ]]; then count=$(wc -l < "$RUN/npm-args" | tr -d ' '); else count=0; fi
printf 'npm argument count: %s\n' "$count"
if [[ "$MODE" == npm-failure || "$MODE" == npm-network ]]; then
  grep -q 'npm could not download the package (exit 7) (ECONNRESET); check your npm registry and login' "$RUN/daemon.log"
  ! grep -q 'private-token-example' "$RUN/daemon.log"
  [[ "$count" -eq 4 && ! -e "$RUN/pnpm-called" && ! -e "$RUN/curl-called" ]]
  echo 'PASS: npm failure was reported without fallback or stderr'
elif [[ "$MODE" == pnpm-failure ]]; then
  grep -q '\[SDK\] Claude Code binary ready:' "$RUN/daemon.log"
  [[ -e "$RUN/pnpm-called" && -e "$RUN/curl-called" ]]
  echo 'PASS: daemon downloaded the SDK after pnpm failed'
elif grep -q '\[SDK\] Claude Code binary ready:' "$RUN/daemon.log" && [[ "$count" -eq 4 ]]; then
  echo 'PASS: daemon downloaded the SDK through fake npm'
else
  echo 'FAIL: daemon did not download the SDK through fake npm'
  exit 1
fi
