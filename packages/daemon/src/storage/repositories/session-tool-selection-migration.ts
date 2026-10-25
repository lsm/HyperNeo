import { parseJson, type SessionConfig } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { PromptProvenanceInit } from '../../lib/agent/agent-session.ts';
import {
  projectLegacySessionToolSelection,
  type SessionToolChoiceInput,
} from '../../lib/tools/session-tool-choice.ts';
import type { Database } from '../sqlite-compat.ts';
import { SpaceWorkflowRepository } from './space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from './space-workflow-run-repository.ts';

export type ToolSelectionCatalog = Pick<
  SessionToolChoiceInput,
  'skills' | 'registry' | 'overrides'
>;

interface SelectionWrite {
  table: 'sessions' | 'spaces' | 'global_settings';
  column: 'config' | 'settings';
  id: string | number;
  before: string | null;
  after: string;
}

interface ConfigRow {
  id: string | number;
  config: string | null;
  session_context?: string | null;
  metadata?: string | null;
}

function parseObject<T extends object>(raw: string | null | undefined): T | null {
  const value = parseJson<unknown>(raw ?? '{}', null);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

export function pinnedSlotVetoes(db: Database, metadata: string | null | undefined): string[] {
  const provenance = parseObject<{ promptProvenance?: PromptProvenanceInit }>(
    metadata
  )?.promptProvenance;
  if (!provenance?.workflowRunId || !provenance.nodeId) return [];
  const run = new SpaceWorkflowRunRepository(db).getRun(provenance.workflowRunId);
  const workflow = run ? new SpaceWorkflowRepository(db).getWorkflowForRun(run) : null;
  const slot = workflow?.nodes
    .find((node) => node.id === provenance.nodeId)
    ?.agents.find(
      (agent) => agent.name === provenance.agentName || agent.agentId === provenance.agentId
    );
  return slot?.disabledSkillIds ?? [];
}

function planSelections(db: Database, catalog: ToolSelectionCatalog): SelectionWrite[] {
  const plans: SelectionWrite[] = [];
  for (const row of db
    .prepare('SELECT id, config, session_context, metadata FROM sessions')
    .all() as ConfigRow[]) {
    const config = parseObject<SessionConfig>(row.config);
    if (!config || Object.hasOwn(config, 'toolSelection')) continue;
    const session = {
      id: String(row.id),
      context: parseObject<{ spaceId?: string }>(row.session_context) ?? {},
    };
    const toolSelection = projectLegacySessionToolSelection({
      ...catalog,
      session,
      disabledSkillIds: [
        ...(config.tools?.disabledSkills ?? []),
        ...pinnedSlotVetoes(db, row.metadata),
      ],
    });
    plans.push({
      table: 'sessions',
      column: 'config',
      id: row.id,
      before: row.config,
      after: JSON.stringify({ ...config, toolSelection }),
    });
  }
  for (const row of db.prepare('SELECT id, config FROM spaces').all() as ConfigRow[]) {
    const config = parseObject<Record<string, unknown>>(row.config);
    if (!config || Object.hasOwn(config, 'toolSelectionDefaults')) continue;
    const toolSelectionDefaults = projectLegacySessionToolSelection({
      ...catalog,
      session: { id: `defaults:space:${row.id}`, context: { spaceId: String(row.id) } },
      overrides: catalog.overrides.filter((override) => override.scopeType === 'space'),
    });
    plans.push({
      table: 'spaces',
      column: 'config',
      id: row.id,
      before: row.config,
      after: JSON.stringify({ ...config, toolSelectionDefaults }),
    });
  }
  const global = db
    .prepare('SELECT id, settings AS config FROM global_settings WHERE id=1')
    .get() as ConfigRow | null;
  if (global) {
    const config = parseObject<Record<string, unknown>>(global.config);
    if (config && !Object.hasOwn(config, 'toolSelectionDefaults')) {
      const toolSelectionDefaults = projectLegacySessionToolSelection({
        ...catalog,
        session: { id: 'defaults:global' },
        overrides: [],
      });
      plans.push({
        table: 'global_settings',
        column: 'settings',
        id: global.id,
        before: global.config,
        after: JSON.stringify({ ...config, toolSelectionDefaults }),
      });
    }
  }
  return plans;
}

function applySelections(db: Database, plans: SelectionWrite[]): number {
  return db.transaction(() =>
    plans.reduce(
      (count, plan) =>
        count +
        db
          .prepare(`UPDATE ${plan.table} SET ${plan.column}=? WHERE id=? AND ${plan.column} IS ?`)
          .run(plan.after, plan.id, plan.before).changes,
      0
    )
  )();
}

export const migrateSessionToolSelections = (
  superpipe({})('migrate-session-tool-selections') as PipelineAPI
)
  .input(['db', 'catalog'])
  .pipe(planSelections, ['db', 'catalog'], 'plans')
  .pipe(applySelections, ['db', 'plans'], 'updated')
  .end('updated') as (db: Database, catalog: ToolSelectionCatalog) => number;
