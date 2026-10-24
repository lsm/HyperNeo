# HyperNeo owns skill and tool loading

Proposed; docs-only until human approval. **Skill:** workflow instructions
and resources. **MCP server:** callable tools/resources. **Pack:** domain data,
operations and policy; packs stay separate. **Plugin:** distribution bundle,
not permission authority.

## Official contracts

- **Claude SDK** (project pin 0.3.302) discovers filesystem skill metadata, loads
  bodies on invocation, and accepts skill/agent/hook/MCP plugins
  ([skills][cs], [plugins][cp]). `settingSources: []` excludes user/project/local
  discovery, not managed policy or all global inputs. `strictMcpConfig` separately
  limits MCP to supplied servers ([settings][ct], [exceptions][ce]).
- **Codex** already scans `.agents/skills/` from the working directory to the repo
  root, follows skill-folder symlinks, and also discovers user/admin/system/plugin
  skills. Names/descriptions precede bodies; duplicates are not merged. `.claude/skills/`
  discovery is not documented. MCP has separate policy ([skills][os], [MCP][om]).
- **OAP** negotiates source attachment at session open and effective-tool listing;
  live attachment/control-executed tools are not core guarantees. It defines no
  portable skill loader. Model providers receive inference/tool schemas, not
  skill discovery ([core][oa], [composition][oc]).

## HyperNeo today (code map)

