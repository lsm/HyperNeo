### Neo home setup (journey 34)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-setup.ts <port> "$RUN"`.
The helper seeds only a synthetic git identity in the isolated HOME and a private
transcript, then invokes `neo.project.save` and `neo.home.init` over real RPC.
It expects one local bootstrap commit containing README, empty direction and
`.gitignore`; coordinator transcripts stay ignored. Repeating initialization and
renaming a project preserves HEAD and its assigned home path. The helper then
removes only its synthetic HEAD/index to force an identity failure: bootstrap
adopts nothing, the three files stay untracked, and configuring the identity
must make retry succeed with one empty root commit.
Evidence: `evidence/neo-home-setup.json`. Signing-failure recovery is checked with
an explicit false signer in focused unit tests, without real signing credentials.
This slice adds setup only; save/content checks and reads have later journeys.
It adds no command parser or native-tool hook policy. Filesystem/container limits
are the safety boundary. No provider, GitHub or GUI turn is part of this RPC check.

The `cleanup-failure` variant was removed: bootstrap no longer stages
pre-existing files, so a failed commit leaves nothing for reset cleanup to miss.

Repeat journey 34 on a fresh run with final argument `interrupted` to seed the
persisted state from interruption between add and commit: no HEAD and exactly
README.md, .gitignore and direction.md staged. The next real `neo.home.init` RPC
creates one empty root commit and leaves the staged bootstrap files in the index
for adoption through save. This simulates the disk state; it does not kill the
daemon. Existing file contents survive recovery.

Repeat journey 34 with final argument `ignore-repair` on another fresh run. The
helper removes only its fixture ignore in a local commit, leaving an existing
home with untracked coordinator transcripts. `neo.home.init` must repair the
ignore, preserve transcript contents, track no transcript and leave clean status.
Other dirty files still require human review.

Repeat journey 34 with final argument `ignore-repair-failure` to force a missing
identity during ignore repair. After configuring identity, retry must create the
repair commit and leave clean status, preserving private transcripts. The gate
checks the committed ignore; failed repair restores its prior ignore contents
(or removes only the newly created ignore), removing newly created bootstrap
documents after a failed repair. Focused contracts cover both absent
and existing ignore files.
