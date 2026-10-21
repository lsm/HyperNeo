### Neo home read (journey 36)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-read.ts <port> "$RUN"`.
The actual `neo.home.read` RPC must report an uninitialized home without creating
files. After explicit initialization, the helper seeds a human-edited direction
with a BOM, whitespace, non-BMP Unicode and 60,000 full lines. The entire text and
SHA-256 must match, without committing or changing that edit. Private/internal
paths and missing documents return typed refusals. Synthetic non-UTF-8 bytes must
be refused without returning replacement text or changing the source bytes.

Evidence: `evidence/neo-home-read.json` summarizes lengths, hashes and unchanged
HEAD/status; `neo-home-read-response.json` retains the full synthetic response.
Focused contracts cover project mandates, empty documents, ignored paths,
symlinks, caller ownership and serialization with save. This proves the local
RPC door, not a GUI or remote pull. It uses no provider/model, real credentials,
real DB or GitHub requests. H2 confirmation and H3 sync remain later slices.
Stop the isolated daemon and mock with `stop.sh`.
