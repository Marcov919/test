// Storage. One async API over three drivers:
//   sqlite   node:sqlite, local dev + fast tests (ARONICA_DB=path or :memory:)
//   postgres production (DATABASE_URL=postgres://…, e.g. Supabase via the pooler)
//   pglite   Postgres compiled to WASM, to test the Postgres dialect locally
// SQL is written once with `?` placeholders (rewritten to $n for Postgres).
// JSON columns are TEXT in both dialects and (de)serialised here.
// Transactions use AsyncLocalStorage so nested calls reuse the same client.
import { AsyncLocalStorage } from 'node:async_hooks';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,               -- consumer | business
  api_key TEXT UNIQUE,
  org TEXT,                         -- json: business profile + approval policy
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- person | business
  display_name TEXT NOT NULL,
  legal_name TEXT,
  vat_id TEXT,
  bio TEXT,
  city TEXT NOT NULL,
  zone TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  vehicle TEXT NOT NULL,
  skills TEXT NOT NULL,             -- json array of service codes
  skill_jobs TEXT NOT NULL,         -- json {service: completed count}
  availability TEXT NOT NULL,       -- json {dow: [[startMin, endMin], ...]} Europe/Rome
  min_hourly_cents BIGINT NOT NULL DEFAULT 1200,
  capacity BIGINT NOT NULL DEFAULT 1, -- crew size for businesses
  insured BIGINT NOT NULL DEFAULT 0,
  online BIGINT NOT NULL DEFAULT 0,
  verified BIGINT NOT NULL DEFAULT 0,
  verification_note TEXT,
  status TEXT NOT NULL,             -- active | pending_verification | suspended
  tier TEXT NOT NULL DEFAULT 'good',
  tier_reasons TEXT NOT NULL DEFAULT '[]',
  offers_received BIGINT NOT NULL DEFAULT 0,
  offers_accepted BIGINT NOT NULL DEFAULT 0,
  offers_declined BIGINT NOT NULL DEFAULT 0,
  offers_expired BIGINT NOT NULL DEFAULT 0,
  jobs_accepted BIGINT NOT NULL DEFAULT 0,
  jobs_completed BIGINT NOT NULL DEFAULT 0,
  jobs_cancelled BIGINT NOT NULL DEFAULT 0,
  no_shows BIGINT NOT NULL DEFAULT 0,
  earnings_cents BIGINT NOT NULL DEFAULT 0,
  avatar_color TEXT,
  service_notes TEXT,               -- json {service: how this partner does it}
  app_seen_at BIGINT,               -- last heartbeat from the partner app (a human is holding it)
  real_gps BIGINT NOT NULL DEFAULT 0, -- app streams device GPS (movement not simulated)
  simulated BIGINT NOT NULL DEFAULT 0,
  token TEXT UNIQUE,
  joined_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  worker_id TEXT NOT NULL,
  stars BIGINT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  comment TEXT,
  excluded BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ratings_worker ON ratings(worker_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  agent_name TEXT,
  city TEXT NOT NULL,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  request_text TEXT,
  params TEXT NOT NULL,
  instructions TEXT NOT NULL,
  proof_req TEXT NOT NULL,
  address TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  window_start BIGINT NOT NULL,
  window_end BIGINT NOT NULL,
  flexible BIGINT NOT NULL DEFAULT 0,
  slot_start BIGINT,
  duration_min BIGINT NOT NULL,
  headcount BIGINT NOT NULL DEFAULT 1,
  seats_filled BIGINT NOT NULL DEFAULT 0,
  price TEXT NOT NULL,              -- json quote (lines, surcharges, total, fee, payouts)
  max_price_cents BIGINT,
  status TEXT NOT NULL,
  status_message TEXT,
  confirm_token TEXT NOT NULL,
  approval TEXT,                    -- json {by: human|policy, at, rule}
  deal TEXT,                        -- json (chosen slot + lead supplier)
  dispatch_pool TEXT,
  dispatch_index BIGINT NOT NULL DEFAULT -1,
  escrow TEXT,
  invoice TEXT,
  negotiation_round BIGINT NOT NULL DEFAULT 0,
  negotiating_until BIGINT,         -- lock: a negotiation round is running
  mode TEXT NOT NULL DEFAULT 'scheduled', -- now (Adesso) | scheduled (Programma)
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  cancelled_at BIGINT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  crew BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL,             -- assigned | en_route | on_site | done | cancelled | no_show
  contract TEXT,                    -- json
  payout_cents BIGINT NOT NULL,
  assigned_via TEXT,
  assigned_at BIGINT NOT NULL,
  started_at BIGINT,
  arrived_at BIGINT,
  completed_at BIGINT,
  proof TEXT,
  buyer_rating BIGINT,
  worker_rating_of_buyer BIGINT
);
CREATE INDEX IF NOT EXISTS assignments_job ON assignments(job_id);
CREATE INDEX IF NOT EXISTS assignments_worker ON assignments(worker_id, status);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  round BIGINT NOT NULL,
  worker_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- accept | counter | decline
  slot_start BIGINT,
  seats BIGINT NOT NULL DEFAULT 1,
  eta_min BIGINT,
  message TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_job ON quotes(job_id, round);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  rank BIGINT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  seats BIGINT NOT NULL DEFAULT 1,
  payout_cents BIGINT NOT NULL,
  status TEXT NOT NULL,             -- pending | accepted | declined | expired | cancelled
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  responded_at BIGINT
);
CREATE INDEX IF NOT EXISTS offers_status ON offers(status, expires_at);
CREATE INDEX IF NOT EXISTS offers_worker ON offers(worker_id, status);

