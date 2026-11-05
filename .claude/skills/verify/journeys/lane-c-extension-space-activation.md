# Activate the Space extension configuration setter

Use shared isolation/resource setup in `../SKILL.md` and run
`lane-c-extension-space-activation.ts` through `proof-run.sh` under Bun. It owns a fresh
HOME/data, ephemeral daemon, refusing GitHub/HTTP stub and a synthetic Space/watch with no
remote webhook ownership. No provider, real credential or live daemon/8399 is used. Stop
its processors and finish startup body copying before measuring.

Drive the real `space.github.unwatchRepo` RPC. Self-check cached/new main config
UPSERT traps; baseline fails at that UPSERT. After the setter is wired, deny all
target main INSERT executions, read back `space.github.listConfig`, and retain
JSON/compound-key/creation-time/caller-clock behavior. Notifications and RPC
acknowledgement follow the writer commit. An AFTER UPDATE fault rolls back the
config row; the earlier unwatch row removal is already committed and stays so.
The activation does not add atomicity across that existing caller chain.

Acquire the competing WAL writer inside the fixture's target command-post hook,
AFTER the existing main-side removal has completed; acquiring it before unwatch
would block that unported mutation on main and test a different boundary.
While the config writer waits, readback retains its prior snapshot, notification
and acknowledgement stay pending, and health responds. Release after 1.2 s;
commit keeps the captured pre-admission timestamp. This deliberate write wait
does not meet the 250 ms affected-RPC target.

Refuse admission and drop an actual committed reply. Each rejects the public
RPC without config fallback, notification or automatic replay; the lost reply's
committed row is visible through later public reads. The known upstream removal
is still committed in both cases. Missing-parent FK and unit validation/clock
contracts remain. Preserve metrics, wrapper status and JSON before cleanup.

Count complete owned Space-store constructor/DDL/read/mapping/validation units,
record helpers, and the unchanged full command/SQL helper, plus import/smoke.
The unchanged JSON parser body is now in its constructor-free shared module
under the separate #9663 read extraction; the Space reader still uses it on main.
The external GitHub RPC/caller, framework and app roots are pinned unchanged,
not a full public/plugin/runtime transitive audit, as with global activation.
Constructor DDL, reads and upstream GitHub mutations remain on main. No new
shared/core edit or audited-data exclusion; final #8714 remains incomplete.
