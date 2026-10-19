import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';

export const NEO_MCP_SNAPSHOT_BUDGET = 40_000;
const TRIMMED_TEXT_LIMIT = 300;
const TRIMMED_NOTE_RESERVE = 512;
const SKELETON_LIST_LIMIT = 20;
const NEO_SNAPSHOT_TRIMMED =
  'This snapshot was trimmed to fit: settled asks are left out, and long text is cut.';
const NEO_SNAPSHOT_SKELETON =
  'This snapshot was too large even trimmed, so only open asks and project identities are left.';

export function neoSnapshotTrimmedNote(droppedOpen: number): string {
  return droppedOpen > 0
    ? `${NEO_SNAPSHOT_TRIMMED} ${droppedOpen} older open ${droppedOpen === 1 ? 'ask is' : 'asks are'} also left out; this is not every open ask.`
    : NEO_SNAPSHOT_TRIMMED;
}

export function neoSnapshotOmitted<T extends NeoSnapshot>(fitted: T, built: NeoSnapshot): T {
  const { omitted: _omitted, ...rest } = fitted;
  const asks =
    (built.omitted?.asks ?? 0) + (built.todoAsks?.length ?? 0) - (fitted.todoAsks?.length ?? 0);
  return (asks ? { ...rest, omitted: { asks } } : rest) as T;
}

const size = (snapshot: NeoSnapshot) => Buffer.byteLength(JSON.stringify(snapshot), 'utf8');

function withTodoText(snapshot: NeoSnapshot, limit: number): NeoSnapshot {
  const cut = (text: string | null) => (text === null ? null : text.slice(0, limit));
  return {
    ...snapshot,
    todoAsks: snapshot.todoAsks?.map((entry) => ({
      ...entry,
      ask: { ...entry.ask, request: entry.ask.request.slice(0, limit) },
      todos: entry.todos.map((todo) => ({
        ...todo,
        instruction: cut(todo.instruction),
        report: cut(todo.report),
        evidence: cut(todo.evidence),
      })),
      questions: entry.questions.map((question) => ({
        ...question,
        text: question.text.slice(0, Math.max(limit, 80)),
      })),
    })),
  };
}

function withShortText(snapshot: NeoSnapshot): NeoSnapshot {
  return {
    ...snapshot,
    sessionLoad: [],
    working: [],
    sessionNoticeGroups: snapshot.sessionNoticeGroups?.slice(0, 1),
    projects: snapshot.projects.map((project) => ({
      ...project,
      summary: project.summary.slice(0, TRIMMED_TEXT_LIMIT),
      context: project.context.slice(0, TRIMMED_TEXT_LIMIT),
    })),
  };
}

function withBareText(snapshot: NeoSnapshot): NeoSnapshot {
  return {
    ...snapshot,
    sessionNoticeGroups: [],
    projects: snapshot.projects.map((project) => ({ ...project, summary: '', context: '' })),
  };
}

export function fitNeoSnapshotBudget<T extends NeoSnapshot>(snapshot: T, budget: number): T {
  if (size(snapshot) <= budget) return snapshot;
  const room = budget - TRIMMED_NOTE_RESERVE;
  const open = snapshot.todoAsks?.filter((entry) => entry.ask.status === 'open') ?? [];
  let fitted: NeoSnapshot = { ...snapshot, todoAsks: open };
  if (size(fitted) > room) fitted = withTodoText(withShortText(fitted), TRIMMED_TEXT_LIMIT);
  for (let count = fitted.todoAsks?.length ?? 0; size(fitted) > room && count > 1; )
    fitted = { ...fitted, todoAsks: fitted.todoAsks?.slice(0, (count = Math.floor(count / 2))) };
  for (
    let count = Math.max(0, ...(fitted.packRows ?? []).map((item) => item.rows.length));
    size(fitted) > room && count > 1;
  ) {
    count = Math.floor(count / 2);
    const keep = count;
    fitted = {
      ...fitted,
      packRows: fitted.packRows?.map((item) => ({ ...item, rows: item.rows.slice(0, keep) })),
    };
  }
  if (size(fitted) > room) fitted = withTodoText(withBareText(fitted), 0);
  if (size(fitted) <= room)
    return {
      ...fitted,
      trimmed: neoSnapshotTrimmedNote(open.length - (fitted.todoAsks?.length ?? 0)),
    } as T;
  return {
    ok: true,
    sessionId: fitted.sessionId,
    projects: fitted.projects
      .slice(0, SKELETON_LIST_LIMIT)
      .map((project) => ({ ...project, summary: '', context: '' })),
    standingRules: fitted.standingRules,
    todoAsks: fitted.todoAsks,
    trimmed: NEO_SNAPSHOT_SKELETON,
  } as T;
}
