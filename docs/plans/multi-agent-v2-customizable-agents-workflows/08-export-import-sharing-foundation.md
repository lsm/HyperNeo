# Milestone 8: Data Layer — Export/Import & Sharing Foundation

## Goal

Implement export and import of custom agent definitions and workflow configurations as JSON within the Space system. This creates a pure data layer enabling sharing between Spaces and across installations. All code lives in the Space namespace — no existing Room code is modified.

## Isolation Checklist

- Export/import types in `packages/shared/src/types/space.ts` (NOT `neo.ts`)
- Export format utilities in `packages/daemon/src/lib/space/data/export-format.ts`
- RPC handlers in `packages/daemon/src/lib/rpc-handlers/space-export-import-handlers.ts`
- RPC namespace: `spaceExport.*` / `spaceImport.*` (NOT `export.*` / `import.*`)
- All handlers use `spaceId` context (NOT `roomId`)
- Frontend UI in `packages/web/src/components/space/ImportPreviewDialog.tsx` (NOT `room/`)
- No modifications to any existing handler, type file, or UI component

## Version Migration Strategy

The export format uses `version: 1` as a literal type for strict validation:
- **Import**: Includes transform functions (`v1ToV2`, etc.) for upgrading older formats. Always targets current version.
- **Export**: Always in latest version format.
- **Rejection**: Versions newer than current runtime are rejected with clear error.

## Scope

- JSON export format for agents and workflows (types in `space.ts`)
- Import with validation and conflict resolution
- RPC handlers (`spaceExport.*`/`spaceImport.*`)
- Frontend UI under `packages/web/src/components/space/`
- Unit tests

---

### Task 8.1: Define Export/Import JSON Format

**Agent:** coder
**Priority:** normal
**Depends on:** Task 2.1, Task 3.2

**Description:**

Define a standardized JSON format for exporting and importing custom agents and workflows. All types in `space.ts`.

**Subtasks:**

1. Add export/import types to `packages/shared/src/types/space.ts`:

   ```typescript
   /** Exported agent definition (space-agnostic) */
   interface ExportedSpaceAgent {
     version: 1;
     type: 'agent';
     name: string;
     description: string;
     model: string;
     provider?: string;
     tools: string[];
     systemPrompt: string;
     role: 'worker' | 'reviewer' | 'orchestrator';
     config?: Record<string, unknown>;
   }

   /** Exported workflow definition (space-agnostic) */
   interface ExportedSpaceWorkflow {
     version: 1;
     type: 'workflow';
     name: string;
     description: string;
     steps: Array<{
       name: string;
       /**
        * The agent name used for import resolution (NOT the UUID).
        * SpaceAgent UUIDs are space-specific and stripped on export.
        * exportWorkflow() resolves agentId UUIDs to SpaceAgent names via SpaceAgentManager.
        * importWorkflow() resolves names back to agentId UUIDs by looking up agents in the
        * target space (or in the bundle if importing both agents and workflows together).
        */
       agentName: string;
       instructions?: string;
     }>;
     transitions: Array<{
       /** Source step name (step names must be unique within a workflow — used instead of UUID) */
       from: string;
       to: string;
       condition?: {
         type: 'always' | 'human' | 'condition';
         expression?: string;
         description?: string;
         maxRetries?: number;
         timeoutMs?: number;
       };
       order?: number;
     }>;
     rules: Array<{
       name: string;
       content: string;
       /**
        * Step references use step **names** (NOT UUIDs — step names must be unique within a workflow).
        * exportWorkflow() remaps appliesTo from step IDs to step names.
        * importWorkflow() remaps step names back to newly generated step IDs.
        */
       appliesTo?: string[];
     }>;
     tags: string[];
     config?: Record<string, unknown>;
   }

   /** Bundle containing agents and/or workflows from a Space */
   interface SpaceExportBundle {
     version: 1;
     type: 'bundle';
     name: string;
     description?: string;
     agents: ExportedSpaceAgent[];
     workflows: ExportedSpaceWorkflow[];
     exportedAt: string;
     exportedFrom?: string; // space name (optional metadata)
   }
   ```

2. Create `packages/daemon/src/lib/space/data/export-format.ts`:
   - `exportAgent(agent: SpaceAgent): ExportedSpaceAgent`
   - `exportWorkflow(workflow: SpaceWorkflow, agents: SpaceAgent[]): ExportedSpaceWorkflow` — **must remap**: (1) `rules[].appliesTo` from step UUIDs to step **names**; (2) step `agentId` UUIDs to agent **names** via `agentName` field (lookup in provided agents array); (3) transition `from`/`to` step UUIDs to step **names**
   - `exportBundle(agents: SpaceAgent[], workflows: SpaceWorkflow[], name: string): SpaceExportBundle`
   - Strip space-specific IDs and timestamps

3. Validation functions:
   - `validateExportedAgent(data: unknown): ExportedSpaceAgent`
   - `validateExportedWorkflow(data: unknown): ExportedSpaceWorkflow`
   - `validateExportBundle(data: unknown): SpaceExportBundle`
   - Use zod schemas
   - Version handling: accept v1 only; v2+ → "requires newer version"; missing/< 1 → invalid

