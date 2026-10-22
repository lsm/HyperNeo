# Credentials: use without disclosure

Status: proposal, 2026-10-21; requires the human's approval through Neo before merge.
This page changes no runtime, credential, device setting or enforcement flag.

## Contract and threat model

Codex, Claude and Neo may request useful authenticated work, but never receive a
credential value in model input, tool output, logs, transcripts or artifacts.
A prompt-injected session is an adversary: it can run arbitrary code, edit its
workspace, call tools directly, forge request fields and send network traffic.
Instructions, token masking, command-line parsing and a shell wrapper are not
security boundaries. Never enforce safety by parsing command lines.

Trusted components are the human's approval UI, the OS isolation mechanism, the
credential broker and its reviewed adapters. The upstream service necessarily
receives authentication. Host administrator/root compromise and compromise of
that trusted implementation are outside this guarantee. A provider can also
return sensitive business data: credential non-disclosure does not by itself
authorize reading or exporting all account data.

An unrestricted AI process running as the human's Mac user cannot meet this
contract: it can read user-owned files, ask accessible Keychain helpers, inspect
inherited state or control other privileged tools. This includes external desktop
sessions, not only HyperNeo's children. Until those sessions are isolated, show
"legacy access: credentials may be readable", never "use-only". Do not silently
downgrade from isolated execution when an integration cannot run there.

## Read-only inventory on this Mac

Observed against dev `3f2acd9840342bde659d54a72ba1b479084df8bf`, 2026-10-21.
Local observations were path existence/mode, executable discovery, configuration
key names, environment **names**, CLI help and Keychain search-list paths only.
No credential/config payload, Keychain item, live DB row, process environment
value or shell startup file was read. No auth-status/token command was run.
Presence does not prove a working login, active backend or effective scope.

| Surface | Observed or implemented route; what remains unknown | Broker use without returning the value |
| --- | --- | --- |
| GitHub | `gh` installed; `~/.config/gh/{hosts,config}.yml` exist, mode 0600. Git config has credential helper keys for GitHub/Gist plus a system helper. Their values and the active gh storage backend were not inspected. | GitHub API adapter; optional trusted gh worker. Never expose arbitrary gh commands or credential-helper stdout to a session. |
| Woodpecker | `woodpecker-cli` 3.19.0; `~/Library/Application Support/woodpecker/contexts.json` exists, mode 0600. Its documentation puts tokens in the OS keyring, selected by server URL. Local item existence was not queried. `WOODPECKER_TOKEN`/`--token` can override it; neither was present as an environment name here. | Broker owns keyring access and implements pipeline/repo operations. No token flag in argv; no raw build logs by default. |
| Kubernetes | `kubectl` and `~/.kube/config` (0600) exist; no `KUBECONFIG` name in this process. Embedded token, certificate/key, external file and exec-plugin auth are possible; local kind/context/cluster was not inspected. | Broker-owned Kubernetes client with namespace/RBAC/action scope. Approved exec plugins run only in the trusted worker; their credential stdout stays there. |
| Registry/package tools | `docker`, `~/.docker/config.json` and `~/.npmrc` exist (files 0600). Helper versus inline auth and registry/account names are unknown. | Registry/package adapter; a trusted worker may use a helper or private stdin pipe. No host Docker socket or arbitrary build/run command is given to the session. |
| Cloud/other APIs | No aws/gcloud executable found on PATH; default AWS config/credentials and Google application-default-credential file absent at checked paths. Named env credentials include Cloudflare, Tailscale, trading/service and model APIs. Other paths and login methods were not searched. | Service-specific requests with fixed destination/account/resource scope; prefer short-lived upstream credentials held solely by broker. |
| Keychain/secret managers | User login Keychain search-list path exists; 1Password app and support/config directories exist. No `op`, `bw`, or `vault` CLI on PATH. This does not establish which items or integrations are used. | Reuse an approved Keychain/1Password backend, accessible only by the broker's identity; do not build a second general password vault. |
| Desktop/session auth | `~/.codex/auth.json` and `~/.claude/settings.json` exist (0600); default Claude credentials JSON absent. `SSH_AUTH_SOCK` name is present. No auth file, SSH key, agent key list or socket was queried. | Provider transport and signing operations stay in trusted processes. An SSH agent avoids exporting private keys, but unrestricted signing/socket access is still an excessive capability. |

