#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../packages/web/src"
space='(components/space/|space-store|islands/Space|hooks/useSpaceTask|hooks/useResolvedSpaceTask|lib/space-|/space/)'
owned='^(components/space/|islands/Space|hooks/useSpaceTask|hooks/useResolvedSpaceTask|hooks/__tests__/useResolvedSpaceTask|lib/space-|lib/__tests__/space-|islands/__tests__/Space)'
allowed='^(client\.tsx|.*__tests__/.*)$'
offenders=$(grep -rlE "from ['\"][^'\"]*$space|import\(['\"][^'\"]*$space" --include='*.ts' --include='*.tsx' . | sed 's#^\./##' | grep -vE "$owned" | grep -vE "$allowed" || true)
if [[ -n "$offenders" ]]; then echo "FAIL: shell files import Space directly:"; echo "$offenders"; exit 1; fi
echo "PASS: only client.tsx registers Space; no other shell file imports a Space module"
