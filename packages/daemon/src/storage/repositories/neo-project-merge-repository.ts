import type { Database } from '../sqlite-compat.ts';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import {
  createNeoProjectMergePipeline,
  planNeoProjectMerges,
  planNeoProjectQuestions,
  type NeoProjectQuestion,
  type NeoProjectMergeInput,
  type NeoProjectMergeResult,
  type NeoProjectMergeState,
} from '../../lib/neo/project-merge.ts';

export class NeoProjectMergeRepository {
  constructor(
    private readonly db: Database,
    private readonly notify: () => void = () => {}
  ) {}

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

  redirects(): { sourceId: string; targetId: string }[] {
    return (
      this.db.prepare('SELECT source_id FROM neo_project_merges').all() as { source_id: string }[]
    ).flatMap(({ source_id: sourceId }) => {
      const targetId = this.resolve(sourceId);
      return targetId ? [{ sourceId, targetId }] : [];
    });
  }

  redirectSession(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT source_id FROM neo_project_merges WHERE source_session_id = ?')
      .get(sessionId) as { source_id: string } | null;
    const target = row ? this.resolve(row.source_id) : null;
    const binding = target
      ? (this.db
          .prepare(
            "SELECT session_id FROM neo_session_bindings WHERE concern_id = ? AND kind = 'project'"
          )
          .get(target) as { session_id: string } | null)
      : null;
    return binding?.session_id ?? null;
  }

  localFolders(machine: string): { projectId: string; folder: string }[] {
    const prefix = `folder:${machine}\u0000`;
    return (
      this.db
        .prepare("SELECT alias, project_id FROM neo_project_workspaces WHERE alias LIKE 'folder:%'")
        .all() as { alias: string; project_id: string }[]
    ).flatMap((row) =>
      row.alias.startsWith(prefix)
        ? [{ projectId: row.project_id, folder: row.alias.slice(prefix.length) }]
        : []
    );
  }

  recordIdentities(fresh: Readonly<Record<string, readonly string[]>>): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)'
    );
    for (const [projectId, identities] of Object.entries(fresh))
      for (const identity of identities) insert.run(identity, projectId);
  }

  questions(fresh: Readonly<Record<string, readonly string[]>>): NeoProjectQuestion[] {
    const repositories: Record<string, string[]> = {};
    for (const row of this.db
      .prepare("SELECT alias, project_id FROM neo_project_workspaces WHERE alias LIKE 'repo:%'")
      .all() as { alias: string; project_id: string }[]) {
      const name = row.alias.split('\u0000')[0];
      if (!repositories[row.project_id]?.includes(name))
        (repositories[row.project_id] ??= []).push(name);
    }
    return planNeoProjectQuestions(this.state(), fresh, repositories);
  }

  plan(fresh: Readonly<Record<string, readonly string[]>>): NeoProjectMergeInput[] {
    return planNeoProjectMerges(this.state(), fresh);
  }

  private state(): NeoProjectMergeState {
    const projects = this.db
      .prepare(`SELECT id, title, summary, context, revision,
      parent_id AS parentId, epic_url AS epicUrl, created_at AS createdAt, updated_at AS updatedAt
      FROM neo_concerns`)
      .all() as NeoProject[];
    const identities: Record<string, string[]> = {};
    for (const row of this.db
      .prepare(
        "SELECT alias, project_id FROM neo_project_workspaces WHERE alias LIKE 'git:%' OR alias LIKE 'repository:%'"
      )
      .all() as { alias: string; project_id: string }[])
      (identities[row.project_id] ??= []).push(row.alias);
    const repositories: Record<string, string[]> = {};
    for (const row of this.db
      .prepare(
        "SELECT alias, project_id FROM neo_project_workspaces WHERE alias >= 'repo' AND alias < 'repp'"
      )
      .all() as { alias: string; project_id: string }[]) {
      const repository = row.alias.startsWith('repository:')
        ? row.alias
        : row.alias.startsWith('repo:')
          ? `repository:github.com/${row.alias.slice('repo:'.length).split('\u0000')[0]}`
          : null;
      if (repository && !repositories[row.project_id]?.includes(repository))
        (repositories[row.project_id] ??= []).push(repository);
    }
    const unavailable = new Set<string>();
    for (const row of this.db
      .prepare(`SELECT b.concern_id AS id FROM neo_session_bindings b
      JOIN sessions s ON s.id = b.session_id WHERE b.kind = 'project'
      AND s.processing_state IS NOT NULL AND
      (NOT json_valid(s.processing_state) OR json_extract(s.processing_state, '$.status') IS NOT 'idle')`)
      .all() as { id: string }[])
      unavailable.add(row.id);
    for (const [table, condition] of [['legacy_neo_asks', "status IN ('waiting', 'blocked')"]]) {
      for (const row of this.db
        .prepare(`SELECT DISTINCT concern_id AS id FROM ${table} WHERE ${condition}`)
        .all() as { id: string }[])
        unavailable.add(row.id);
    }
    return {
      projects,
      identities,
      repositories,
      unavailable: [...unavailable],
      retired: (
        this.db.prepare('SELECT source_id FROM neo_project_merges').all() as { source_id: string }[]
      ).map((row) => row.source_id),
    };
  }

  merge(input: NeoProjectMergeInput): NeoProjectMergeResult {
    const result = this.db.transaction(() =>
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
          for (const table of ['legacy_neo_asks', 'neo_work'])
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
    if (result.ok) this.notify();
    return result;
  }
}