Environment-name examples observed in the executing session: `COPILOT_GITHUB_TOKEN`,
`GH_REFRESH_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`TAILSCALE_CLIENT_SECRET`, `WOODPECKER_AGENT_TOKEN`, `WOODPECKER_GITHUB_SECRET`,
`ARGO_GH_CLIENT_SECRET`, `DEEPGRAM_API_KEY`, `EXA_API_KEY`, `GLM_API_KEY`,
`DEEPSEEK_API_KEY`, `KIMI_API_KEY`, `MINIMAX_API_KEY`, `OLLAMA_API_KEY`,
`OPENCODE_API_KEY`, `GMI_API_KEY`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`.
These are names, not evidence of validity, origin, or that a similarly named tool
uses them. In particular Woodpecker agent/OAuth-app credentials are not the CLI
user token. Shell/launchd/IDE injection origin remains unverified to avoid opening
files that may contain values. No credentials were copied for this inventory.

## What HyperNeo already partially solves

Source inspection, not a read of live credential rows:

| Existing mechanism | Reuse and limit |
| --- | --- |
| [Credential discovery](../../packages/daemon/src/lib/credential-discovery.ts) | Reads env, Claude credentials JSON, Keychain `Claude Code-credentials`, and settings env; writes discovered values into daemon env. Discovery is not isolation. |
| [CredentialStore](../../packages/daemon/src/lib/credentials/credential-store.ts) and [manager](../../packages/daemon/src/lib/credentials/provider-credential-manager.ts) | Live macOS uses `neokai.provider.*` Keychain services; encrypted `provider_credentials` is the fallback/test backend (AES-GCM, env or local key file). Same-user access to DB plus key defeats at-rest secrecy. Current Keychain setter puts data in child argv; replace behind the boundary, not a claim of safe injection. |
| [GitHub events](../../packages/daemon/src/lib/external-events/github/github-event-extension.ts) | Uses `neokai.external-events.github`/`default` credential store or environment token for daemon-side HTTP calls. This is an existing use-without-return pattern to reuse, not a generic credential broker. |
| [S5 table](../../packages/daemon/src/storage/schema/m437-remote-daemon-secrets.ts) and [repository](../../packages/daemon/src/storage/repositories/remote-daemon-secret-repository.ts) | `remote_daemon_secrets` stores reusable peer credentials in a TEXT column. Settings omission is not encryption or same-user protection. Keep this DB outside agent mounts; future migration needs its own preservation/upgrade proof. |
| [Pairing table](../../packages/daemon/src/storage/schema/m435-device-pairing.ts) | `paired_devices.secret_hash` authenticates incoming devices; pairing-code hashes are not reusable upstream credentials. Do not combine these trust domains. |
| [Provider env coordinator](../../packages/daemon/src/lib/providers/provider-env-coordinator.ts) | Serializes provider-env ownership; prevents cross-session races, not disclosure to arbitrary child code. |
| [SDK sandbox settings](../../packages/shared/src/types/settings.ts), [flag handoff](../../packages/daemon/src/lib/agent/flag-settings-file.ts), [Codex adapter](../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts) | Existing SDK sandbox configuration is reusable where it enforces the complete boundary. Source defaults are off with a Git exclusion; Codex start requests use danger-full-access. Live overrides were not read. A sandbox switch alone does not prove all native/MCP tools are confined. |
| [Query env](../../packages/daemon/src/lib/agent/query-options-builder.ts), [ACP env](../../packages/daemon/src/lib/acp/acp-transport.ts), [GitHub env](../../packages/daemon/src/lib/github/gh-lookup-helpers.ts) | Main query builder starts from filtered ambient env and overlays configured values; ACP defaults to inherited env unless replaced; GitHub helpers forward auth env and config location. Existing allowlists/coordination and [env-spawn inventory](../plans/agent-layer-0f-env-less-spawn-inventory.md) are useful foundations, not the completed boundary. |

No new live secret catalog was enumerated. Other embedded webhook/connector
secrets and backups need inclusion in a future human-run migration inventory;
never dump arbitrary settings/config JSON to discover them.

## Proposed boundary

