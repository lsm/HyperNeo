# Operation pipeline RPC replies

Build the web bundle and run `bash .claude/skills/verify/remaining-operations.sh 9371` with Bun 1.4.2. The isolated daemon exercises connections, extensions, a refused human-merge request, project reorganization and a missing session over RPC. Run on the base and the change and compare the JSON replies; the missing-session error must match exactly. No provider or GitHub credentials are used. The synthetic URL is refused before any GitHub command is spawned.
