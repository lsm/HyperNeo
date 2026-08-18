import { describe, expect, test } from 'bun:test';
import { validateSql } from '../../../../src/lib/db-query/sql-validator';

describe('validateSql — valid SELECT queries', () => {
  test('simple SELECT', () => {
    const result = validateSql('SELECT * FROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('SELECT with explicit columns', () => {
    const result = validateSql('SELECT id, name, status FROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('SELECT with WHERE clause', () => {
    const result = validateSql('SELECT * FROM tasks WHERE status = ?');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('SELECT with JOIN', () => {
    const result = validateSql(
      'SELECT t.id, s.name FROM tasks t JOIN sessions s ON t.session_id = s.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('SELECT with LEFT JOIN', () => {
    const result = validateSql(
      'SELECT * FROM tasks LEFT JOIN sessions ON tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('SELECT with RIGHT JOIN', () => {
    const result = validateSql(
      'SELECT * FROM tasks RIGHT JOIN sessions ON tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('SELECT with FULL JOIN', () => {
    const result = validateSql(
      'SELECT * FROM tasks FULL JOIN sessions ON tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('SELECT with FULL OUTER JOIN', () => {
    const result = validateSql(
      'SELECT * FROM tasks FULL OUTER JOIN sessions ON tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('SELECT with LEFT OUTER JOIN', () => {
    const result = validateSql(
      'SELECT * FROM tasks LEFT OUTER JOIN sessions ON tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('SELECT with multiple JOINs', () => {
    const result = validateSql(
      'SELECT * FROM tasks t INNER JOIN sessions s ON t.session_id = s.id LEFT JOIN rooms r ON s.room_id = r.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions', 'rooms']);
  });

  test('SELECT * FROM with no WHERE', () => {
    const result = validateSql('SELECT * FROM tasks');
    expect(result.valid).toBe(true);
  });

  test('SELECT 1 (no table ref)', () => {
    const result = validateSql('SELECT 1');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual([]);
  });

  test('mixed case', () => {
    const result = validateSql('select * FROM Tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('UPPERCASE SELECT', () => {
    const result = validateSql('SELECT * FROM TASKS');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('leading whitespace', () => {
    const result = validateSql('   SELECT * FROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('tabs and newlines', () => {
    const result = validateSql('\t\n  SELECT *\n  FROM tasks\n');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('unicode table name', () => {
    const result = validateSql('SELECT * FROM задачи');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['задачи']);
  });

  test('unicode column names', () => {
    const result = validateSql('SELECT имя, статус FROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('very long SQL string', () => {
    const columns = Array.from({ length: 500 }, (_, i) => `col${i}`).join(', ');
    const sql = `SELECT ${columns} FROM tasks WHERE id = ?`;
    const result = validateSql(sql);
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('lowercase join keywords', () => {
    const result = validateSql(
      'SELECT * FROM tasks left join sessions on tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('lowercase join prefix keywords', () => {
    const result = validateSql(
      'SELECT * FROM tasks inner join sessions on tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('lowercase full join', () => {
    const result = validateSql(
      'SELECT * FROM tasks full outer join sessions on tasks.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });
});

describe('validateSql — schema-qualified table names', () => {
  test('main.tasks extracts tasks as table ref', () => {
    const result = validateSql('SELECT * FROM main.tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('temp.tasks extracts tasks as table ref', () => {
    const result = validateSql('SELECT * FROM temp.tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('schema-qualified in JOIN', () => {
    const result = validateSql(
      'SELECT * FROM main.tasks JOIN temp.sessions ON tasks.id = sessions.task_id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('mix of qualified and unqualified', () => {
    const result = validateSql('SELECT * FROM main.tasks JOIN rooms ON tasks.room_id = rooms.id');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'rooms']);
  });
});

describe('validateSql — rejected statements', () => {
  const rejectedStatements = [
    'INSERT INTO tasks VALUES (1)',
    'UPDATE tasks SET status = ?',
    'DELETE FROM tasks WHERE id = ?',
    'DROP TABLE tasks',
    'ALTER TABLE tasks ADD COLUMN foo TEXT',
    'CREATE TABLE foo (id INTEGER)',
    'REPLACE INTO tasks VALUES (1)',
    'ATTACH DATABASE ? AS other',
    'PRAGMA journal_mode=WAL',
  ];

  for (const sql of rejectedStatements) {
    test(`rejects: ${sql.split(' ')[0]}`, () => {
      const result = validateSql(sql);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Only SELECT statements are allowed');
      expect(result.tableRefs).toEqual([]);
    });
  }

  test('rejects empty string', () => {
    const result = validateSql('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Empty SQL statement');
  });

  test('rejects whitespace-only string', () => {
    const result = validateSql('   \t\n  ');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Empty SQL statement');
  });

  test('rejects comments-only string', () => {
    const result = validateSql('-- just a comment');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Empty SQL statement');
  });

  test('rejects block-comment-only string', () => {
    const result = validateSql('/* just a comment */');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Empty SQL statement');
  });
});

describe('validateSql — semicolons rejected', () => {
  test('rejects semicolon at end', () => {
    const result = validateSql('SELECT * FROM tasks;');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Semicolons are not allowed (single statement only)');
  });

  test('rejects semicolon in middle', () => {
    const result = validateSql('SELECT * FROM tasks; DROP TABLE tasks');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Semicolons are not allowed (single statement only)');
  });

  test('allows semicolon inside string literal', () => {
    const result = validateSql("SELECT * FROM tasks WHERE description = 'step 1; step 2'");
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });
});

describe('validateSql — NULL byte rejection', () => {
  test('rejects NULL byte in SELECT', () => {
    const result = validateSql('SELECT * FROM tasks\0; DROP TABLE tasks');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('NULL byte in SQL is not allowed');
  });

  test('rejects NULL byte at start', () => {
    const result = validateSql('\0SELECT * FROM tasks');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('NULL byte in SQL is not allowed');
  });
});

describe('validateSql — comment stripping', () => {
  test('strips line comments', () => {
    const result = validateSql('SELECT * -- comment\nFROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('strips block comments', () => {
    const result = validateSql('SELECT/* comment */ * FROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('strips multi-line block comments', () => {
    const result = validateSql('SELECT * /*\n multi-line\n comment\n */FROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('strips comments before rejection check', () => {
    const result = validateSql('-- INSERT INTO\nSELECT * FROM tasks');
    expect(result.valid).toBe(true);
  });
});

describe('validateSql — CTE handling', () => {
  test('simple CTE — CTE name excluded from tableRefs', () => {
    const result = validateSql(
      'WITH counts AS (SELECT room_id, COUNT(*) AS n FROM sessions GROUP BY room_id) SELECT * FROM counts'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['sessions']);
    expect(result.tableRefs).not.toContain('counts');
  });

  test('CTE with JOIN — both CTE name excluded, real table included', () => {
    const result = validateSql(
      'WITH active AS (SELECT * FROM sessions WHERE status = ?) SELECT a.*, r.name FROM active a JOIN rooms r ON a.room_id = r.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['sessions', 'rooms']);
    expect(result.tableRefs).not.toContain('active');
  });

  test('multiple CTEs', () => {
    const result = validateSql(
      'WITH s AS (SELECT * FROM sessions), r AS (SELECT * FROM rooms) SELECT * FROM s JOIN r ON s.room_id = r.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['sessions', 'rooms']);
    expect(result.tableRefs).not.toContain('s');
    expect(result.tableRefs).not.toContain('r');
  });

  test('nested CTE references other CTE — only real tables extracted', () => {
    const result = validateSql(
      'WITH s AS (SELECT * FROM sessions), filtered AS (SELECT * FROM s WHERE status = ?) SELECT * FROM filtered'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['sessions']);
    expect(result.tableRefs).not.toContain('s');
    expect(result.tableRefs).not.toContain('filtered');
  });

  test('CTE with mixed case', () => {
    const result = validateSql('with MyCte As (select * from tasks) Select * from MyCte');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
    expect(result.tableRefs).not.toContain('mycte');
  });

  test('CTE with string literals containing parens', () => {
    const result = validateSql(
      `WITH parsed AS (SELECT substr(data, 1, instr(data, ')')) AS val FROM logs) SELECT * FROM parsed`
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['logs']);
    expect(result.tableRefs).not.toContain('parsed');
  });

  test('CTE with escaped quotes in string literal', () => {
    const result = validateSql(
      "WITH escaped AS (SELECT * FROM tasks WHERE name = 'O''Brien''s task') SELECT * FROM escaped"
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
    expect(result.tableRefs).not.toContain('escaped');
  });

  test('non-SELECT after WITH is rejected', () => {
    const result = validateSql('WITH x AS (SELECT 1) INSERT INTO tasks VALUES (1)');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Only SELECT statements are allowed');
  });
});

describe('validateSql — WITH RECURSIVE', () => {
  test('simple WITH RECURSIVE is accepted', () => {
    const result = validateSql(
      'WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n < 5) SELECT * FROM cnt'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual([]);
    expect(result.tableRefs).not.toContain('cnt');
  });

  test('WITH RECURSIVE with real table reference', () => {
    const result = validateSql(
      'WITH RECURSIVE hierarchy(id, name, depth) AS (SELECT id, name, 0 FROM rooms WHERE parent_id IS NULL UNION ALL SELECT r.id, r.name, h.depth + 1 FROM rooms r JOIN hierarchy h ON r.parent_id = h.id) SELECT * FROM hierarchy'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['rooms']);
    expect(result.tableRefs).not.toContain('hierarchy');
  });

  test('WITH RECURSIVE lowercase', () => {
    const result = validateSql('with recursive x as (select 1) select * from x');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual([]);
  });

  test('WITH RECURSIVE with multiple CTEs', () => {
    const result = validateSql(
      'WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n < 5), doubled AS (SELECT n * 2 AS val FROM cnt) SELECT * FROM doubled'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual([]);
    expect(result.tableRefs).not.toContain('cnt');
    expect(result.tableRefs).not.toContain('doubled');
  });
});

describe('validateSql — subqueries', () => {
  test('subquery in WHERE — table refs extracted', () => {
    const result = validateSql(
      'SELECT * FROM tasks WHERE session_id IN (SELECT id FROM sessions WHERE status = ?)'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('subquery in FROM — table refs extracted', () => {
    const result = validateSql('SELECT sub.* FROM (SELECT * FROM tasks WHERE status = ?) AS sub');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('nested subqueries — all table refs extracted', () => {
    const result = validateSql(
      `SELECT * FROM rooms WHERE id IN (SELECT room_id FROM sessions WHERE id IN (SELECT session_id FROM tasks WHERE status = ?))`
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['rooms', 'sessions', 'tasks']);
  });
});

describe('validateSql — string literal handling', () => {
  test('FROM/JOIN inside string literal not extracted as table ref', () => {
    const result = validateSql(
      "SELECT * FROM tasks WHERE description = 'results FROM other_table'"
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('JOIN keyword inside string literal not extracted', () => {
    const result = validateSql("SELECT * FROM tasks WHERE notes = '%LEFT JOIN sessions%'");
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('escaped quotes in string literals handled correctly', () => {
    const result = validateSql("SELECT * FROM tasks WHERE name = 'it''s a test'");
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('semicolon inside string literal allowed', () => {
    const result = validateSql("SELECT * FROM tasks WHERE description = 'step 1; step 2; step 3'");
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('FROM keyword in block comment not extracted', () => {
    const result = validateSql('SELECT * FROM tasks /* FROM other_table */');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });
});

describe('validateSql — edge cases', () => {
  test('duplicate table refs — deduplicated', () => {
    const result = validateSql('SELECT * FROM tasks t1 JOIN tasks t2 ON t1.id = t2.parent_id');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('table alias does not appear in tableRefs', () => {
    const result = validateSql('SELECT t.* FROM tasks t');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('CROSS JOIN', () => {
    const result = validateSql('SELECT * FROM tasks CROSS JOIN sessions');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('NATURAL JOIN', () => {
    const result = validateSql('SELECT * FROM tasks NATURAL JOIN sessions');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('subquery alias excluded from tableRefs', () => {
    const result = validateSql(
      'SELECT sub.id FROM (SELECT * FROM tasks) AS sub JOIN sessions ON sub.session_id = sessions.id'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks', 'sessions']);
  });

  test('ORDER BY, LIMIT preserved (no OFFSET)', () => {
    const result = validateSql('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 10');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('GROUP BY with HAVING', () => {
    const result = validateSql(
      'SELECT room_id, COUNT(*) AS n FROM sessions GROUP BY room_id HAVING n > 5'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['sessions']);
  });

  test('UNION queries rejected', () => {
    const result = validateSql('SELECT * FROM tasks UNION SELECT * FROM archived_tasks');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('UNION');
  });

  test('UNION ALL rejected', () => {
    const result = validateSql('SELECT * FROM tasks UNION ALL SELECT * FROM tasks');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('UNION');
  });

  test('INTERSECT rejected', () => {
    const result = validateSql('SELECT id FROM tasks INTERSECT SELECT id FROM goals');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('INTERSECT');
  });

  test('EXCEPT rejected', () => {
    const result = validateSql('SELECT id FROM tasks EXCEPT SELECT id FROM goals');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('EXCEPT');
  });
});

describe('validateSql — quoted identifiers rejected', () => {
  test('rejects double-quoted table name', () => {
    const result = validateSql('SELECT * FROM "tasks"');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Quoted identifiers');
  });

  test('rejects backtick-quoted table name', () => {
    const result = validateSql('SELECT * FROM `tasks`');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Quoted identifiers');
  });

  test('rejects double-quoted column in WHERE', () => {
    const result = validateSql('SELECT * FROM tasks WHERE "status" = ?');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Quoted identifiers');
  });

  test('double quotes inside string literals are allowed', () => {
    const result = validateSql('SELECT * FROM tasks WHERE name = \'say "hello"\'');
    expect(result.valid).toBe(true);
  });
});

describe('validateSql — OFFSET rejected', () => {
  test('rejects OFFSET clause', () => {
    const result = validateSql('SELECT * FROM tasks LIMIT 10 OFFSET 20');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('OFFSET');
  });

  test('rejects OFFSET without LIMIT', () => {
    const result = validateSql('SELECT * FROM tasks OFFSET 5');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('OFFSET');
  });

  test('allows OFFSET keyword inside string literal', () => {
    const result = validateSql("SELECT * FROM tasks WHERE notes = 'see OFFSET clause'");
    expect(result.valid).toBe(true);
  });
});

describe('validateSql — DISTINCT queries', () => {
  test('accepts SELECT DISTINCT', () => {
    const result = validateSql('SELECT DISTINCT status FROM tasks');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });

  test('accepts SELECT DISTINCT with WHERE', () => {
    const result = validateSql('SELECT DISTINCT room_id FROM tasks WHERE status = ?');
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
  });
});

describe('validateSql — CTE scope interaction edge cases', () => {
  test('CTE outer SELECT references only CTE alias — tableRefs contains only inner table', () => {
    const result = validateSql(
      'WITH in_scope_data AS (SELECT * FROM tasks WHERE room_id = ?) SELECT * FROM in_scope_data'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
    expect(result.tableRefs).not.toContain('in_scope_data');
  });

  test('CTE alias with same name as a real table — alias excluded, inner table extracted', () => {
    const result = validateSql(
      'WITH tasks AS (SELECT * FROM goals WHERE room_id = ?) SELECT * FROM tasks'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['goals']);
    expect(result.tableRefs).not.toContain('tasks');
  });

  test('multiple CTEs where outer SELECT only references CTE aliases — only inner tables extracted', () => {
    const result = validateSql(
      'WITH t1 AS (SELECT id FROM tasks), t2 AS (SELECT id FROM goals) SELECT t1.id, t2.id FROM t1 JOIN t2 ON 1=1'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toContain('tasks');
    expect(result.tableRefs).toContain('goals');
    expect(result.tableRefs).not.toContain('t1');
    expect(result.tableRefs).not.toContain('t2');
  });

  test('CTE body referencing another CTE — only original real table in tableRefs', () => {
    const result = validateSql(
      'WITH t1 AS (SELECT * FROM tasks), t2 AS (SELECT * FROM t1 WHERE status = ?) SELECT COUNT(*) AS n FROM t2'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
    expect(result.tableRefs).not.toContain('t1');
    expect(result.tableRefs).not.toContain('t2');
  });

  test('CTE with parameterized filter in body — tableRefs extracted correctly', () => {
    const result = validateSql(
      'WITH filtered AS (SELECT id, title FROM tasks WHERE status = ? AND priority = ?) SELECT * FROM filtered ORDER BY title'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
    expect(result.tableRefs).not.toContain('filtered');
  });

  test('aggregate query using CTE alias — tableRefs contains only inner table', () => {
    const result = validateSql(
      'WITH pending AS (SELECT * FROM tasks WHERE status = ?) SELECT COUNT(*) AS cnt FROM pending'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
    expect(result.tableRefs).not.toContain('pending');
  });

  test('CTE with GROUP BY in body — tableRefs extracted correctly', () => {
    const result = validateSql(
      'WITH counts AS (SELECT room_id, COUNT(*) AS n FROM tasks GROUP BY room_id) SELECT room_id, n FROM counts ORDER BY n DESC'
    );
    expect(result.valid).toBe(true);
    expect(result.tableRefs).toEqual(['tasks']);
    expect(result.tableRefs).not.toContain('counts');
  });
});
