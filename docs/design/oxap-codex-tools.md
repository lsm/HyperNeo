# HyperNeo tools for OXAP Codex chats

Status: design, 2026-11-23

An OXAP Codex chat should get the same `hyperneo-operations` MCP server as a
Claude Code chat: `invoke` reaches the operation catalog, including
`operations.list`, `operations.describe`, `message.send`, and `desktop.call`.
The session's existing identity and operation policies stay authoritative.
This is MCP attachment, not OXAP's separate control-layer-provided-tool path.

The pinned OXAP alpha.43 cannot do this. Its Codex adapter does not advertise
`action.tool_sources.attach`, and its thread encoder writes only reasoning and
compaction settings into `config`
([capabilities](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/adapter/codex/session.zig#L1410-L1434),
[encoder](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/adapter/codex/native.zig#L334-L372)).
Direct Codex 0.171.0 accepts per-thread `config.mcp_servers`; a native start
probe kept two threads' MCP catalogs separate. A real native resume with a
saved rollout remains unverified and is a release gate below.

## Use the existing tool-source protocol

[OXAP Decision 0008](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/decisions/0008-tool-sources.md#L225-L259)
already defines `session.open.request.tool_sources` per session. It separates
attachment-only values from the public source descriptor, and its
[daemon boundary](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/decisions/0008-tool-sources.md#L461-L529)
lets a wire caller name a trusted source but not supply a command or literal
credential environment. The stdio hub already resolves configured sources by
ID before calling the adapter
([source substitution](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/hub/stdio.zig#L199-L243)).
No new public tool-source verb or client-provided-tool protocol is needed.

The Codex adapter advertises attachment as native with modes `session_open`
and `remote`, and discloses transport `remote`. It accepts only `kind:
"remote"`, `protocol: "mcp"` sources and translates each resolved attachment
to `config.mcp_servers[<id>]` on both `thread/start` and `thread/resume`:

- `endpoint` becomes `url`.
- Trusted, adapter-private `headers` becomes `http_headers`.
- Reasoning and compaction members remain in the same `config` object.

Codex 0.171.0 defines `url` and literal `http_headers` for streamable HTTP MCP
servers ([configuration](https://github.com/openai/codex/blob/295eca93394bb83a6ec8e0841033f3997f97fcbd/codex-rs/config/src/mcp_types.rs#L397-L417)).
Malformed sources, duplicate IDs, unsupported kinds, and a source that cannot
be resolved fail the open; OXAP must never silently start a thread with the
requested tools missing.

## Keep credentials behind the trusted boundary

Do not add `headers` to the public attachment schema and do not put a bearer
token in the endpoint URL. HyperNeo is a separate stdio peer, so Decision
0008's wire rules apply to it. A shared configured source is also wrong: it
would share identity or race credentials between chats.

OXAP adds one hub-local option, `--session-tool-sources <directory>`. The
directory is operator-owned mode 0700. For every external create or reopen,
HyperNeo atomically writes a new mode 0600 capability file containing the OXAP
session ID, source descriptor, and `Authorization: Bearer <credential>`. Its
filename is a fresh 256-bit random reference, not the session ID.

The attachment adds one member requiring an OAP decision:
`{ id, kind, credential_ref }`. The hub accepts only the reference's canonical
base64url form, resolves it inside the fixed directory, and requires the
file's session and source IDs to match the open exactly. It claims the file
atomically before calling the adapter and deletes it after use. A missing,
invalid, cross-session, duplicate, or replayed reference is `unsatisfiable`.
Knowing another chat's session ID therefore proves nothing: the caller must
also possess the fresh one-time capability. The reference is never the bearer
and never reaches Codex.

Resolution adds headers only after public request validation, in the
adapter-private attachment. The existing internal `ConfiguredSource.headers`
field can carry them, but the current stdio serializer must stop dropping them
([field](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/adapter/contract.zig#L120-L130),
[serializer](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/hub/stdio.zig#L228-L243)).

Headers and credential references never enter OAP state, catalogs, source
descriptors, session metadata, or bindings. Native requests travel only over
the private adapter pipe. Production and verification logs redact both header
values and any captured native config. Neither the bearer nor the reference
appears on a command line, in a process environment, in HyperNeo's database,
or in a URL. The containment inventory also includes every rollout and config
file Codex writes under its home: Codex receives `http_headers`, and whether
it persists that per-thread config is unverified. Any bearer or reference hit
in those files blocks the release.

## Reopen restores the binding, not a secret

Two current OXAP details need a protocol decision. Sessions with attachments
are excluded from idle reopen, and the parked-session wake path does not pass
sources ([reopenability](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/hub/hub.zig#L1052-L1054),
[wake](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/hub/hub.zig#L1100-L1131)).
The binding schema already has `tool_source_ids`, but the Zig hub does not
populate it ([schema](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/hub/binding.zig#L12-L23),
[writer](https://github.com/lsm/oxap/blob/6a8a6275e01b42d614e1a87da6cc3d72dfff6e5d/zig/src/hub/hub.zig#L2355-L2371)).

Amend Decisions 0008 and 0040 together with this rule: source IDs are part of
the session binding; their credentials are not. Create records the IDs. An
external explicit reopen must repeat exactly those IDs with a fresh
`credential_ref` for each; an omitted, added, removed, or replaced source is
refused. Every external open resolves new capability files, and failure
refuses the reopen rather than dropping the tools.

An idle-park wake is different: no external open exists to authenticate. The
hub keeps the resolved adapter-private attachment in its in-memory
`OpenedWith` record and reuses it with the bound IDs on wake. It never writes
that material to the binding. This preserves Decision 0008's non-revocable
attachment while making Decision 0040's close-and-reopen a detach of the same
logical session.

The same decision defines `credential_ref` as a one-time, attachment-only
capability and trusted headers as adapter-private material. Neither is a
public descriptor or binding field. The capability directory is hub
configuration; the reference is the one public schema addition. Accepting
literal headers from stdio clients would be a different, wider protocol
decision and is not part of this design.

## HyperNeo's external operations endpoint

HyperNeo runs one MCP streamable-HTTP listener on `127.0.0.1` with an
ephemeral port and one `/mcp` route. It binds no other interface. It requires
an `Authorization: Bearer` credential generated from 32 random bytes,
compared in constant time, plus the existing loopback request hardening:
allowlisted Host, rejected Origin, JSON request bodies, bounded sizes and
timeouts. The token is never a URL parameter.

Extract the tool registration shared by the current SDK server and this HTTP
server so discovery, result shaping, refusal audit, and Neo-only resident
tools cannot drift. Both transports call the existing
`createOperationMcpHandler` and operation registry
([handler](https://github.com/lsm/HyperNeo/blob/c46d70db3311741898c1ccc2c72f7aa4c5162e80/packages/daemon/src/lib/operations/mcp-adapter.ts#L69-L119)).
No operation gains a new transition, retry policy, or authorization bypass.

A grant maps one random credential to one HyperNeo `AgentSession`. The server,
not the MCP input, resolves the session ID, role, Space scope, agent identity,
and tool profile through the same caller path as the Claude client
([identity](https://github.com/lsm/HyperNeo/blob/c46d70db3311741898c1ccc2c72f7aa4c5162e80/packages/daemon/src/lib/agent/agent-session.ts#L386-L444)).
Calls still use `source: "mcp"`; there is no client-supplied role or session
override. Thus `message.send` and every other operation keep their current
catalog and policy checks.

### Desktop keeps todo and turn scope

This design does not admit an OXAP desktop worker. Current Codex admission
refuses Space sessions, `workerOperations`, and tool guards
([admission](https://github.com/lsm/HyperNeo/blob/c46d70db3311741898c1ccc2c72f7aa4c5162e80/packages/daemon/src/lib/agent/session-engine.ts#L98-L121)).
An approved desktop-todo run is therefore not an acceptance gate for these
slices. A later worker-admission design must first map those protections to
OXAP without weakening them.

No desktop gate changes. `desktop.call` still requires an MCP worker caller,
the worker's active approved todo, its work directory, and its approved apps
([gates](https://github.com/lsm/HyperNeo/blob/c46d70db3311741898c1ccc2c72f7aa4c5162e80/packages/daemon/src/lib/desktop/call-operation.ts#L70-L119)).
An ordinary OXAP chat has no approved worker todo and is refused by those
existing gates. Attaching the server never grants desktop access.

Before a future admitted worker can use it, the OXAP query branch must create
the same per-attempt `DesktopTurn` and live callback as the Claude branch;
interrupt must cancel that exact turn
([Claude turn wiring](https://github.com/lsm/HyperNeo/blob/c46d70db3311741898c1ccc2c72f7aa4c5162e80/packages/daemon/src/lib/agent/query-runner.ts#L1068-L1076),
[interrupt](https://github.com/lsm/HyperNeo/blob/c46d70db3311741898c1ccc2c72f7aa4c5162e80/packages/daemon/src/lib/agent/agent-session.ts#L1347-L1370)).
That prerequisite belongs to the later worker design, not the transport PR.

### Revocation

HyperNeo revokes the grant, deletes its unused capability files, and closes
its MCP transports when the HyperNeo session is deleted or archived; daemon
shutdown revokes all grants. A later reopen creates a fresh grant and file.
The old bearer then receives 401 and cannot invoke even a read operation.
OXAP's native close/reopen is only a detach: it retains the HyperNeo grant so
resume can work. Stale capability files are removed at daemon startup.

## Pull request order

1. **OXAP protocol:** amend the credential-reference, reopen, and
   trusted-header decisions. Include missing, invalid, cross-session,
   replayed, omitted, changed, and unavailable source cases.
2. **OXAP create:** add one-time capability resolution and Codex remote
   attachment on `thread/start`; prove two sessions receive only their own
   tools, a caller naming another session without its fresh reference is
   refused, and secret canaries stay out of published state, logs, and every
   Codex-home rollout and config file.
3. **OXAP reopen:** persist source IDs, require fresh references on explicit
   reopen, retain resolved sources only in memory for idle wake, emit
   `config.mcp_servers` on `thread/resume`, and prove a real Codex resume
   after a model turn and process restart.
4. **OXAP release:** tag the release, publish checksums, and run the native
   start/resume, cross-client refusal, and two-session isolation gates against
   that artifact. Repeat the bearer and reference canary scan over all
   Codex-home rollout and config files after the real resume and process
   restart; any hit blocks the release.
5. **HyperNeo transport:** extract shared operation tool registration and add
   the loopback server, grants, and revocation. Prove parity with the Claude
   handler, cross-session bearer refusal, and post-close revocation directly.
6. **HyperNeo wiring:** pin the released OXAP, write and consume one capability
   in each Codex external open plan, and update the verify journey. Existing
   Codex bindings with no tool-source IDs resume without tools. Set
   `tool_approval: "approve"` only in the daemon-owned operations capability.
   Run a real OXAP
   Codex chat through operations discovery and `message.send`, verify its
   ordinary-chat desktop refusal, and repeat the cross-client and revocation
   proofs through the released path.

No slice adds runtime attach/detach, a general credential broker, remote
network access, a second operation catalog, or OXAP desktop-worker admission.
