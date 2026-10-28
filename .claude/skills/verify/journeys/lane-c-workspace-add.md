# Activate workspace.add history writes

Run proof-run.sh with lane-c-workspace-add.ts on Bun and native cached Deno
(VERIFY_PROOF_RUNTIME=deno). The shared wrapper checks resources, scrubs the
environment, creates fresh HOME/data and ephemeral listeners, saves evidence and
removes owned data. No model, provider, live daemon, credentials or MCP process
is used. The synthetic MCP command is imported disabled and never executed.

Before the fix require real workspace.add to fail because INSERT reaches main.
Self-check cached/new SQL guards, then refuse history INSERT and single-path
receipt SELECT only on the main connection. After wiring require pass=true,
publicWorkspaceAddExercised=true and mainSqlAttempts=0. Observe the real history
RPC and MCP registry/default readback: the history row commits before the scan,
the imported server and canonical default remain disabled, and change notice
follows import persistence. Repeated/concurrent adds increment once each; quoted
Unicode and normalized paths remain literal. Malformed imports retain the old
catalog, scan exceptions retain history success, failed history writes never scan.

Hold a competing writer for 1.2 seconds: add remains pending and does not scan,
health stays responsive, and the committed row keeps the pre-wait timestamp. This
deliberate lock wait is not a sub-250-ms write pass. Reject before post and lose a
committed reply: the caller keeps the error and neither replays nor scans; only a
later independent request increments again. Invalid directories never admit.

Unit contracts additionally enrich/change history during the scan and require
the post-refresh response, not the earlier writer receipt. Pin exact full-file
hashes and contracts in evidence/lane-c-workspace-add/audited-dependencies.json.
Those are known dependency roots, not an exhaustive transitive graph audit; the
manifest states the missing measurement explicitly. Run the measurement and strict
checker plus workspace, MCP importer and default-transition suites. Save timings,
RSS/WAL and worker payload sizes without raw workspace paths. Close sockets, locks,
processors and app before cleanup. Main-side history/MCP reads, browser layout and
Neo-owned deployment smoke remain unverified by this write slice.
