## Codex Desktop repo project registration

Codex Desktop keeps its projects in app-server project storage (`projects` and
`project_roots` in `state_5.sqlite`); `local-projects` in
`.codex-global-state.json` stays empty on Desktop 26.1120. Desktop's own
`codex://threads/new?path=` entry also creates an app-server project. The driver
calls `project/list` and reuses the project whose root is the repo root, or calls
`project/create` with an idempotency key derived from that root, before assigning
the thread's `projectId`. It never opens Desktop or writes Desktop state. These
are experimental app-server methods, not a documented public project SDK; recheck
them after Codex upgrades.

Manual check (no unattended GUI): keep Desktop running, have the human ask Neo
for a new Codex task in a repo absent from Desktop projects, and observe that the
repo is added and the thread appears under it. Open the thread and confirm its first reply renders without a
restart. Start a second task in that repo: there must still be one project. Keep
the thread IDs, project root and the human's result as evidence.

The [staged opening helper](codex-desktop-opening-journey-human-operated-gui.md)
registers its workspace the same way during `prepare`. Project reuse, paging and
creation are covered with a fake app-server in CI. App-server evidence alone does
not verify that the thread appears under the project in Desktop's sidebar.