CREATE TABLE IF NOT EXISTS events (
  seq __SEQ_PK__,
  job_id TEXT,
  worker_id TEXT,
  type TEXT NOT NULL,
  actor TEXT,
  data TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);

CREATE TABLE IF NOT EXISTS media (   -- proof photos (base64); served at /media/:id
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
`;

const JSON_COLS = new Set([
  'skills', 'skill_jobs', 'tier_reasons', 'tags', 'instructions', 'proof_req', 'deal', 'params', 'price', 'approval',
  'dispatch_pool', 'escrow', 'proof', 'data', 'keywords', 'availability', 'org', 'contract', 'invoice', 'service_notes',
]);

let drv = null; // { kind, query(sql, params) -> { rows, count }, exec(sql), begin(fn), close() }
const txStore = new AsyncLocalStorage();

export const dialect = () => drv?.kind;
export const isPostgres = () => drv?.kind === 'postgres' || drv?.kind === 'pglite';

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function sqliteDriver(path) {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') {
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  let chain = Promise.resolve(); // serialise transactions on the single connection
  return {
    kind: 'sqlite',
    async query(sql, params) {
      const st = db.prepare(sql);
      if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: st.all(...params), count: null };
      const r = st.run(...params);
      return { rows: [], count: Number(r.changes) };
    },
    async exec(sql) { db.exec(sql); },
    begin(fn) {
      const run = chain.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try { const r = await fn(this); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
      });
      chain = run.catch(() => {});
      return run;
    },
    async close() { db.close(); },
  };
}

async function postgresDriver(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v));     // int8 (COUNT, SUM, BIGINT columns)
  pg.types.setTypeParser(1700, (v) => Number(v));   // numeric (AVG)
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.ARONICA_PG_POOL ?? 3),
    ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    idleTimeoutMillis: 10_000,
  });
  const q = async (client, sql, params) => {
    const r = await client.query(toPg(sql), params);
    return { rows: r.rows, count: r.rowCount };
  };
  return {
    kind: 'postgres',
    query: (sql, params) => q(pool, sql, params),
    async exec(sql) { await pool.query(sql); },
    async begin(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn({ query: (sql, params) => q(client, sql, params) });
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}

async function pgliteDriver() {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const db = new PGlite({ parsers: { [types.INT8]: (v) => Number(v), [types.NUMERIC]: (v) => Number(v) } });
  await db.waitReady;
  let chain = Promise.resolve();
  const q = async (conn, sql, params) => {
    const r = await conn.query(toPg(sql), params);
    return { rows: r.rows, count: r.affectedRows ?? null };
  };
  return {
    kind: 'pglite',
    query: (sql, params) => q(db, sql, params),
    async exec(sql) { await db.exec(sql); },
    begin(fn) {
      const run = chain.then(() => db.transaction((t) => fn({ query: (sql, params) => q(t, sql, params) })));
      chain = run.catch(() => {});
      return run;
    },
    async close() { await db.close(); },
  };
}

// url: 'postgres://…' | 'pglite:' | a SQLite path | ':memory:'
export async function openDb(url = ':memory:') {
  if (drv) await drv.close().catch(() => {});
  if (/^postgres(ql)?:/.test(url)) {
    // Several candidates may be given separated by "|" (e.g. two pooler hosts):
    // the first one that answers wins.
    let lastErr = null;
    for (const candidate of url.split('|').map((x) => x.trim()).filter(Boolean)) {
      const d = await postgresDriver(candidate);
      try { await d.query('SELECT 1', []); drv = d; break; } catch (e) { lastErr = e; await d.close().catch(() => {}); }
    }
    if (!drv) throw lastErr ?? new Error('No database URL');
  } else drv = url.startsWith('pglite') ? await pgliteDriver() : await sqliteDriver(url);
  await migrate();
  return drv;
}

export async function closeDb() { if (drv) { await drv.close(); drv = null; } }

export const schemaSql = (dialect = 'postgres') => SCHEMA.replace('__SEQ_PK__', dialect === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGSERIAL PRIMARY KEY');

async function migrate() {
  const pgLike = drv.kind !== 'sqlite';
  await drv.exec(SCHEMA.replace('__SEQ_PK__', pgLike ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'));
  // additive migrations for databases created by older versions
  const add = [
    ['workers', 'service_notes TEXT'], ['workers', 'app_seen_at BIGINT'], ['workers', 'real_gps BIGINT NOT NULL DEFAULT 0'],
    ['jobs', "mode TEXT NOT NULL DEFAULT 'scheduled'"], ['jobs', 'negotiating_until BIGINT'],
  ];
  for (const [t, col] of add) {
    if (pgLike) await drv.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${col}`);
    else { try { await drv.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* already there */ } }
  }
}