Run model-directed tools in an isolated VM/container or separately confined OS
identity, with an explicit workspace mount and credential-free HOME/environment.
No human HOME, Keychain/1Password IPC, daemon DB/key files, SSH agent, host Docker
socket, debugger/process-control access, host exec service or session-door socket
is reachable. Restrict host/loopback access as well as filesystem/process access;
otherwise a helper, browser CDP or local service can bypass the broker.
Isolation must cover Codex/Claude desktop tool execution and Neo workers before
claiming this guarantee across all three. A chmod change under the same UID is
insufficient. Protected mode refuses launch with any alternative host shell,
file tool, MCP executor or host-control integration still attached. Validate the
actual Mac/container escape surfaces before rollout.

A separate broker identity owns credential access and trusted network workers;
the normal session daemon routes requests without owning reusable values. The
model transport also stays trusted: never inject a provider key into an SDK/ACP
process whose model-directed shell can inspect that environment. Use a scoped
model-request transport, or keep the provider client outside the tool sandbox.
Unsupported external engines remain explicitly legacy until this is possible.

The broker accepts typed operations, not a command string, arbitrary URL, generic
HTTP CONNECT proxy, arbitrary SQL/GraphQL, filesystem path or plugin executable.
It constructs requests from reviewed adapters and human-approved service aliases.
Validate TLS/service identity, resolved destinations and redirects; never forward
authentication across hosts. Ignore agent-supplied auth headers, proxy variables,
helper config and executable paths. There is no TLS interception of the human's
browser and no collection of website passwords; the [life-admin design](neo-life-admin-pack.md)
keeps its browser-consent approach.

Helpers/stdin/env injection are usable **inside trusted workers only**. A Git or
Docker helper and a Kubernetes exec plugin intentionally return credentials to
their caller; `op run` and CLI env injection make them readable to the child.
A private stdin pipe avoids history/argv, but cannot make an arbitrary recipient
safe. Broker-owned CLI workers use pinned executables, a clean private config and
no workspace hooks/plugins or arbitrary scripts. Prefer service APIs; Git network
transfers must not load repository hooks/filters or accept alternate remotes.

## Request, human approval and scoping

Proposed operations (names provisional): `credential.use.request` submits an
alias, typed action, resources, purpose, request ID and canonical payload digest.
The authenticated transport supplies session identity; ignore a body-supplied
session ID. A trusted supervisor binds the sandbox connection to its session.
Return an approval reference or a safe result, never an upstream credential.

Only a genuinely paired human UI may approve a request or standing grant. Show
service/account label, exact resources/action, writes and outbound data summary,
payload digest, expiry, maximum uses and requesting session. Approval is a durable
server-validated human decision, not a chat claim or a model's "yes". Any changed
payload/scope needs approval again. Default to one action; standing grants are
explicit, bounded and revocable. Bind grants to session, daemon, adapter version,
credential generation and action/resource set. Examples: GitHub PR reads in one
repo; rerun one Woodpecker pipeline; get deployment status in one namespace;
push one approved image digest to one registry repository. Kubernetes Secrets,
pod exec, registry admin, cloud IAM/key export and arbitrary CI logs are not
included by these grants. Each needs its own reviewed exposure policy.

Grant IDs visible to the model are references, not bearer authority. A stolen ID
does not work from a different sandbox/session; enforce this at the broker using
supervisor-authenticated connection identity. Re-check expiry/revocation and
reserve use-count atomically immediately before dispatch. Retry/idempotency keys
are scoped to session + action + canonical request; ambiguous writes return a
receipt needing reconciliation, not an automatic second write.

[Device pairing](daemon-security.md) authenticates the human/daemon/relay, not an
AI's authority to use every credential. Relays cannot approve or use grants; peer
daemons need an explicit delegated resource grant, never an upstream secret.
The current owner session door and lost-phone reset are accessible to local AI
shells by the human's accepted risk. Therefore reset/bootstrap cannot mint broker
approval authority: pin the broker approver separately and require human OS
confirmation/re-enrolment outside the agent boundary after a reset. S8/S9 remain
on their existing human holds; report-only device identity alone is insufficient
to enable these grants. No new device kind is needed for AI sessions.

## Outputs, audit, revocation and rotation

Return schema-allowlisted result fields and opaque receipts, never raw HTTP/CLI
headers, debug traces, environment, config, credential hashes or raw error bodies.
Only adapters with reviewed safe output contracts may ship. Upstream echo errors,
redirects, auth-test endpoints, credential resources and secret-bearing logs must
not become an export path. Opaque blobs and arbitrary text are denied by default;
redaction is defense in depth, not a proof that arbitrary output is safe.
Unknown output fails closed with a sanitized code and receipt.