| Surface | Definitions, storage and path to the session |
| --- | --- |
| Catalog/content | [Types](../../packages/shared/src/types/skills.ts), [built-ins](../../packages/daemon/src/lib/builtins.ts#L30), bundled `packages/skills/` and [Space coordination text](../../packages/daemon/src/lib/space/skills/space-coordination/SKILL.md); [SkillsManager](../../packages/daemon/src/lib/skills-manager.ts#L159) imports Git and creates [SDK plugin wrappers](../../packages/daemon/src/lib/agent/builtin-skill-plugin-wrapper.ts#L35). [Development copying](../../packages/cli/src/skill-utils.ts#L7) and [binary extraction](../../packages/cli/src/prod-server-embedded.ts#L74) install content. |
| Persistence/API | [Schema](../../packages/daemon/src/storage/schema/index.ts#L723): `skills`, `app_mcp_servers`, `mcp_enablement`, legacy room tables; their repositories, [skill CRUD](../../packages/daemon/src/lib/rpc-handlers/skill-handlers.ts#L26), [MCP CRUD](../../packages/daemon/src/lib/rpc-handlers/app-mcp-handlers.ts), [Space overrides](../../packages/daemon/src/lib/rpc-handlers/space-mcp-handlers.ts) and [LiveQuery](../../packages/daemon/src/lib/live-query/registry.ts#L122). [MCP import](../../packages/daemon/src/lib/mcp/mcp-import-service.ts#L120) populates it. |
| UI/scopes | Global [Skills](../../packages/web/src/components/settings/SkillsRegistry.tsx#L26) and [MCP Servers](../../packages/web/src/components/settings/AppMcpServersSettings.tsx#L52), with their stores; [session Tools](../../packages/web/src/components/ToolsModal.tsx#L124) and [Space MCP](../../packages/web/src/components/space/SpaceMcpSettings.tsx). MCP resolves session > Space > default; room MCP rows are unread. Skills additionally have global, slot and session disable gates ([resolver](../../packages/daemon/src/lib/mcp/resolve-mcp-servers.ts#L10), [builder](../../packages/daemon/src/lib/agent/query-options-builder.ts#L1117)). |
| Repo-authored skills | Hand-made `.claude/skills/<name>/SKILL.md` trees, including [verify](../../.claude/skills/verify/SKILL.md) with scripts/journeys, bypass the global registry through project sources. The coding [preflight](../../packages/daemon/src/lib/neo/packs/coding/prepare-execution.ts#L58) checks committed legacy paths or an AGENTS Verify section; [worker rules](../../packages/prompts/src/neo/packs/coding/worker-rules.md#L6) name the same tree. `verifySkill: "create"` is a bootstrap exception, not a loader. |
| Injection/overlap | [Builder](../../packages/daemon/src/lib/agent/query-options-builder.ts#L1136) adds instruction plugins, skill-wrapped MCP and unwrapped registry MCP; wrapped server IDs are excluded from the registry path even when the skill is off. Two pages control one server; session plugins and [global setting sources](../../packages/shared/src/types/settings.ts#L196) permit additional native discovery. |
| Other harnesses | [Codex Desktop start/send](../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts#L1137) delegates to its own harness without the HyperNeo skill catalog. [ACP](../../packages/daemon/src/lib/acp/acp-query-runner.ts#L705) bridges configured MCP, not portable skill bodies. |
| Runtime/Neo | [Session reconciliation](../../packages/daemon/src/lib/session/session-manager.ts#L423) pushes MCP changes; [ACP](../../packages/daemon/src/lib/agent/agent-session.ts#L1667) defers them. [Operations MCP](../../packages/daemon/src/lib/operations/mcp-server.ts#L14), [Space tools](../../packages/daemon/src/lib/space/runtime/space-runtime-service.ts#L886) and runtime config also inject servers. Neo's [tool preset](../../packages/daemon/src/lib/neo/session-config.ts#L18) omits `Skill` and sets empty sources, but the common builder still assembles plugins/MCP. [Packs](../../packages/daemon/src/lib/neo/pack-contract.ts#L77) supply domain operations/guidance, not skills. |

## Target: one host decision, adapter delivery

Origins are bundled, global and repo-authored. Canonical repo content lives in
`.agents/skills/<name>/SKILL.md` (also native to Codex). HyperNeo scans from session
directory to repo root, importing legacy `.claude/skills/` trees. By reviewed move,
make `.claude/skills/` an in-repo symlink to `.agents/skills/` so apps and HyperNeo
read the same files. Preserve scripts, references, journeys and assets; never
migrate automatically. Deduplicate identical aliases; qualify conflicts by repo/source/path.

Catalog IDs qualify origin/repo/path; checkout and revision bind loads. Repo skills
remain file-owned and repo-scoped; a global install cannot satisfy a required repo
verify skill. One policy snapshot controls availability and tool access. Skill prose never grants tools, approves actions or installs hooks.

Daemon-run sessions, including Neo, get eligible metadata and proposed `skill.load` through
the existing operation registry. HyperNeo checks scope/dependencies before returning
the body and skill-root-relative resources. Scripts/journeys use existing authorized
tools; relative paths survive migration.

OAP transports operations through advertised tool sources; Claude SDK receives
explicit host options. Disable native skill/plugin discovery **only for sessions
the daemon runs itself (SDK/ACP/OAP)**; import project guidance separately first.
Claude Desktop and Codex Desktop keep native repo-skill discovery: HyperNeo cannot
and should not disable it; those workers find verify this way today. Vendor managed
policy remains authoritative and visible. Incapable daemon-run adapters report
unsupported capability, without silent native fallback.

**Recap:** load on request, fix the N-hour window, and paginate Neo/PR-ledger reads
with citations and coverage gaps. No new pack, background turn or raw database access.

## Settings and small migration PRs

Use one **Capabilities** settings entry with **Skills** (instructions, sources,
dependencies) and **Tool servers** (connections, credentials, effective scope)
tabs. One server, one switch; link dependencies.
The Skills tab filters bundled/global/current-repo sources; repo rows link to files,
not global copies. Packs retain domain settings. The coding pack keeps its verify
requirement/prepared-commit check but uses the host resolver; keep the AGENTS fallback
and creation bootstrap. `verifySkill` neither enables MCP nor owns files.

1. Pin effective access, legacy repo verify trees and scope aliases (tests only).
2. Extract policy; build repo discovery/alias resolution in its own small PR.
3. Build scoped metadata/body/resource operations; then adapt the coding verify gate/prompts separately.
4. Wire Claude to that catalog, including Neo; separately preserve project guidance.
5. Add recap next: requires `skill.load`, Neo wiring and bounded ledger reads
   (add missing reads first).
6. Wire remaining daemon-run adapters via advertised capabilities; Desktop keeps native discovery.
7. Migrate MCP-skill aliases/gates into server policy, preserving effective access
   and stored records. Import supported bundle components without executing them;
   expose unsupported agents/hooks rather than silently adopting them.
8. Consolidate the settings UI against the host catalog.
9. Delete obsolete SDK wrappers/discovery and duplicate controls after parity.

Verify each slice on an isolated test daemon: identical policy gives identical
catalogs across daemon-run adapters and Neo/ordinary sessions. Check Desktop native
discovery through the shared repo tree, legacy/canonical verify,
script/journey loading, same-name repos/worktrees, denied dependencies, restart and
no double native discovery. Recap respects its time window. This docs PR proves no
runtime behavior.

[cs]: https://code.claude.com/docs/en/agent-sdk/skills
[cp]: https://code.claude.com/docs/en/agent-sdk/plugins
[ct]: https://code.claude.com/docs/en/agent-sdk/typescript#settingsource
[ce]: https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control
[os]: https://learn.chatgpt.com/docs/build-skills
[om]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[oa]: https://github.com/lsm/open-agent-protocol/blob/dad3d379429e930a08fdd933dafd4a37c992815c/drafts/agent-control-core.md
[oc]: https://github.com/lsm/open-agent-protocol/blob/dad3d379429e930a08fdd933dafd4a37c992815c/drafts/composition.md
