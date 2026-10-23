# HyperNeo owns skill and tool loading

Proposed; no implementation before human approval. **Skill:** workflow instructions
and resources. **MCP server:** callable tools/resources. **Pack:** domain data,
operations and policy; packs stay separate. **Plugin:** distribution bundle,
not another permission layer.

## Official contracts

- **Claude SDK** (project pin 0.3.302) discovers filesystem skill metadata, loads
  bodies on invocation, and accepts plugins bundling skills/agents/hooks/MCP
  ([skills][cs], [plugins][cp]). `settingSources: []` excludes user/project/local
  discovery, not managed policy or all global inputs. `strictMcpConfig` separately
  limits MCP to supplied servers ([settings][ct], [exceptions][ce]).
- **Codex** discovers repository/user/admin/system and plugin skills, loading
  metadata before bodies; configured/plugin MCP has separate policy
  ([skills][os], [MCP][om]).
- **OAP** negotiates source attachment at session open and effective-tool listing;
  live attachment/control-executed tools are not core guarantees. It defines no
  portable skill loader. Model providers receive inference/tool schemas, not
  skill discovery ([core][oa], [composition][oc]).

## HyperNeo today (code map)

| Surface | Definitions, storage and path to the session |
| --- | --- |
| Catalog/content | [Types](../../packages/shared/src/types/skills.ts), [built-ins](../../packages/daemon/src/lib/builtins.ts#L30), bundled `packages/skills/` and [Space coordination text](../../packages/daemon/src/lib/space/skills/space-coordination/SKILL.md); [SkillsManager](../../packages/daemon/src/lib/skills-manager.ts#L159) imports Git content and creates [SDK plugin wrappers](../../packages/daemon/src/lib/agent/builtin-skill-plugin-wrapper.ts#L35). [Development copying](../../packages/cli/src/skill-utils.ts#L7) and [binary extraction](../../packages/cli/src/prod-server-embedded.ts#L74) install the files. |
| Persistence/API | [Schema](../../packages/daemon/src/storage/schema/index.ts#L723): `skills`, `app_mcp_servers`, `mcp_enablement`, legacy room tables; their repositories, [skill CRUD](../../packages/daemon/src/lib/rpc-handlers/skill-handlers.ts#L26), [MCP CRUD](../../packages/daemon/src/lib/rpc-handlers/app-mcp-handlers.ts), [Space overrides](../../packages/daemon/src/lib/rpc-handlers/space-mcp-handlers.ts) and [LiveQuery](../../packages/daemon/src/lib/live-query/registry.ts#L122). MCP [seeding/import](../../packages/daemon/src/lib/mcp/mcp-import-service.ts#L120) also populates the registry. |
| UI/scopes | Global [Skills](../../packages/web/src/components/settings/SkillsRegistry.tsx#L26) and [MCP Servers](../../packages/web/src/components/settings/AppMcpServersSettings.tsx#L52), backed by their stores; [session Tools](../../packages/web/src/components/ToolsModal.tsx#L124) and [Space MCP](../../packages/web/src/components/space/SpaceMcpSettings.tsx). MCP resolves session > Space > default; room MCP rows are unread. Skills additionally have global, slot and session disable gates ([resolver](../../packages/daemon/src/lib/mcp/resolve-mcp-servers.ts#L10), [builder](../../packages/daemon/src/lib/agent/query-options-builder.ts#L1117)). |
| Injection/overlap | [Builder](../../packages/daemon/src/lib/agent/query-options-builder.ts#L1136) adds instruction plugins, skill-wrapped MCP and unwrapped registry MCP; wrapped server IDs are excluded from the registry path even when the skill is off. Thus two pages control one server. Explicit session plugins and [global setting sources](../../packages/shared/src/types/settings.ts#L196) add native discovery outside that skill catalog. |
| Other harnesses | [Codex Desktop start/send](../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts#L1137) delegates to its own harness without the HyperNeo skill catalog. [ACP](../../packages/daemon/src/lib/acp/acp-query-runner.ts#L705) bridges configured MCP, not portable skill bodies. |
| Runtime/Neo | [Session reconciliation](../../packages/daemon/src/lib/session/session-manager.ts#L423) pushes MCP changes; [ACP](../../packages/daemon/src/lib/agent/agent-session.ts#L1667) defers them. [Operations MCP](../../packages/daemon/src/lib/operations/mcp-server.ts#L14), [Space tools](../../packages/daemon/src/lib/space/runtime/space-runtime-service.ts#L886) and runtime config also inject servers. Neo's [tool preset](../../packages/daemon/src/lib/neo/session-config.ts#L18) omits `Skill` and sets empty sources, but the common builder still assembles plugins/MCP. [Packs](../../packages/daemon/src/lib/neo/pack-contract.ts#L77) supply domain operations/guidance, not skills. |

## Target: one host decision, adapter delivery

HyperNeo imports metadata/content into one catalog: stable IDs, provenance and
explicit dependencies. One policy snapshot determines discovery, loading and tool
access, with disabled reasons. Skill prose never grants tools, runs scripts,
approves actions or installs hooks.

Every session, including Neo, gets eligible names/descriptions and a proposed
`skill.load` operation through the existing operation registry. On demand, HyperNeo
checks scope/dependencies and returns the body plus authorized resource references;
missing dependencies are refused. Record the content revision, load references
separately, and execute scripts only through existing authorized tools.

OAP transports those operations through advertised tool sources; Claude SDK is
one adapter receiving explicit host options. Disable native skill/plugin discovery
for managed sessions; import required project guidance separately first. Vendor
managed policy remains authoritative and visible. Adapters unable to honor the
catalog must report unsupported capability, without silent native fallback.

**Recap:** Neo loads the body only for a recap request, fixes the N-hour window,
and reads paginated Neo history and PR-ledger operations with citations and coverage
gaps. No new pack, background turns or raw database access.

## Settings and small migration PRs

Use one **Capabilities** settings entry with **Skills** (instructions, sources,
dependencies) and **Tool servers** (connections, credentials, effective scope)
tabs. Show a server once; link dependencies rather than duplicate switches.
Packs retain their domain settings. Preserve stored files/rows and current denials.

1. Pin effective access, scope precedence and legacy aliases (tests only).
2. Extract the catalog/policy resolver without changing those results.
3. Build host metadata/body/resource operations with scope/dependency checks.
4. Wire Claude to that catalog, including Neo; separately preserve project guidance.
5. Wire the OAP adapter using only advertised attachment/catalog capabilities.
6. Add recap using existing ledger reads; missing bounded reads get their own PR.
7. Migrate MCP-skill aliases/gates into server policy, preserving effective access
   and stored records. Import supported bundle components without executing them;
   expose unsupported agents/hooks rather than silently adopting them.
8. Consolidate the settings UI against the host catalog.
9. Delete obsolete SDK wrappers/discovery and duplicate controls after parity.

Verify each slice on an isolated test daemon: identical policy gives identical
catalogs across Neo/ordinary and Claude/OAP; denied or dependency-missing loads are
refused; ambient discovery stays off; recap respects its time window. Check restart,
scope changes and unsupported adapters. This docs PR proves no runtime behavior.

[cs]: https://code.claude.com/docs/en/agent-sdk/skills
[cp]: https://code.claude.com/docs/en/agent-sdk/plugins
[ct]: https://code.claude.com/docs/en/agent-sdk/typescript#settingsource
[ce]: https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control
[os]: https://learn.chatgpt.com/docs/build-skills
[om]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[oa]: https://github.com/lsm/open-agent-protocol/blob/dad3d379429e930a08fdd933dafd4a37c992815c/drafts/agent-control-core.md
[oc]: https://github.com/lsm/open-agent-protocol/blob/dad3d379429e930a08fdd933dafd4a37c992815c/drafts/composition.md
