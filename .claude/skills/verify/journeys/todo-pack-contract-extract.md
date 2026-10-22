# Core-owned pack contract extraction

This Extract rung moves the existing contract from `neo/packs/types.ts` to
`neo/pack-contract.ts`; all declarations and runtime behavior remain unchanged.
The existing hooks and transitional session fields stay intact. This does not
claim the final `readFacts` / pure `judge` interfaces or the complete core/pack
import boundary are implemented.

From the worktree root, compare declarations with the merged Pin base:

```bash
python3 - <<'PY'
from pathlib import Path
import re, subprocess
old = subprocess.check_output(['git', 'show',
    '47f257a8bc1172cc2ee358c9651ba739798f8e0f:packages/daemon/src/lib/neo/packs/types.ts'], text=True)
new = Path('packages/daemon/src/lib/neo/pack-contract.ts').read_text()
def declarations(text):
    return re.sub(r'^import type .*?;\n', '', text, flags=re.M)
assert declarations(old) == declarations(new)
assert not Path('packages/daemon/src/lib/neo/packs/types.ts').exists()
print('PASS: every declaration unchanged; former pack-owned file absent')
PY
```

Follow `todo-facts-current-removal-pin.md` and shared SKILL.md isolation setup.
Run its actual test daemon journey in a fresh synthetic HOME/data directory with
`VERIFY_PIN_REMOVAL=1`. Observe MCP removal, RPC snapshots, worker reuse and daemon
restart; the complete report hash must remain identical and no removed work may
be redispatched. Retain metrics and disclose unavailable measurements. No GUI,
real HOME/database, credentials, model or port 8399. The helper stops its own
resources in finally. Existing unit suites run in CI only, with every assertion
unchanged. Before completion retain eligible exact-head review, green CI, manual
squash and deployed `hyperneo build` readback, then remove the worktree.
