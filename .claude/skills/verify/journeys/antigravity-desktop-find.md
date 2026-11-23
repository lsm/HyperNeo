# Discover Antigravity Desktop conversations

Run the isolated daemon with pinned Bun and a fresh evidence directory:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/evidence \
  .claude/skills/verify/antigravity-desktop-find.ts
```

The adapter offers only discovery once a catalog appears. Verify that a local
desktop conversation appears once even when the CLI lists its ID, and that an
imported CLI copy with its own ID remains under the CLI adapter. The proof also
checks project paths, no-project conversations, ID and limit filters, and that
remote workspaces and child conversations stay out. The live fixture WAL must
remain unchanged.

For an attended check, create a disposable local conversation in the App and
look up its title in the App catalog. Read only the title and origin metadata.
The tested App writes an empty `source` and `app_data_dir` of `antigravity` for
that row. CLI rows in the same catalog carry `CORTEX_TRAJECTORY_SOURCE_CLI`.
Compare the corresponding ID returned by the CLI catalog without loading the
conversation. To verify through the isolated daemon, pass a file containing
only `title`, `source`, and `origin` (from `app_data_dir`) after the script path.
The fixture uses that metadata with synthetic IDs and paths. It must never use
the original database, transcript, or credentials.

Run the full CLI overlap proof where the synthetic executable is discoverable.
For an independent check of the desktop reader, pass `--desktop-only` after
the script path or metadata file.
