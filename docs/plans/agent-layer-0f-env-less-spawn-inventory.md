# Agent-layer 0f: env-less spawn inventory + isolation decision

Date: 2026-08-24.  Tree: `acb991e05` (`dev`).

This is the reviewable artifact for the 0f slice of the superpipe pilot (§8.1 of `docs/agent-layer-superpipe-pilot-proposal.md`).  It identifies every daemon process launch that currently inherits the live `process.env`, maps each to one of the three isolation treatments, and records the design decisions that 0g will mechanically apply.

## Context

The 0a–0e slices build or enroll the `provider-env-coordinator` and the QueryRunner/ACP/ProviderService readers so that `process.env` is no longer mutated while a session holds a lease.  The remaining risk is that **any child process launched without an explicit `env` option continues to inherit the live `process.env`**.  During a lease window that can include another session's API keys, tokens, or routing variables, so every such launch must be either enrolled in the coordinator, sanitized with an explicit allowlist, or moved to an immutable baseline snapshot.

## Method

A source sweep of `packages/daemon/src` for `node:child_process` and `Bun.spawn` calls was performed.  A call was marked *env-less* when its options object contained no `env:` property and the spawn implementation falls back to `process.env` (or when the env was built from `process.env` without an explicit allowlist).  Calls that already pass a constructed or allowlisted env are recorded as *already protected / verification only*.  The anchors below are current (`acb991e05`) line numbers.

## 1. Direct env-inheriting launches

| Source | Line(s) | Command / purpose | Current env handling | Decision | Notes |
|---|---|---|---|---|---|
| `packages/daemon/src/lib/runtime-spawn/bun-backend.ts` | 17 | `Bun.spawn(args, options \|\| {})` | `env` omitted ⇒ `process.env` inherited | **sanitize** | Root `spawnProcess` default.  The Bun backend must require an explicit `env` or default to a safe coordinator-supplied baseline instead of the live process. |
| `packages/daemon/src/lib/runtime-spawn/node-backend.ts` | 37 | `spawn(args[0], args.slice(1), { ... })` | `env: options?.env` ⇒ `process.env` inherited when `env` is absent | **sanitize** | Node `spawn` fallback is identical to the Bun case; the `SpawnFn` contract must not allow an undefined env to leak live `process.env`. |
| `packages/daemon/src/lib/space/runtime/workflow-executor.ts` | 33–37, 127–137 | `sh -c <user condition expression>` | `spawnProcess(args, { cwd, ... })` with no `env` | **sanitize** | Condition expressions are arbitrary shell and must not see session API keys.  Pass a restricted workflow baseline (PATH, HOME, TMPDIR, plus any keys the workflow explicitly declares). |
| `packages/daemon/src/lib/rpc-handlers/dialog-handlers.ts` | 22, 30, 37, 57, 70, 145 | `osascript`/`zenity`/`kdialog`/`powershell`/`which` | `Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' })` with no `env` | **sanitize** | The safe desktop baseline must include GUI-session variables (`DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XAUTHORITY` and their Windows analogs) so `zenity`/`kdialog` can connect, while still excluding provider credentials and routing variables. |
| `packages/daemon/src/lib/agent/sdk-cli-resolver.ts` | 205, 228, 382 | `curl` npm metadata, `curl` tarball, `which rg` | `execFileSync`/`execSync` with no `env` | **sanitize** | Network/proxy variables (HTTPS_PROXY, etc.) can be included from an immutable startup baseline, but not live session credentials. |
| `packages/daemon/src/lib/providers/anthropic-copilot/bun-node-wrapper.ts` | 13 | Bun `node:sqlite` probe | `execFileSync(process.execPath, ...)` with no `env` | **sanitize** | The probe needs no sensitive env; pass an empty or minimal baseline.  `buildCopilotEnv` must read PATH from the provider's immutable baseline, not live `process.env`. |
| `packages/daemon/src/lib/providers/anthropic-copilot/provider.ts` | 673 | `gh auth token` | `execFileAsync('gh', ['auth', 'token'], { timeout: 5000 })` with no `env` | **sanitize** | This must run with a GitHub allowlist built from the provider's constructor `env` / `credentialEnvBaseline`, not the live `process.env`. |
| `packages/daemon/src/lib/worktree-manager.ts` | 544 | `gh` JSON calls | `execFile('gh', args, { cwd, encoding, timeout, maxBuffer }, ...)` with no `env` | **sanitize** | Use the same `buildGitHubLookupEnv` allowlist the connectors already use, bound to the current owner's baseline. |
| `packages/daemon/src/lib/space/managers/space-worktree-manager.ts` | 62, 72, 79, 86, 101, 160, 172, 235, 250 | `git worktree` / `git branch` | `execFileSync('git', ...)` with no `env` (10 sites) | **sanitize** | Git needs PATH, HOME, USER, XDG_CONFIG_HOME, and `GIT_*` variables only.  A shared `buildGitCommandEnv` allowlist. |
| `packages/daemon/src/lib/space/artifact-git-ops.ts` | 35 | `git` diff / log / remote | `execFile('git', args, { cwd, encoding, timeout, maxBuffer }, ...)` with no `env` | **sanitize** | Same as space-worktree-manager; consolidate on a single `buildGitCommandEnv`. |
| `packages/daemon/src/lib/space/managers/space-manager.ts` | 275 | `git rev-parse --git-dir` | `execAsync('git ...', { cwd })` with no `env` | **sanitize** | Same `buildGitCommandEnv`. |
| `packages/daemon/src/lib/process-watchdog.ts` | 35, 41 | `ps` listing | `execFileAsync('ps', ...)` with no `env` | **sanitize** | `ps` needs PATH only (or an empty env with an absolute path). |
| `packages/daemon/src/lib/credential-discovery.ts` | 66 | `security find-generic-password` | `execSync('security ...')` with no `env` | **sanitize** | macOS Keychain call; minimal baseline.  This file also writes `process.env` (lines 48, 76, 92), which is an ambient-writer concern tracked under 0e. |
| `packages/daemon/src/lib/credentials/credential-store.ts` | 38, 73, 94, 152, 164, 416 | `security` CRUD and `security unlock-keychain` | `execFile` / `spawn` / `execFileAsync` with no `env` | **sanitize** | Keychain CLI calls need only PATH/HOME.  The `DatabaseCredentialStore` `ENCRYPTION_KEY_ENV` reader at 448–449 is an ambient reader handled under 0e. |

