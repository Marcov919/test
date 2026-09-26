// Event log. Every lifecycle step is persisted (agents replay via since_seq)
// and streamed to clients. There is no in-process fan-out: the server may be a
// fleet of short-lived serverless instances, so streams (SSE / long-poll) read
// new events from the database. The same code runs locally.
import { insert, all, get, run, update } from './db.js';
import { clock, iso, sleep } from './util.js';

const POLL_MS = Number(process.env.ARONICA_POLL_MS ?? 700);
const APP_LIVE_MS = 30_000; // a partner app heartbeat newer than this = a human holds the phone

// The server installs its throttled dispatch tick here: long-polls and streams
// keep the engine moving while someone is watching (no background process).
let idleHook = null;
export const setIdleHook = (fn) => { idleHook = fn; };

const toEvt = (e) => ({ seq: e.seq, type: e.type, job_id: e.job_id, worker_id: e.worker_id, actor: e.actor, data: e.data, at: iso(e.created_at) });

export async function emit(type, { job_id = null, worker_id = null, actor = 'platform', data = {} } = {}) {
  const created_at = clock.now();
  const seq = await insert('events', { job_id, worker_id, type, actor, data, created_at }, 'seq');
  return { seq: Number(seq), type, job_id, worker_id, actor, data, at: iso(created_at) };
}

export async function eventsForJob(jobId, sinceSeq = 0, limit = 500) {
  return (await all('SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', jobId, sinceSeq, limit)).map(toEvt);
}

export async function recentEvents(limit = 80) {
  return (await all("SELECT * FROM events WHERE type != 'worker.location' ORDER BY seq DESC LIMIT ?", limit)).map(toEvt);
}

// A job's stream also carries global clock changes (demo time travel).
export async function eventsForJobStream(jobId, sinceSeq, limit = 200) {
  return (await all("SELECT * FROM events WHERE seq > ? AND (job_id = ? OR type = 'clock.changed') ORDER BY seq LIMIT ?", sinceSeq, jobId, limit)).map(toEvt);
}

export async function eventsSince(sinceSeq, limit = 200) {
  return (await all('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', sinceSeq, limit)).map(toEvt);
}

// Events for a partner: addressed to them, or about a job they hold a seat on.
export async function eventsForWorker(workerId, sinceSeq, limit = 200) {
  return (await all(
    `SELECT e.* FROM events e WHERE e.seq > ? AND (e.worker_id = ? OR e.type = 'clock.changed' OR e.job_id IN (
       SELECT a.job_id FROM assignments a WHERE a.worker_id = ? AND a.status NOT IN ('cancelled','no_show')))
     ORDER BY e.seq LIMIT ?`, sinceSeq, workerId, workerId, limit,
  )).map(toEvt);
}

export async function lastSeq() {
  return Number((await get('SELECT COALESCE(MAX(seq), 0) AS s FROM events')).s);
}

// Long-poll: resolve when the job has events after sinceSeq, or on timeout.
// onIdle runs between polls (the server passes its throttled tick).
export async function waitForJobEvent(jobId, timeoutMs, { sinceSeq = null, onIdle = null } = {}) {
  const since = sinceSeq ?? await lastSeq();
  const until = Date.now() + timeoutMs;
  const idle = onIdle ?? idleHook;
  while (Date.now() < until) {
    if (idle) await idle();
    if (await get('SELECT 1 AS x FROM events WHERE job_id = ? AND seq > ? LIMIT 1', jobId, since)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

// Server-Sent Events over DB polling. `fetch(since)` returns events after a seq.
// Streams end after maxMs (serverless limit); EventSource reconnects with
// Last-Event-ID and resumes exactly where it stopped.
export async function openSse(req, res, { since = 0, fetch, backlog = [], onIdle = null, onBeat = null, maxMs = Number(process.env.ARONICA_SSE_MAX_MS ?? 55_000) }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  req.on('close', () => { closed = true; });
  const send = (evt) => res.write(`${evt.seq != null ? `id: ${evt.seq}\n` : ''}event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  res.write('retry: 1500\n\n');
  let cursor = since;
  for (const e of backlog) { send(e); cursor = Math.max(cursor, e.seq ?? 0); }
  const started = Date.now();
  let lastBeat = 0;
  const idle = onIdle ?? idleHook;
  while (!closed && Date.now() - started < maxMs) {
    try {
      if (idle) await idle();
      if (onBeat && Date.now() - lastBeat > 10_000) { lastBeat = Date.now(); await onBeat(); }
      const evts = await fetch(cursor);
      for (const e of evts) { send(e); cursor = Math.max(cursor, e.seq); }
      if (!evts.length) res.write(': ping\n\n');
    } catch (e) {
      console.error('sse', e.message);
    }
    await sleep(POLL_MS);
  }
  res.end();
}

// Is a real human holding this partner's app open? (If not, the optional
// simulator may answer on their behalf.) Heartbeat lives in the DB.
export async function workerHasLiveApp(workerId) {
  const w = await get('SELECT app_seen_at FROM workers WHERE id = ?', workerId);
  return !!(w?.app_seen_at && Math.abs(clock.now() - w.app_seen_at) < APP_LIVE_MS);
}

export async function touchWorkerApp(workerId) {
  await update('workers', workerId, { app_seen_at: clock.now() });
}

// Location pings are high-volume: keep only the last few minutes.
export async function pruneLocationEvents() {
  await run("DELETE FROM events WHERE type = 'worker.location' AND created_at < ?", clock.now() - 10 * 60000);
}
