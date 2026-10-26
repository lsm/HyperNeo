import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const TODO_META = `CASE
      WHEN new.next_action IS NULL THEN new.state
      ELSE new.state || ' ' || new.next_action
    END`;
const TODO_BODY = `CASE
      WHEN new.report IS NULL AND new.evidence IS NULL THEN NULL
      ELSE COALESCE(new.report, '') || ' ' || COALESCE(new.evidence, '')
    END`;
const QUESTION_ANSWER = `CASE
      WHEN new.answer IS NULL THEN NULL
      WHEN json_valid(new.answer) THEN json_extract(new.answer, '$')
      ELSE new.answer
    END`;

export function runMigration461(db: Database): void {
  if (!hasTable(db, 'neo_asks')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_card_search_content (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('ask', 'todo', 'question')),
      entity_id TEXT NOT NULL,
      ask_id TEXT NOT NULL,
      title TEXT,
      meta TEXT,
      body TEXT,
      updated_at INTEGER,
      UNIQUE (source, entity_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS neo_card_search_fts USING fts5(
      title,
      meta,
      body,
      content = 'neo_card_search_content',
      content_rowid = 'id',
      detail = column,
      tokenize = 'unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS neo_card_search_content_ai
    AFTER INSERT ON neo_card_search_content BEGIN
      INSERT INTO neo_card_search_fts(rowid, title, meta, body)
      VALUES (new.id, new.title, new.meta, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_content_ad
    AFTER DELETE ON neo_card_search_content BEGIN
      INSERT INTO neo_card_search_fts(neo_card_search_fts, rowid, title, meta, body)
      VALUES ('delete', old.id, old.title, old.meta, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_content_au
    AFTER UPDATE OF title, meta, body ON neo_card_search_content BEGIN
      INSERT INTO neo_card_search_fts(neo_card_search_fts, rowid, title, meta, body)
      VALUES ('delete', old.id, old.title, old.meta, old.body);
      INSERT INTO neo_card_search_fts(rowid, title, meta, body)
      VALUES (new.id, new.title, new.meta, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_ask_ai
    AFTER INSERT ON neo_asks BEGIN
      INSERT INTO neo_card_search_content (source, entity_id, ask_id, title, meta, body, updated_at)
      VALUES ('ask', new.id, new.id, new.title, new.request, new.outcome, new.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_ask_au
    AFTER UPDATE OF title, request, outcome, updated_at ON neo_asks BEGIN
      UPDATE neo_card_search_content
      SET title = new.title, meta = new.request, body = new.outcome, updated_at = new.updated_at
      WHERE source = 'ask' AND entity_id = new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_ask_ad
    AFTER DELETE ON neo_asks BEGIN
      DELETE FROM neo_card_search_content WHERE source = 'ask' AND entity_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_todo_ai
    AFTER INSERT ON neo_todos BEGIN
      INSERT INTO neo_card_search_content (source, entity_id, ask_id, title, meta, body, updated_at)
      VALUES ('todo', new.id, new.ask_id, new.title, ${TODO_META}, ${TODO_BODY}, new.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_todo_au
    AFTER UPDATE OF title, state, next_action, report, evidence, updated_at ON neo_todos BEGIN
      UPDATE neo_card_search_content
      SET title = new.title, meta = ${TODO_META}, body = ${TODO_BODY}, updated_at = new.updated_at
      WHERE source = 'todo' AND entity_id = new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_todo_ad
    AFTER DELETE ON neo_todos BEGIN
      DELETE FROM neo_card_search_content WHERE source = 'todo' AND entity_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_question_ai
    AFTER INSERT ON neo_questions BEGIN
      INSERT INTO neo_card_search_content (source, entity_id, ask_id, title, meta, body, updated_at)
      VALUES ('question', new.id, new.ask_id, new.text, NULL, ${QUESTION_ANSWER}, new.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_question_au
    AFTER UPDATE OF text, answer, created_at ON neo_questions BEGIN
      UPDATE neo_card_search_content
      SET title = new.text, body = ${QUESTION_ANSWER}
      WHERE source = 'question' AND entity_id = new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS neo_card_search_question_ad
    AFTER DELETE ON neo_questions BEGIN
      DELETE FROM neo_card_search_content WHERE source = 'question' AND entity_id = old.id;
    END;
  `);
  const indexed = db.prepare('SELECT 1 AS present FROM neo_card_search_content LIMIT 1').get() as
    | { present: number }
    | undefined;
  if (indexed) return;
  db.exec(`
    INSERT INTO neo_card_search_content (source, entity_id, ask_id, title, meta, body, updated_at)
    SELECT 'ask', id, id, title, request, outcome, updated_at FROM neo_asks;
    INSERT INTO neo_card_search_content (source, entity_id, ask_id, title, meta, body, updated_at)
    SELECT
      'todo',
      id,
      ask_id,
      title,
      CASE WHEN next_action IS NULL THEN state ELSE state || ' ' || next_action END,
      CASE
        WHEN report IS NULL AND evidence IS NULL THEN NULL
        ELSE COALESCE(report, '') || ' ' || COALESCE(evidence, '')
      END,
      updated_at
    FROM neo_todos;
    INSERT INTO neo_card_search_content (source, entity_id, ask_id, title, meta, body, updated_at)
    SELECT
      'question',
      id,
      ask_id,
      text,
      NULL,
      CASE
        WHEN answer IS NULL THEN NULL
        WHEN json_valid(answer) THEN json_extract(answer, '$')
        ELSE answer
      END,
      created_at
    FROM neo_questions;
  `);
}
