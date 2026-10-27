# A verify run chooses its own model-mock port

Build the web UI as shared SKILL.md requires, then run from the owned checkout:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/mock-port-launch.sh /absolute/fresh/evidence-directory
```

The helper selects two distinct OS-chosen loopback ports, releases their probes,
and passes VERIFY_MOCK_PORT to the real launch.sh. Preflight rejects a port
claimed in the meantime. The shared doctor must observe test mode, a database
inside the fresh run, served web UI, a real RPC response and a working model mock
at the selected port. No provider credentials or model turn are used. This
proves actual launch and port propagation, not generated model behavior.

An EXIT trap stops only the owned daemon and mock, saves logs and status, and
the shared with-run wrapper deletes their synthetic HOME/data on any outcome.
The refusing-process unit fixtures test nonnumeric, out-of-range, shared and
protected mock ports without ever binding those ports. Run the default/override
unit suite with VERIFY_MOCK_PORT exported too: its default fixture must remain
hermetic. Legacy upgrade helpers must never leave tracked web-dist symlinks.
