// Event log + fan-out. Every lifecycle step is persisted (agents can replay via
// since_seq) and pushed live to SSE subscribers (buyer console, worker app, ops).
import { insert, all, db } from './db.js';
import { clock, iso } from './util.js';

const subscribers = new Set(); // { filter(evt) -> bool, send(evt), workerId? }
const waiters = new Set(); // long-poll resolvers

// Location pings are high-frequency: broadcast but don't persist.
const EPHEMERAL = new Set(['worker.location']);

export function emit(type, { job_id = null, worker_id = null, actor = 'platform', data = {} } = {}) {
  const created_at = clock.now();
  let seq = null;
  if (!EPHEMERAL.has(type)) {
    const r = insert('events', { job_id, worker_id, type, actor, data, created_at });
    seq = Number(r.lastInsertRowid);
  }
  const evt = { seq, type, job_id, worker_id, actor, data, at: iso(created_at) };
  for (const s of subscribers) {
    try { if (s.filter(evt)) s.send(evt); } catch { /* dead socket, cleaned on close */ }
  }
  for (const w of waiters) if (w.jobId === job_id) w.resolve();
  return evt;
}

export function eventsForJob(jobId, sinceSeq = 0, limit = 500) {
  return all('SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', jobId, sinceSeq, limit)
    .map((e) => ({ seq: e.seq, type: e.type, job_id: e.job_id, worker_id: e.worker_id, actor: e.actor, data: e.data, at: iso(e.created_at) }));
}

export function recentEvents(limit = 80) {
  return all('SELECT * FROM events ORDER BY seq DESC LIMIT ?', limit)
    .map((e) => ({ seq: e.seq, type: e.type, job_id: e.job_id, worker_id: e.worker_id, actor: e.actor, data: e.data, at: iso(e.created_at) }));
}

export function waitForJobEvent(jobId, timeoutMs) {
  return new Promise((resolve) => {
    const w = { jobId, resolve: () => { clearTimeout(t); waiters.delete(w); resolve(); } };
    const t = setTimeout(w.resolve, timeoutMs);
    waiters.add(w);
  });
}

export function lastSeq() {
  return Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get().s);
}

// Server-Sent Events. `filter` decides which events a connection receives.
export function openSse(req, res, { filter, workerId = null, backlog = [] }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const send = (evt) => res.write(`id: ${evt.seq ?? ''}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  for (const e of backlog) send(e);
  const sub = { filter, send, workerId };
  subscribers.add(sub);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); subscribers.delete(sub); });
  return sub;
}

// Is a real human currently holding this worker's app open? (If not, the
// optional simulator may answer on their behalf.)
export function workerHasLiveApp(workerId) {
  for (const s of subscribers) if (s.workerId === workerId) return true;
  return false;
}

// Workers whose app is streaming real device GPS (movement is not simulated).
export const realGps = new Set();