## 2. Spawner seams and default `spawnImpl`s

| Source | Line(s) | Purpose | Current env handling | Decision | Notes |
|---|---|---|---|---|---|
| `packages/daemon/src/lib/space/runtime/connectors/github-connector.ts` | 17 | `createGithubConnector(spawnImpl = spawnProcess)` | Default `spawnImpl` is the raw `spawnProcess`, but all call sites use `runGhJson` which passes `buildGitHubLookupEnv()` | **enroll / sanitize** | The default must either be enrolled in the coordinator or require an explicit env.  Because the connector is always invoked through `runGhJson`, the immediate fix is to keep `buildGitHubLookupEnv()` and verify every call path supplies it. |
| `packages/daemon/src/lib/space/runtime/connectors/presets.ts` | 18, 59, 77, 141, 160 | Validator factories default to `spawnProcess` | Same as github-connector; helpers pass `buildGitHubLookupEnv()` | **enroll / sanitize** | Same treatment: default `spawnImpl` must not be able to launch with live `process.env`. |
| `packages/daemon/src/lib/space/runtime/connectors/production.ts` | 23 | `registerProductionConnectors(spawnImpl = spawnProcess)` | Same as github-connector | **enroll / sanitize** | Same. |
| `packages/daemon/src/lib/space/runtime/built-in-validators/pr-ready-validator.ts` | 58, 116, 135, 188 | `spawnImpl` default and calls | `runTextCommand` and `runCommand` pass `buildGitHubLookupEnv()`; the `git config` call (279) also uses that allowlist | **sanitize** | Continue to pass an explicit allowlist.  The `git config` call does not need GH tokens, so a generic `buildCommandEnv` is cleaner, but the GitHub allowlist is safe. |
| `packages/daemon/src/lib/space/runtime/hook-executor.ts` | 302 | Hook script `bash -c` execution | `spawnProcess(args, { cwd, env: restrictedEnv, ... })` | **sanitize (source fix in 0g)** | Already the canonical `sanitize` pattern at the call site.  `buildHookRestrictedEnv` currently sources from `Object.entries(process.env)` and must be updated in 0g to use the active coordinator baseline or the hook context's immutable env. |

