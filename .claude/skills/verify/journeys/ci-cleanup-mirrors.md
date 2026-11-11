# CI cleanup sandbox dependencies survive mirror DNS failure

Follow SKILL.md for source ownership and evidence retention. The workflow's
cleanup sandbox steps use independently hosted HTTPS mirrors when the default
Ubuntu mirror cannot resolve. Both apt-get commands explicitly select the
fallback source list, which references mirror+file and the Ubuntu signing keyring.

Run `python3 scripts/test-cleanup-sandbox.py` on an authorized test host or CI.
The fixture executes both workflow steps with stubbed package commands and
isolated mirror files. It proves source selection and command order. Package
availability is proved by the signed APT rehearsal below.
A simulated DNS outage starts with a direct Ubuntu source URL. The script must
select its mirror+file source explicitly, request package policy before the
install command and preserve the namespace smoke command. The CI logs retain the selected candidate
and archive component on the runner itself.
Healthy DNS must retain the runner mirror configuration. The reproduction on the
old workflow fails both outage subcases. All fixture data is temporary.

On an Ubuntu test host, run the package rehearsal below with a fresh absolute
evidence directory. It uses separate APT sources, lists, cache and status files.
It verifies three InRelease signatures with the installed public Ubuntu keyring,
records the bubblewrap candidate and its archive component with apt-cache policy,
downloads bubblewrap, extracts it and executes its version command. All runtime
files are temporary. It changes no host APT configuration or installed packages.

```sh
bash .claude/skills/verify/ci-cleanup-mirrors.sh "$EVIDENCE"
```

Retain apt-update.log, signatures.log, policy.txt, download.log, package.txt and version.txt.
The actual runner's user-namespace smoke and full daemon suites remain CI gates.
