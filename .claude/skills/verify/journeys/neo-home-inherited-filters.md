# Home Git filter isolation

Read shared SKILL.md setup first. Use a fresh isolated daemon and its owned HOME,
data directory and synthetic Git identity. No provider or model turn is needed.

After Launch, run:

```bash
bun .claude/skills/verify/neo-home-save.ts <port> "$RUN" inherited-filters
```

The helper commits a synthetic attributes policy, configures a local bare origin
and peer, then installs clean, smudge and process filter commands in the isolated
HOME's Git configuration. Each command would write a marker outside Neo's home;
the process command also fails its protocol handshake. Required filters are set
to true so disabling them must not jam a save or read.

The smudge and process cases also repeat with a conditional global include that
activates only in the temporary linked worktree. The daemon must snapshot the
effective global/system settings without filter drivers or include directives;
Git children must not reload a new conditional filter configuration.

Save must publish exact unfiltered bytes. Read must fetch peer progress and
return the exact file without running a filter during worktree creation, rebase
or merge. Inspect `evidence/neo-home-inherited-filters.json`: every result must be
successful, `executed` must be null and actual bytes must match expected bytes.
The helper restores its synthetic configuration in finally. Stop the owned
daemon and preserve evidence before removing its run, using shared setup.

Focused operation contracts also exercise system Git configuration. This journey
is daemon/RPC filter proof; it makes no claim about native SDK sandbox enforcement.

For a listener-free compatibility proof, run the shared `proof-run.sh` wrapper
with `.claude/skills/verify/neo-home-git-version.ts` and an absolute Git executable
as its final argument. Run once with supported Git and once with Git 2.31.1 built
in an owned cache from the upstream release. The helper creates a synthetic HOME,
identity, attributes file and a conditional smudge filter selected only in a
linked worktree. Supported Git must check out exact bytes without executing the
filter; old Git must refuse before checkout with a Git 2.32 minimum diagnostic.
Inspect `neo-home-git-version.json` and the log. This proves daemon command
configuration isolation, not the RPC or SDK sandbox surface.

The local-read operation contract also seeds a malformed inherited Git profile.
Tolerant Git probes must preserve local document access; required Git commands
must still fail rather than silently discard the profile.

Run the shared wrapper with `.claude/skills/verify/neo-home-config-drivers.ts`,
once under Bun and once under pinned Deno. This listener-free proof runs real
rebase and merge commands with custom drivers configured in global, system,
local and command scopes. Each unsafe driver would write outside the home.
Conflicts must still contain both versions and remain resolvable using Git's
builtin text merge, with no outside marker. Inherited external diff and textconv
commands must be absent, leaving ordinary diff output. Local diff settings remain
covered by the daemon's explicit no-ext-diff/no-textconv flags.

The same helper clones through inherited URL rewrites whose subsection names
contain quotes, backslashes and literal tabs, checking the exact document bytes.
Keep Git's required escaping for quotes/backslashes; subsection whitespace must
remain literal. Inspect `neo-home-config-drivers.json`. Operation contracts also
exercise the real conflict-question/answer/save path. This command proof does
not establish daemon RPC startup or native SDK sandbox enforcement.
