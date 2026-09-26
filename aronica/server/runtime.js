// Runtime for a stateless fleet (Vercel functions) that also works as a single
// local process:
//  - the database is opened once per instance and seeded if empty;
//  - the demo clock offset lives in settings and is applied per request;
//  - the dispatch loop (offer expiry, cascade, no-shows, simulator) runs
//    "on demand": after requests, inside open streams, and from a cron ping.
//    A compare-and-set on settings guarantees one tick at a time fleet-wide.
import { join } from 'node:path';
import { openDb, run, getSetting, setSetting } from '../core/db.js';
import { seed } from '../core/seed.js';
import { tick } from '../core/dispatch.js';
import { moveWorkers, runBots } from '../core/sim.js';
import { pruneLocationEvents } from '../core/events.js';
import { clock } from '../core/util.js';

export const TICK_EVERY_MS = Number(process.env.ARONICA_TICK_MS ?? 1500);

let ready = null;
export function dbUrl() {
  return process.env.DATABASE_URL || process.env.ARONICA_DB || join(process.cwd(), 'data', 'aronica.db');
}

// Open + migrate + seed, once per instance.
export function ensureReady(url = dbUrl()) {
  if (!ready) {
    ready = (async () => {
      await openDb(url);
      const seeded = await seed();
      await run("INSERT INTO settings(key, value) VALUES('last_tick', '0') ON CONFLICT(key) DO NOTHING");
      return { seeded };
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
export function resetReady() { ready = null; }

export async function syncClock() {
  clock.setOffset(await getSetting('clock_offset_ms', 0));
}

export async function advanceClock(ms) {
  const next = (await getSetting('clock_offset_ms', 0)) + ms;
  await setSetting('clock_offset_ms', next);
  clock.setOffset(next);
  return next;
}

let localLast = 0;
let prunedAt = 0;
// Run the dispatch loop if nobody in the fleet ran it in the last TICK_EVERY_MS.
export async function maybeTick() {
  const now = Date.now();
  if (now - localLast < TICK_EVERY_MS) return false;
  localLast = now;
  const won = await run("UPDATE settings SET value = ? WHERE key = 'last_tick' AND CAST(value AS BIGINT) < ?", String(now), now - TICK_EVERY_MS);
  if (!won) return false;
  try {
    await syncClock();
    await tick();
    await moveWorkers();
    await runBots();
    if (now - prunedAt > 60_000) { prunedAt = now; await pruneLocationEvents(); }
  } catch (e) {
    console.error('tick error', e);
  }
  return true;
}

// Local single process: a plain interval.
export function startLoop() {
  const h = setInterval(() => { maybeTick(); }, TICK_EVERY_MS);
  return () => clearInterval(h);
}