function decode(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of Object.keys(out)) {
    if (JSON_COLS.has(k) && typeof out[k] === 'string') {
      try { out[k] = JSON.parse(out[k]); } catch { /* leave as string */ }
    }
  }
  return out;
}

function encode(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function conn() {
  if (!drv) throw new Error('Database not opened');
  return txStore.getStore() ?? drv;
}
const q = (sql, p) => conn().query(sql, p.map(encode));

export async function get(sql, ...p) { return decode((await q(sql, p)).rows[0]); }
export async function all(sql, ...p) { return (await q(sql, p)).rows.map(decode); }
// Returns the number of affected rows (use it for compare-and-set updates).
export async function run(sql, ...p) { return (await q(sql, p)).count; }

export async function insert(table, obj, returning = null) {
  const keys = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})${returning ? ` RETURNING ${returning}` : ''}`;
  const r = await q(sql, keys.map((k) => obj[k]));
  return returning ? r.rows[0]?.[returning] : r.count;
}

export async function update(table, idValue, patch, idCol = 'id') {
  const keys = Object.keys(patch);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
  return (await q(sql, [...keys.map((k) => patch[k]), idValue])).count;
}

// Run fn inside a transaction; nested calls join the outer one.
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  return drv.begin((client) => txStore.run(client, fn));
}

export async function exec(sql) { return drv.exec(sql); }

export async function getSetting(key, fallback) {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}

export async function setSetting(key, value) {
  await run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// Row lock inside a transaction (Postgres); SQLite already serialises writers.
export async function lockRow(table, idValue) {
  if (drv.kind === 'sqlite') return get(`SELECT * FROM ${table} WHERE id = ?`, idValue);
  return get(`SELECT * FROM ${table} WHERE id = ? FOR UPDATE`, idValue);
}

// Multi-row insert (seed data over a network connection).
export async function insertMany(table, rows, chunk = 200) {
  if (!rows.length) return 0;
  const keys = Object.keys(rows[0]);
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES ${part.map(() => `(${keys.map(() => '?').join(',')})`).join(',')}`;
    n += (await q(sql, part.flatMap((r) => keys.map((k) => r[k])))).count ?? 0;
  }
  return n;
}
