/*
  A D1Database stand-in over a node:sqlite file (prepare / bind / all / run),
  for Node code that builds SQL the way the Worker does. `e9core setup`
  builds the schema it loads into D1 with this, so a remote setup needs no
  knex or better-sqlite3.
*/
import { DatabaseSync } from 'node:sqlite';

export function sqliteD1(file) {
  const db = new DatabaseSync(file);
  return {
    db,
    close: () => db.close(),
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...values) {
          args = values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
          return stmt;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async first() {
          return db.prepare(sql).get(...args) ?? null;
        },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        }
      };
      return stmt;
    }
  };
}
