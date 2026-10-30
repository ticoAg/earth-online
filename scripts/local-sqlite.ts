/** Local SQLite adapter. Not imported by Workers; D1 uses its native prepare/batch API. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlDatabase, SqlStatement, SqlResult, SqlValue } from '../src/db/repository.ts';

class LocalStatement implements SqlStatement {
  constructor(readonly sql: string, readonly params: SqlValue[] = []) {}
  bind(...values: SqlValue[]): LocalStatement { return new LocalStatement(this.sql, values); }
}

export function openLocalDatabase(filename: string): SqlDatabase & { migrate(): void; close(): void } {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  return {
    prepare(sql: string): LocalStatement { return new LocalStatement(sql); },
    async batch(statements: LocalStatement[]): Promise<SqlResult[]> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(query => {
          const compiled = db.prepare(query.sql);
          if (/^\s*SELECT\b/i.test(query.sql)) {
            return { results: compiled.all(...query.params) as Record<string, unknown>[], meta: { changes: 0 } };
          }
          const result = compiled.run(...query.params);
          return { results: [], meta: { changes: Number(result.changes) } };
        });
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    migrate(): void {
      const sql = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
      db.exec(sql);
    },
    close(): void { db.close(); }
  };
}
