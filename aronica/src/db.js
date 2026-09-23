import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS skills (
  code TEXT PRIMARY KEY,
  name_it TEXT NOT NULL,
  name_en TEXT NOT NULL,
  description TEXT NOT NULL,
  base_price_cents INTEGER NOT NULL,
  typical_minutes INTEGER NOT NULL,
  default_proof TEXT NOT NULL,
  keywords TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'agent' | 'console'
  api_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'person' | 'business'
  display_name TEXT NOT NULL,
  legal_name TEXT,
  vat_id TEXT,
  bio TEXT,
  city TEXT NOT NULL,
  zone TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  vehicle TEXT NOT NULL,           -- walk | bike | scooter | car
  skills TEXT NOT NULL,            -- json array of skill codes
  skill_jobs TEXT NOT NULL,        -- json {skill: completed count}
  rate_multiplier REAL NOT NULL DEFAULT 1,
  capacity INTEGER NOT NULL DEFAULT 1,
  online INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_note TEXT,
  status TEXT NOT NULL,            -- active | pending_verification | suspended
  tier TEXT NOT NULL DEFAULT 'good',
  tier_reasons TEXT NOT NULL DEFAULT '[]',
  offers_received INTEGER NOT NULL DEFAULT 0,
  offers_accepted INTEGER NOT NULL DEFAULT 0,
  offers_declined INTEGER NOT NULL DEFAULT 0,
  offers_expired INTEGER NOT NULL DEFAULT 0,
  jobs_accepted INTEGER NOT NULL DEFAULT 0,
  jobs_completed INTEGER NOT NULL DEFAULT 0,
  jobs_cancelled INTEGER NOT NULL DEFAULT 0,
  no_shows INTEGER NOT NULL DEFAULT 0,
  earnings_cents INTEGER NOT NULL DEFAULT 0,
  avatar_color TEXT,
  simulated INTEGER NOT NULL DEFAULT 0, -- seed persona the demo simulator may drive
  token TEXT UNIQUE,
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  worker_id TEXT NOT NULL,
  stars INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  comment TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,  -- 1 = not the worker's fault, does not count
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ratings_worker ON ratings(worker_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  agent_name TEXT,
  city TEXT NOT NULL,
  skill TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  instructions TEXT NOT NULL,      -- json array
  proof_req TEXT NOT NULL,         -- json
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  deadline_at INTEGER NOT NULL,
  scheduled_at INTEGER,
  mode TEXT,                       -- now | schedule
  budget_target_cents INTEGER,
  budget_max_cents INTEGER,
  status TEXT NOT NULL,
  status_message TEXT,
  confirm_token TEXT NOT NULL,
  deal TEXT,                       -- json
  dispatch_pool TEXT,              -- json array of worker ids (ranked)
  dispatch_index INTEGER NOT NULL DEFAULT -1,
  assigned_worker_id TEXT,
  assigned_via TEXT,               -- 'app' (a human tapped Accetto) | 'sim'
  assigned_at INTEGER,
  started_at INTEGER,
  arrived_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  escrow TEXT,                     -- json
  proof TEXT,                      -- json
  buyer_rating INTEGER,
  worker_rating_of_buyer INTEGER,
  negotiation_round INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  buyer_offer_cents INTEGER,
  action TEXT NOT NULL,            -- counter | accept | reject
  price_cents INTEGER,
  eta_min INTEGER,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_job ON quotes(job_id, round);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  price_cents INTEGER NOT NULL,
  eta_min INTEGER,
  status TEXT NOT NULL,            -- pending | accepted | declined | expired | cancelled
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE INDEX IF NOT EXISTS offers_status ON offers(status, expires_at);
CREATE INDEX IF NOT EXISTS offers_worker ON offers(worker_id, status);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  worker_id TEXT,
  type TEXT NOT NULL,
  actor TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);
`;

const JSON_COLS = new Set([
  'skills', 'skill_jobs', 'tier_reasons', 'tags', 'instructions', 'proof_req', 'deal',
  'dispatch_pool', 'escrow', 'proof', 'data', 'default_proof', 'keywords',
]);

export let db = null;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
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

export const get = (sql, ...p) => decode(db.prepare(sql).get(...p.map(encode)));
export const all = (sql, ...p) => db.prepare(sql).all(...p.map(encode)).map(decode);
export const run = (sql, ...p) => db.prepare(sql).run(...p.map(encode));

export function insert(table, obj) {
  const keys = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map((k) => encode(obj[k])));
}

export function update(table, idValue, patch, idCol = 'id') {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
  return db.prepare(sql).run(...keys.map((k) => encode(patch[k])), idValue);
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
