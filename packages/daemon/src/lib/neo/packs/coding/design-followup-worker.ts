import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';

export class CodingDesignFollowupRepository {
  constructor(private readonly db: Database) {}

  candidates(askId: string | null = null) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pack_coding_todo_prs'"
        )
        .get()
    )
      return [];
    return this.db
      .prepare(`SELECT a.id AS askId, a.title, t.id AS todoId, p.prs_json AS prs
      FROM neo_asks a JOIN neo_todos t ON t.ask_id = a.id
      JOIN pack_coding_todo_prs p ON p.todo_id = t.id
      WHERE a.status = 'open' AND (?1 IS NULL OR a.id = ?1)
        AND t.state <> 'removed'
        AND NOT EXISTS (SELECT 1 FROM neo_todos later WHERE later.ask_id = a.id
          AND later.position > t.position AND later.state <> 'removed')`)
      .all(askId) as {
      askId: string;
      title: string;
      todoId: string;
      prs: string;
    }[];
  }

  gaps(askId: string | null = null) {
    return this.candidates(askId).flatMap(({ prs, ...row }) =>
      (JSON.parse(prs) as NeoWorkPr[]).flatMap((pr) =>
        pr.state === 'MERGED' && pr.files?.some((path) => path.startsWith('docs/design/'))
          ? [
              {
                ...row,
                url: pr.url,
                head: pr.head,
                files: pr.files.filter((path) => path.startsWith('docs/design/')),
              },
            ]
          : []
      )
    );
  }

  settlementRefusal(askId: string): string | null {
    if (
      this.candidates(askId).some((row) =>
        (JSON.parse(row.prs) as NeoWorkPr[]).some((pr) => pr.state === 'MERGED' && !pr.files)
      )
    )
      return 'design_scope_unknown: refresh the merged PR changed paths before completing this ask.';
    const missing = this.gaps(askId);
    return missing.length
      ? `design_followup_required: ${missing.map((row) => row.url).join(', ')} merged without a later todo. Add the follow-up PR todos from the design's Change section before completing this ask.`
      : null;
  }
}

export const codingDesignFollowupReads = defineRepositoryOp(
  'coding.designFollowup.reads',
  'read',
  CodingDesignFollowupRepository,
  ['candidates', 'gaps']
);
