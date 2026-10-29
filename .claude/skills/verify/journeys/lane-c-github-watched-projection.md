# Saved GitHub watched repository projection

Run proof-run.sh with lane-c-github-watched-projection.ts under Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data, scrubbed
environment, ephemeral listeners, evidence retention and synthetic data cleanup.

The unchanged watched-read journey imports the earlier settings and real Space
RPC fixture. Capture the actual listWatchedRepos and listConfig replies before
those helpers close every socket, processor and app. Compare complete saved
watched entries to public watched entries minus Space identity and cursor.
Both enabled and disabled snapshots must match, including timestamps and nulls;
four target main writes remain expected. Restore the request capture in finally.

Commit the missing-helper contracts first after this legacy public comparison
passes. Extract only the existing watched-entry callback into a pure function.
Unit and native checks also use a synthetic configured webhook to verify the
configured marker, empty/null secret behavior, private cursor omission and input
immutability. Never include private secret/cursor data in the saved projection.

Measure the complete helper plus existing saved-config caller, constructor-free
reader modules/wrappers, unchanged config setter, validators and SQL helper.
Pin the callback object AST and the entire extension AST restored with the old
callback. Other extension methods and all read/write dependencies stay unchanged.
Initialization, authorization, polling/hooks and full plugin/startup transitive
closure remain outside this extraction. No public off-main claim is made.
Save github-watched-projection.json and imported native fixture evidence. Native
helpers close resources before wrapper cleanup. Deployment smoke stays with Neo;
never touch live daemon/8399 or real credentials.