## 3. SDK-hosted spawns (indirect, via SDK `query` or ACP client)

| Source | Line(s) | Purpose | Current env handling | Decision | Notes |
|---|---|---|---|---|---|
| `packages/daemon/src/lib/github/security-agent.ts` | 162–193 | `query()` API key hand-off | Sets `process.env.ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` before `query()`, restores after | **sanitize** | SDK `query` accepts an `env` option.  Construct an explicit `env` from the agent's immutable key baseline plus a safe PATH/HOME baseline; do not mutate `process.env`. |
| `packages/daemon/src/lib/github/router-agent.ts` | 202–233 | `query()` API key hand-off | Same set/restore pattern | **sanitize** | Same treatment as security-agent. |
| `packages/daemon/src/lib/providers/anthropic-provider.ts` | 169–185 | `loadModelsFromSdk()` model discovery | `applyEnvVarsForSdk` sets/restores `process.env` around SDK `query`, which is called without `env` | **enroll / sanitize** | `anthropic.loadModelsFromSdk` is already a coordinator owner.  0g either wraps the call in `providerEnvCoordinator.runWithLease` or, preferably, passes explicit `env: buildSdkQueryEnv(this.env, envVars)` to SDK `query` and removes the `process.env` mutation. |

## 4. Already protected or verification-only paths

| Source | Line(s) | Purpose | Current env handling | Decision | Notes |
|---|---|---|---|---|---|
| `packages/daemon/src/lib/agent/query-runner.ts` | 42–53 | SDK `nodeSpawn` default | `env: opts.env` | **verify** | Already receives a constructed `options.env` through the provider stack.  0g adds verification rows, not code changes. |
| `packages/daemon/src/lib/acp/acp-transport.ts` | 88 | ACP process spawn | `env: buildAcpProcessEnv(env, replaceEnv)` | **verify** | Already explicit.  When `replaceEnv` is `true` and a constructed `env` is passed, no live `process.env` is inherited. |
| `packages/daemon/src/lib/acp/acp-query-runner.ts` | 622–633 | ACP client construction | `env: acpEnv` (no `replaceEnv` set) | **verify** | `acpEnv` is built inside the ACP enrollment (0c).  With `replaceEnv` defaulting to `false` it merges with `process.env`, which is safe because the merge is inside the lease.  0g adds a verification row. |
| `packages/daemon/src/lib/acp/acp-provider.ts` | 28–34 | ACP command probe | `env: buildAcpSafeEnv()` with `replaceEnv: true` | **verify** | Already fully sanitized. |
| `packages/daemon/src/lib/acp/acp-model-fetcher.ts` | 65 | `fetchAcpModels` | `env: buildAcpDiscoveryEnv()` with `replaceEnv: true` | **verify** | Already fully sanitized. |
| `packages/daemon/src/lib/space/runtime/gh-lookup-helpers.ts` | 114, 160 | `gh` API calls | `env: buildGitHubLookupEnv()` | **verify** | Already the canonical sanitized GitHub allowlist. |

### One verification gap