Append audit events for request/approval/denial/dispatch/outcome/revoke/rotate:
time, actor/session/device, alias, grant, action/resource labels, request digest,
adapter/generation, safe status and receipt. Never log request payloads, responses,
tokens, credential fingerprints, command argv/env or private pipe content.
Audit failure before dispatch refuses the use; record an outcome durably after
dispatch without resubmitting ambiguous work. Bound metadata size and protect
the append-only audit outside session mounts. Human-only Settings shows usage
and can revoke a session grant, alias or all grants; do not delete audit/history.

Human import/login and rotation use a trusted UI/private channel, never a prompt
or transcript. Rotation creates a new credential generation and invalidates old
grants; revoke upstream credentials and cancel pending work where possible.
In-flight external effects cannot be undone by local revocation: record them and
reconcile receipts. Short upstream lifetimes reduce residual exposure. Existing
copies in env/files/old backups remain a migration concern: the human rotates
exposed credentials; this work never silently deletes their stored data.

## Small implementation slices, after human design approval

Each slice targets fresh dev, one issue/PR, normally 100–200 changed production
lines (hard cap ~300); split further by measured diff. Contracts/failing tests
precede wiring. No slice advertises global protection before isolation is proven.
C1–C7 proofs are prerequisites for enabling real use-only access on an engine;
earlier adapter demos use synthetic credentials only. Every later service must
pass the same boundary and output tests before its real credential is enabled.

| Slice | Deliverable and proof |
| --- | --- |
| C1 | Pin current env/helper/operation behavior using synthetic canaries only; define catalog/status schemas with no value-returning API. |
| C2 | Build authenticated session-channel binding, durable scoped grants and revocation; replay, forged-session, expiry and concurrent-use contracts. No credential dispatch yet. |
| C3 | Build separate broker worker and backend interface using synthetic credentials; safe audit/output receipts, no credential-bearing argv. Prove crash/retry boundaries. |
| C4 | Isolate one HyperNeo worker on Mac with no secrets/host bypass; prove FS/env/IPC/process/network refusal through its actual tools. No live keys until passed. |
| C5 | Wire one GitHub read adapter to that worker; human approval, cross-session denial, adversarial error/redirect/output and revocation proof. |
| C6 | Add human grants/import/rotation UI through paired human identity; prove agent reset/bootstrap cannot self-approve. Split UI and persistence if needed. |
| C7 | Isolate Codex and Claude tool execution and provider transport individually; show legacy versus protected status honestly for each engine. |
| C8 | Woodpecker read then approved rerun as separate PRs; long-job receipts and unsafe-log refusal. |
| C9 | Kubernetes, registry and each cloud adapter as separate scoped PRs, upstream RBAC plus safe-output proofs; no generic unrestricted proxy. |
| C10 | Human-assisted inventory/rotation of legacy copies, external-helper removal only after compatibility proof; never trim stored data. |

Before each runtime feature ships, add its own journey under
`.claude/skills/verify/journeys/` and follow the shared verify setup. An isolated
test daemon with synthetic HOME/DB and fake upstream checks actual tool results:
approved use succeeds; direct file/env/helper/socket/process access cannot recover
the canary; malicious echo/redirect/log output never reaches the model, artifacts
or logs; another session and a revoked grant fail. Also test restart, rotation,
concurrent requests and uncertain writes. Never use port 8399 or real credentials.
Those are future acceptance tests, not claims that this docs-only PR implements
or proves isolation. This proposal is verified by source/metadata cross-checks
and review of the published document; no live runtime change needs a new journey.

## Interface references

- [GitHub CLI auth](https://cli.github.com/manual/gh_auth_login): system credential store, plaintext fallback and stdin/env alternatives.
- [Woodpecker 3.19 CLI](https://woodpecker-ci.org/docs/cli): context metadata, OS keyring and override precedence.
- [Kubernetes credential plugins](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins): exec credentials are returned to the client.
- [Docker login](https://docs.docker.com/reference/cli/docker/login/): credential helpers, inline fallback and password stdin.
- [Git credential helpers](https://git-scm.com/docs/gitcredentials): helpers return credential attributes on stdout.
- [1Password subprocess injection](https://developer.1password.com/docs/cli/secrets-scripts): secrets are available in the subprocess environment.
