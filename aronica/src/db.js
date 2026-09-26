import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS services (
  code TEXT PRIMARY KEY,
  segment TEXT NOT NULL,            -- casa | business
  name_it TEXT NOT NULL,
  name_en TEXT NOT NULL,
  description TEXT NOT NULL,
  params TEXT NOT NULL,             -- json: typed parameter schema
  proof TEXT NOT NULL,              -- json: { kind: photos|timesheet, ... }
  instructions TEXT NOT NULL,       -- json
  keywords TEXT NOT NULL,           -- json
  flexible INTEGER NOT NULL DEFAULT 1,   -- start time can float inside the window
  multi_seat INTEGER NOT NULL DEFAULT 0, -- headcount > 1 (shifts)
  mentions_ok INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,               -- consumer | business
  api_key TEXT UNIQUE,
  org TEXT,                         -- json: business profile + approval policy
  created_at INTEGER NOT NULL
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
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  vehicle TEXT NOT NULL,
  skills TEXT NOT NULL,             -- json array of service codes
  skill_jobs TEXT NOT NULL,         -- json {service: completed count}
  availability TEXT NOT NULL,       -- json {dow: [[startMin, endMin], ...]} Europe/Rome
  min_hourly_cents INTEGER NOT NULL DEFAULT 1200,
  capacity INTEGER NOT NULL DEFAULT 1, -- crew size for businesses
  insured INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_note TEXT,
  status TEXT NOT NULL,             -- active | pending_verification | suspended
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
  service_notes TEXT,               -- json {service: how this partner does it}
  simulated INTEGER NOT NULL DEFAULT 0,
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
  excluded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
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
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  flexible INTEGER NOT NULL DEFAULT 0,
  slot_start INTEGER,
  duration_min INTEGER NOT NULL,
  headcount INTEGER NOT NULL DEFAULT 1,
  seats_filled INTEGER NOT NULL DEFAULT 0,
  price TEXT NOT NULL,              -- json quote (lines, surcharges, total, fee, payouts)
  max_price_cents INTEGER,
  status TEXT NOT NULL,
  status_message TEXT,
  confirm_token TEXT NOT NULL,
  approval TEXT,                    -- json {by: human|policy, at, rule}
  deal TEXT,                        -- json (chosen slot + lead supplier)
  dispatch_pool TEXT,
  dispatch_index INTEGER NOT NULL DEFAULT -1,
  escrow TEXT,
  invoice TEXT,
  negotiation_round INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  crew INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,             -- assigned | en_route | on_site | done | cancelled | no_show
  contract TEXT,                    -- json
  payout_cents INTEGER NOT NULL,
  assigned_via TEXT,
  assigned_at INTEGER NOT NULL,
  started_at INTEGER,
  arrived_at INTEGER,
  completed_at INTEGER,
  proof TEXT,
  buyer_rating INTEGER,
  worker_rating_of_buyer INTEGER
);
CREATE INDEX IF NOT EXISTS assignments_job ON assignments(job_id);
CREATE INDEX IF NOT EXISTS assignments_worker ON assignments(worker_id, status);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- accept | counter | decline
  slot_start INTEGER,
  seats INTEGER NOT NULL DEFAULT 1,
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
  seats INTEGER NOT NULL DEFAULT 1,
  payout_cents INTEGER NOT NULL,
  status TEXT NOT NULL,             -- pending | accepted | declined | expired | cancelled
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
  'skills', 'skill_jobs', 'tier_reasons', 'tags', 'instructions', 'proof_req', 'deal', 'params', 'price', 'approval',
  'dispatch_pool', 'escrow', 'proof', 'data', 'keywords', 'availability', 'org', 'contract', 'invoice', 'service_notes',
]);

export let db = null;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // additive migrations for databases created by older versions
  try { db.exec('ALTER TABLE workers ADD COLUMN service_notes TEXT'); } catch { /* already there */ }
  try { db.exec("ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'scheduled'"); } catch { /* already there */ }
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
