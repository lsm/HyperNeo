## Coding repositories require instance opt-in

Use the metadata-only isolated setup from SKILL.md (no model or HTTP mock), then:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-coding-watches-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/coding-watched-repos.ts "$RUN"
```

The helper boots the actual daemon on an ephemeral non-8399 port with its own
HOME, DB and data directory. GitHub is a local executable stub, not the machine's
login. It reads and writes the watch list through the human WebSocket operation
door and runs the real Coding sweep with synthetic external session facts.

`evidence/result.json` must show: empty watch list and zero GitHub calls for the
foreign session; after explicitly adding `chosen/repo`, exactly one GitHub call
for that repository and no foreign session facts; the choice survives restart;
a saved empty list survives another restart and makes no further GitHub calls.
It then prepares synthetic pre-upgrade state (a project watch with no watch-list
preference), checks one-time legacy seeding, adds a second project alias and
restarts to prove it is not enrolled. The helper stops all its resources in
`finally`. Aliases and
suppression of retained terminal/unowned notices are pinned by
`coding-watched-repos.test.ts`. The settings UI and owned-session automatic
addition are follow-up slices; this journey does not claim either surface.

Finally forget the synthetic legacy project through `neo.project.forget`: its
watch must be removed, another sweep must make no GitHub call, and restart must
keep the empty list. Unit contracts also pin refusal, shared repos, aliases,
disabled packs and atomic rollback if unwatch storage fails. Retained ledger
history is hidden from active reads, not deleted by forgetting a project.
