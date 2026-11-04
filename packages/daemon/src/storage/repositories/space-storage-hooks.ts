import type { PromptProvenanceInit } from '../../lib/agent/agent-session.ts';
import { basename, resolve } from 'node:path';
import type { Database } from '../sqlite-compat.ts';
import { SpaceRepository } from './space-repository.ts';
import { SpaceWorkflowRepository } from './space-workflow-repository.ts';
import { SpaceWorkspaceRepository } from './space-workspace-repository.ts';

export function spaceSlotSkillVetoes(db: Database, provenance: PromptProvenanceInit): string[] {
  if (!provenance.workflowRunId || !provenance.nodeId) return [];
  const run = db
    .prepare('SELECT workflow_id, definition_version FROM space_workflow_runs WHERE id = ?')
    .get(provenance.workflowRunId) as {
    workflow_id: string;
    definition_version: string | null;
  } | null;
  const workflow = run
    ? new SpaceWorkflowRepository(db).getWorkflowForRun({
        workflowId: run.workflow_id,
        definitionVersion: run.definition_version,
      })
    : null;
  const slot = workflow?.nodes
    .find((node) => node.id === provenance.nodeId)
    ?.agents.find(
      (agent) => agent.name === provenance.agentName || agent.agentId === provenance.agentId
    );
  return slot?.disabledSkillIds ?? [];
}

export function spaceWorkspaceSources(db: Database): { path: string; label: string }[] {
  const workspaceRepo = new SpaceWorkspaceRepository(db);
  const seen = new Set<string>();
  const out: { path: string; label: string }[] = [];

  for (const space of new SpaceRepository(db).listSpaces(true)) {
    for (const ws of workspaceRepo.listBySpace(space.id)) {
      if (!ws.path) continue;
      try {
        const abs = resolve(ws.path);
        if (seen.has(abs)) continue;
        seen.add(abs);
        const label = ws.label?.trim() || basename(abs);
        out.push({ path: abs, label });
      } catch {}
    }

    if (space.workspacePath) {
      try {
        const abs = resolve(space.workspacePath);
        if (seen.has(abs)) continue;
        seen.add(abs);
        out.push({ path: abs, label: basename(abs) });
      } catch {}
    }
  }
  return out;
}
