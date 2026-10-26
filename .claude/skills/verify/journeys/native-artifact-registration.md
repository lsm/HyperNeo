# Local native todo artifact registration

Use the verify skill's metadata-only isolation rules: fresh HOME/data/DB,
NODE_ENV=test, no keys or provider turns, and no live daemon. Build the web first.

```bash
RUN=$(mktemp -d /private/tmp/native-artifact-registration-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test LOG_LEVEL=error \
  HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/native-artifact-register.ts "$RUN"
```

The helper owns an ephemeral loopback daemon and synthetic Codex state. It registers
markdown and PNG files through operation.invoke using the todo's recorded native
thread cwd, reads exact snapshot bytes and native producer metadata, checks retries,
accepts explicit non-sensitive files outside roots, denies foreign snapshot readers, and registers from Neo's own ask
workspace. It proves ownership again after the todo changes worker. It always
closes the daemon and WebSocket and retains evidence/native-registration.json.

It also holds an exclusive lock on a separate synthetic native state DB: snapshot
get/ref and multi-chunk reads still work, while changing the todo worker revokes
access immediately. A relative capture without cwd refuses promptly with ambiguous_context; an absolute
capture still succeeds while native state is locked. Cwd reads have zero busy wait. No long-lived cwd cache is used.

An optional third argument names a headless browser script receiving the owned
port and run directory; use it to open the todo's existing ArtifactCards preview.
Explicit non-sensitive paths need no project/evidence root approval. No sensitive
path exemptions apply; see attachment-paths.md for the current policy proof.
Relative paths require the adapter's authoritative working-directory reader.
Missing native cwd preserves the known ownership binding for absolute files.
Foreign callers are refused; unknown-context fallback is limited to the calling
session ID, and unsupported/remote ownership records remain unavailable.
