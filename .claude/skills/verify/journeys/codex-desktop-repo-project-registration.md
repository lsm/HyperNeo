## Codex Desktop repo project registration

The Desktop project cache is distinct from app-server project storage. Creating
an app-server project alone is not proof that it appears in Desktop. The driver
uses Desktop's own `codex://threads/new?path=<repo root>` create/select entry when
no registered project exists, then reads its saved local-project registration and
legacy-to-server ID mapping before assigning the thread's `projectId`. It never
writes Desktop state directly. These are installed Desktop integration contracts,
not a documented public project SDK; recheck them after Desktop upgrades.

Manual check (no unattended GUI): keep Desktop running, have the human ask Neo
for a new Codex task in a repo absent from Desktop projects, and observe that the
repo is added and the thread appears under it. Confirm any Desktop folder-consent
dialog by hand. Open the thread and confirm its first reply renders without a
restart. Start a second task in that repo: there must still be one project. Keep
the thread IDs, project root and the human's result as evidence.

For the staged opening helper below, create the workspace first with
`mkdir -p "$RUN/workspace"`, then manually open
`codex://threads/new?path=<RUN>/workspace` to register it before running `prepare`. The helper refuses to open the registration URL automatically;
retry preparation after the human registered the workspace. Native create/select
and delayed registration are covered with fake launcher/state fixtures in CI.
The existing app-server-only prototype evidence does not verify this GUI journey.
