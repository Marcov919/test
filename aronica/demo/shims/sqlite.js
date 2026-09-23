// node:sqlite → sql.js (SQLite compiled to WebAssembly). Implements the small
// DatabaseSync surface the server uses: exec, prepare().get/all/run.
export class DatabaseSync {
  constructor() {
    if (!globalThis.__SQL) throw new Error('sql.js not initialised');
    this.db = new globalThis.__SQL.Database();
    this.cache = new Map();
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); this.cache.set(sql, stmt); }
    const bind = (p) => { stmt.reset(); if (p.length) stmt.bind(p.map((v) => (v === undefined ? null : v))); };
    return {
      get: (...p) => { bind(p); const row = stmt.step() ? stmt.getAsObject() : undefined; stmt.reset(); return row; },
      all: (...p) => { bind(p); const out = []; while (stmt.step()) out.push(stmt.getAsObject()); stmt.reset(); return out; },
      run: (...p) => {
        bind(p); stmt.step(); stmt.reset();
        const r = db.exec('SELECT last_insert_rowid() AS id, changes() AS c')[0].values[0];
        return { lastInsertRowid: r[0], changes: r[1] };
      },
    };
  }
}