`packages/daemon/src/lib/acp/acp-model-fetcher.ts:27` (`disposeAcpSessions`) constructs `new AcpClient({ command, args, cwd, ... })` **without** `env` or `replaceEnv`, causing the ACP transport to fall back to cloning the live `process.env`.  0g adds an `env` parameter to `disposeAcpSessions` and passes a credential-bearing immutable environment associated with the ACP provider/session (e.g., the same `acpEnv` that launched the session), with `replaceEnv: true`; `buildAcpSafeEnv()` by itself is insufficient because it strips the credentials `initialize()`/`authenticate()` need.

## 5. Cross-referenced ambient env writers and readers (not launches, but they feed launches)

These are not spawns, but they explain why live `process.env` is dangerous.  They are tracked in the parallel 0a–0e slices, not fixed by 0f/0g.

| Source | Line(s) | Behavior | Treatment (pre-decided) |
|---|---|---|---|
| `packages/daemon/src/lib/credential-discovery.ts` | 48, 76, 92 | Writes credentials into `process.env` | Enroll in provider-env coordinator (0e scope) |
| `packages/daemon/src/lib/github/security-agent.ts` | 162–193 | Mutates `process.env` around SDK call | Remove by using SDK `env` option (this doc) |
| `packages/daemon/src/lib/github/router-agent.ts` | 202–233 | Mutates `process.env` around SDK call | Remove by using SDK `env` option (this doc) |
| `packages/daemon/src/lib/credentials/credential-store.ts` | 448–449 | Reads `process.env[ENCRYPTION_KEY_ENV]` | Move to immutable baseline (0e scope) |
| `packages/daemon/src/lib/providers/anthropic-provider.ts` | 342–370 | `applyEnvVarsForSdk` sets/restores `process.env` around SDK `query` | Pass explicit `env` to SDK `query` and remove `process.env` mutation (0g) |

## Decision

1. **Default rule:** every new process launch in the daemon must receive an explicit `env`.  The `runtime-spawn` `SpawnFn` contract will be updated so that an omitted `env` does **not** fall back to live `process.env`.  If the caller propagates a valid `provider-env-coordinator` lease token, the fallback is the coordinator-managed baseline for that token; otherwise the fallback is the immutable startup baseline.  This makes the root spawn implementation **sanitize-by-default** and prevents a background task from accidentally inheriting another session's active lease.

2. **Sanitize** is the preferred treatment for the bulk of the sites: `git`, `gh`, `security`, `ps`, `curl`, `which`, `osascript`/`zenity`/`kdialog`/`powershell`, the bun-node-sqlite probe, user condition expressions, and the GitHub CLI token reader.  Each gets a small, purpose-built allowlist derived from the current owner's immutable baseline (or the coordinator's active lease for session-owned calls).  No site in this inventory is allowed to pass the full live `process.env` to a child.

3. **Enroll** is used only for the `runtime-spawn` / connector `spawnImpl` seam so that session-owned code paths can continue to receive the coordinator-managed env.  Enrolled sites still pass an explicit `env`; they do not inherit `process.env`.

4. **Immutable baseline** is the rule for all credential and API-key reads.  Providers, agents, and credential readers must capture the env they need at construction (or per-owner initialization) and stop reading `process.env` after that point.  The Copilot provider's `credentialEnvBaseline` is the existing pattern; the GitHub router/security agents and the bun-node-wrapper should adopt it.

5. **0g mechanical application** will: (a) add `env` to every call in §1 using the appropriate `build*Env` helper; (b) update `runtime-spawn` to require a propagated lease token before using the active coordinator baseline, and otherwise fall back to the immutable startup baseline; (c) fix `acp-model-fetcher.ts:27` with an explicit credential-bearing ACP env (not just `buildAcpSafeEnv`); (d) add verification rows for the already-protected paths in §4; (e) remove the `process.env` set/restore blocks in the GitHub agents and `anthropic-provider.ts:169-185` by using the SDK `env` option; (f) update `hook-executor.ts:153-191` (`buildHookRestrictedEnv`) to source from the active coordinator baseline or hook context rather than live `process.env`.

This decision makes the daemon's child processes independent of the live `process.env` mutation window, closing the cross-session credential-leak path described in §8.1.
