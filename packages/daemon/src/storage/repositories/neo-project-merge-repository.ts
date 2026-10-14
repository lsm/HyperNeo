import type { Database } from '../sqlite-compat.ts';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import {
  createNeoProjectMergePipeline,
  type NeoProjectMergeInput,
  type NeoProjectMergeResult,
  type NeoProjectMergeState,
} from '../../lib/neo/project-merge.ts';

export class NeoProjectMergeRepository {
  constructor(private readonly db: Database) {}

  resolve(id: string): string | null {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const row = this.db
        .prepare('SELECT target_id FROM neo_project_merges WHERE source_id = ?')
        .get(id) as { target_id: string } | null;
      if (!row)
        return this.db.prepare('SELECT id FROM neo_concerns WHERE id = ?').get(id) ? id : null;
      id = row.target_id;
    }
    return null;
  }

  private state(): NeoProjectMergeState {
    const projects = this.db
      .prepare(`SELECT id, title, summary, context, revision,
      parent_id AS parentId, epic_url AS epicUrl, created_at AS createdAt, updated_at AS updatedAt
      FROM neo_concerns`)
      .all() as NeoProject[];
    const identities: Record<string, string[]> = {};
    for (const row of this.db
      .prepare("SELECT alias, project_id FROM neo_project_workspaces WHERE alias LIKE 'git:%'")
      .all() as { alias: string; project_id: string }[])
      (identities[row.project_id] ??= []).push(row.alias);
    const unavailable = new Set<string>();
    for (const row of this.db
      .prepare(`SELECT b.concern_id AS id FROM neo_session_bindings b
      JOIN sessions s ON s.id = b.session_id WHERE b.kind = 'project'
      AND s.processing_state IS NOT NULL AND
      (NOT json_valid(s.processing_state) OR json_extract(s.processing_state, '$.status') IS NOT 'idle')`)
      .all() as { id: string }[])
      unavailable.add(row.id);
    for (const [table, condition] of [
      ['neo_asks', "status IN ('waiting', 'blocked')"],
      ['neo_consultations', "status = 'pending'"],
      ['neo_consultation_waiters', "status IN ('queued', 'admitted')"],
    ]) {
      for (const row of this.db
        .prepare(`SELECT DISTINCT concern_id AS id FROM ${table} WHERE ${condition}`)
        .all() as { id: string }[])
        unavailable.add(row.id);
    }
    return {
      projects,
      identities,
      unavailable: [...unavailable],
      retired: (
        this.db.prepare('SELECT source_id FROM neo_project_merges').all() as { source_id: string }[]
      ).map((row) => row.source_id),
    };
  }

  merge(input: NeoProjectMergeInput): NeoProjectMergeResult {
    return this.db.transaction(() =>
      createNeoProjectMergePipeline(
        () => this.state(),
        ({ source, target }) => {
          const binding = this.db
            .prepare(
              "SELECT session_id FROM neo_session_bindings WHERE concern_id = ? AND kind = 'project'"
            )
            .get(source.id) as { session_id: string } | null;
          this.db
            .prepare(`INSERT INTO neo_project_merges(source_id, target_id, source_session_id, merged_at)
          VALUES (?, ?, ?, ?)`)
            .run(source.id, target.id, binding?.session_id ?? null, Date.now());
          for (const table of [
            'neo_asks',
            'neo_work',
            'neo_consultations',
            'neo_consultation_waiters',
          ])
            this.db
              .prepare(`UPDATE ${table} SET concern_id = ? WHERE concern_id = ?`)
              .run(target.id, source.id);
          this.db
            .prepare('UPDATE neo_project_workspaces SET project_id = ? WHERE project_id = ?')
            .run(target.id, source.id);
          this.db
            .prepare(
              'UPDATE neo_concerns SET parent_id = ?, revision = revision + 1 WHERE parent_id = ?'
            )
            .run(target.id, source.id);
          this.db
            .prepare(
              'UPDATE neo_session_bindings SET concern_id = ? WHERE concern_id = ? AND kind = ?'
            )
            .run(target.id, source.id, 'worker');
          this.db
            .prepare("DELETE FROM neo_session_bindings WHERE concern_id = ? AND kind = 'project'")
            .run(source.id);
          this.db
            .prepare(`UPDATE neo_concerns SET context = ?, summary = ?, revision = revision + 1,
          updated_at = ? WHERE id = ?`)
            .run(
              [target.context, source.context].filter(Boolean).join('\n\n'),
              [target.summary, source.summary].filter(Boolean).join('\n\n'),
              Date.now(),
              target.id
            );
          return { ok: true, sourceId: source.id, targetId: target.id };
        }
      )(input)
    )();
  }
}
