# Workers run without the OS sandbox unless the human turns it on

Settings > Workers > Worker sandbox has two modes, stored as `workerSandbox`:
`off` (default) and `always`. Adapter tests in
`hyperneo-verbs.test.ts` and `codex-desktop-start.test.ts` pin both modes; `claude-desktop-start.test.ts` pins that an
unsandboxed prepared start passes no `--settings` file.

Off: a prepared start writes no `.claude/settings.local.json` sandbox and Codex threads
start with `danger-full-access`. Prove the worker can then do real work by running the
HyperNeo-bundled Claude CLI against a loopback scripted model with no sandbox settings
(`worker-cli-probe.py <claude> <settings.json> <cwd> '<command>'`, settings `{}`), in a
fresh Git directory outside `/tmp`, with a throwaway `ssh-agent` key. The command signs a
commit (`git commit -S`, `gpg.format=ssh`, key `key::<pub>`), serves and fetches
`http://127.0.0.1:<port>/` with Python, and takes a headless Chrome screenshot. Expected:
`signed-commits=1`, `local-server served`, and an 800x600 PNG.

On: `worker-sandbox.ts` and `worker-native-writes.ts` set `workerSandbox: 'always'`
before `work.start`; their journeys keep the sandbox proofs (outside writes denied).