4. Write unit tests:
   - Round-trip: export → serialize → deserialize → validate
   - **Rule appliesTo round-trip**: export with step-specific rules → verify step **names** in JSON → import → verify correct new step IDs
   - Validation rejects malformed data
   - Space-specific fields (id, spaceId, timestamps) stripped on export
   - Version validation

**Acceptance criteria:**
- Export format well-defined and versioned
- All types in `space.ts` (NOT `neo.ts`)
- Type names use Space prefix (`ExportedSpaceAgent`, `SpaceExportBundle`)
- `appliesTo` correctly remapped between step UUIDs and step names
- Version checking provides clear messages
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 8.2: Export/Import RPC Handlers

**Agent:** coder
**Priority:** normal
**Depends on:** Task 8.1

**Description:**

Add RPC handlers for exporting and importing agents and workflows using `spaceExport.*`/`spaceImport.*` namespace with `spaceId` context.

**Subtasks:**

1. Create `packages/daemon/src/lib/rpc-handlers/space-export-import-handlers.ts`:
   - `spaceExport.agents { spaceId, agentIds? }` → `{ bundle: SpaceExportBundle }`
   - `spaceExport.workflows { spaceId, workflowIds? }` → `{ bundle: SpaceExportBundle }`
   - `spaceExport.bundle { spaceId, agentIds?, workflowIds? }` → full bundle
   - `spaceImport.preview { bundle, spaceId }` → `{ agents: ImportPreview[], workflows: ImportPreview[], validationErrors }` — dry run with conflict detection AND full `SpaceWorkflowManager` validation (transition/condition validation)
   - `spaceImport.execute { spaceId, bundle, conflictResolution }` → creates entities (re-validates)

2. Conflict resolution:
   - `ImportPreview`: `name`, `action: 'create' | 'conflict'`, `existingId?`
   - `conflictResolution`: `'skip' | 'rename' | 'replace'` per item

3. Cross-references and ID remapping:
   - **Agent name→UUID remapping**: Exported workflow steps use `agentName` (not UUID). On import, resolve names to `agentId` UUIDs by: (1) checking the bundle's imported agents (if importing both), (2) checking existing agents in target space by name. If agent not found, flag as warning in preview.
   - **Step ID remapping for rules and transitions**: new step UUIDs generated on import; remap `rules[].appliesTo` from step names back to new step UUIDs using `Map<stepName, newStepId>`; remap transition `from`/`to` step names back to new step UUIDs using the same map

4. Wire handlers in `packages/daemon/src/lib/rpc-handlers/index.ts` (via `setupRPCHandlers()` — add new registration only)

5. Write unit tests:
   - Export includes correct data from `space_agents`/`space_workflows` tables
   - Preview detects conflicts and validation errors
   - All conflict resolutions work
   - Cross-reference mapping (agent name→UUID remapping for custom steps + step ID remapping for rules.appliesTo)
   - All handlers use `spaceId` (NOT `roomId`)

**Acceptance criteria:**
- RPC namespace is `spaceExport.*`/`spaceImport.*` (NOT `export.*`/`import.*`)
- All handlers use `spaceId` context (NOT `roomId`)
- Export reads from `space_agents`/`space_workflows` tables
- Import writes to `space_agents`/`space_workflows` tables
- Preview detects conflicts, missing references, AND validation errors
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 8.3: Frontend Export/Import UI

**Agent:** coder
**Priority:** normal
**Depends on:** Task 8.2

**Description:**

Add export and import actions to agent and workflow list views within the Space UI. All components under `packages/web/src/components/space/`.

**Subtasks:**

1. Export functionality:
   - "Export" on individual agent/workflow cards (in `SpaceAgentList` and `WorkflowList`)
   - "Export All" on list views
   - "Export Bundle" in Space settings
   - Downloads `.hyperneo.json` file: `{space-name}-{type}-{date}.hyperneo.json`

2. Import functionality:
   - "Import" button on list views
   - File picker for `.json`/`.hyperneo.json`
   - Preview dialog showing items, conflicts, cross-reference warnings
   - Conflict resolution per item (skip/rename/replace)
   - Success/error toast, version mismatch message

3. Create `packages/web/src/components/space/ImportPreviewDialog.tsx`:
   - Modal with import preview results
   - Checkbox per item, conflict resolution dropdown per conflict
   - Warning section for missing cross-references
   - Summary: "Will create X agents and Y workflows"
   - **This is under `components/space/`** — NOT `components/room/`

4. Write e2e tests:
   - Export agent from Space, verify download
   - Import with conflict (same name in same space)
   - Import into space with no conflicts
   - Import bundle with both agents and workflows

**Acceptance criteria:**
- All UI components under `packages/web/src/components/space/`
- Export downloads valid JSON with `spaceId` context
- Import preview before executing
- Missing cross-references warned
- Conflict resolution works
- E2E tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
