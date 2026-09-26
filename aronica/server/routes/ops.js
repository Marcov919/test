// Ops API (internal): live state, ranking explained, verification, reliability
// actions, demo controls (clock, simulated no-show), API keys, event stream.
// Protected by ARONICA_OPS_TOKEN when set (header X-Ops-Token or ?ops_token=).
import { get, all, update, insert, getSetting, setSetting } from '../../core/db.js';
import { evaluate, enforce } from '../../core/reliability.js';
import { rankCandidates, WEIGHTS, WEIGHT_LABELS_IT } from '../../core/matching.js';
import { serializeJob, loadJob } from '../../core/jobs.js';
import { markNoShow, tick } from '../../core/dispatch.js';
import { openSse, eventsSince, recentEvents, lastSeq, emit } from '../../core/events.js';
import { HttpError, clock, id, iso, token } from '../../core/util.js';
import { json, parseJson, safeEq } from '../http.js';
import { advanceClock } from '../runtime.js';

export function requireOps(req, url) {
  const need = process.env.ARONICA_OPS_TOKEN;
  if (!need) return;
  const got = req.headers['x-ops-token'] || url.searchParams.get('ops_token');
  if (!safeEq(String(got ?? ''), need)) throw new HttpError(401, 'unauthorized', 'Ops token required');
}

async function opsState() {
  const workers = await Promise.all((await all('SELECT * FROM workers ORDER BY status, display_name')).map(async (w) => {
    const ev = await evaluate(w);
    return {
      id: w.id, kind: w.kind, display_name: w.display_name, zone: w.zone, lat: w.lat, lng: w.lng, vehicle: w.vehicle,
      skills: w.skills, online: !!w.online, verified: !!w.verified, status: w.status, tier: ev.tier, reasons: ev.reasons,
      rating: ev.rating.raw_avg, rating_bayes: ev.rating.bayes_avg, ratings: ev.rating.count,
      completion: ev.metrics.completion, acceptance: ev.metrics.acceptance, active_jobs: ev.metrics.active_jobs,
      capacity: w.capacity, avatar_color: w.avatar_color, simulated: !!w.simulated, no_shows: w.no_shows, jobs_completed: w.jobs_completed,
      app_live: !!(w.app_seen_at && Math.abs(clock.now() - w.app_seen_at) < 30_000),
    };
  }));
  const jobs = await Promise.all((await all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 40')).map((j) => serializeJob(j)));
  const offers = (await all('SELECT o.*, w.display_name FROM offers o JOIN workers w ON w.id = o.worker_id ORDER BY o.created_at DESC LIMIT 40'))
    .map((o) => ({ ...o, created_at: iso(o.created_at), expires_at: iso(o.expires_at), responded_at: iso(o.responded_at) }));
  const accounts = (await all('SELECT id, name, kind, api_key, created_at FROM accounts WHERE api_key IS NOT NULL'))
    .map((a) => ({ ...a, api_key: a.api_key.slice(0, 6) + '…' + a.api_key.slice(-4), created_at: iso(a.created_at) }));
  const assignments = (await all('SELECT a.*, w.display_name, j.title FROM assignments a JOIN workers w ON w.id = a.worker_id JOIN jobs j ON j.id = a.job_id ORDER BY a.assigned_at DESC LIMIT 40'))
    .map((a) => ({ id: a.id, job_id: a.job_id, title: a.title, worker: a.display_name, crew: a.crew, status: a.status, contract: a.contract?.label_it, payout_cents: a.payout_cents, assigned_via: a.assigned_via }));
  const next = await get("SELECT MIN(slot_start) AS t FROM jobs WHERE status IN ('assigned','dispatching','in_progress') AND slot_start > ?", clock.now());
  return {
    workers, jobs, offers, accounts, assignments,
    clock: { now: iso(clock.now()), offset_ms: clock.offset(), next_slot: iso(next?.t ?? null) },
    events: await recentEvents(60),
    settings: { offer_ttl_s: await getSetting('offer_ttl_s', 20), simulate_workers: await getSetting('simulate_workers', true), sim_speedup: await getSetting('sim_speedup', 30) },
  };
}

export function opsRoutes(r) {
  const guard = (fn) => async (ctx) => { requireOps(ctx.req, ctx.url); return fn(ctx); };
  r.get('/api/ops/state', guard(async ({ res }) => json(res, 200, await opsState())));
  r.post('/api/ops/workers/:id/:action', guard(async ({ res, params }) => {
    const w = await get('SELECT * FROM workers WHERE id = ?', params.id);
    if (!w) throw new HttpError(404, 'not_found', 'Worker not found');
    if (params.action === 'verify') {
      await update('workers', w.id, { verified: 1, status: 'active', verification_note: w.kind === 'business' ? 'P.IVA verificata da ops (stub KYB)' : 'Documento verificato da ops (stub KYC)' });
      await emit('worker.verified', { worker_id: w.id });
    } else if (params.action === 'reinstate') {
      // Ops review after suspension: reset the counters that triggered it.
      await update('workers', w.id, { status: 'active', no_shows: 0, tier: 'good', tier_reasons: [] });
      await emit('worker.reinstated', { worker_id: w.id });
      await enforce(w.id);
      const after = await get('SELECT status FROM workers WHERE id = ?', w.id);
      if (after.status === 'suspended') await update('workers', w.id, { status: 'active', tier: 'warning' });
    } else if (params.action === 'toggle-online') {
      if (!w.online && (w.status !== 'active' || !w.verified)) throw new HttpError(409, 'not_allowed', 'Worker not active/verified');
      await update('workers', w.id, { online: w.online ? 0 : 1 });
      await emit(w.online ? 'worker.offline' : 'worker.online', { worker_id: w.id, actor: 'ops' });
    } else throw new HttpError(404, 'not_found', 'Unknown action');
    json(res, 200, { ok: true });
  }));
  r.post('/api/ops/settings', guard(async ({ res, body }) => {
    const b = parseJson(body);
    if (b.offer_ttl_s != null) await setSetting('offer_ttl_s', Math.max(5, Math.min(120, Number(b.offer_ttl_s))));
    if (b.simulate_workers != null) await setSetting('simulate_workers', !!b.simulate_workers);
    if (b.sim_speedup != null) await setSetting('sim_speedup', Math.max(1, Math.min(120, Number(b.sim_speedup))));
    json(res, 200, (await opsState()).settings);
  }));
  r.post('/api/ops/keys', guard(async ({ res, body }) => {
    const b = parseJson(body);
    const name = String(b.name ?? 'Agent').slice(0, 60);
    const key = `ak_${token(18)}`;
    const kind = b.kind === 'business' ? 'business' : 'consumer';
    await insert('accounts', { id: id('acc'), name, kind, api_key: key, org: kind === 'business' ? { legal_name: name, employees: 5, auto_approve_max_cents: 30000 } : null, created_at: clock.now() });
    json(res, 201, { name, kind, api_key: key });
  }));
  // Demo time travel, shared by every server instance (stored in settings).
  r.post('/api/ops/clock', guard(async ({ res, body }) => {
    const b = parseJson(body);
    let ms = Number(b.advance_ms ?? 0);
    if (b.to === 'next_slot') {
      const next = await get("SELECT MIN(slot_start) AS t FROM jobs WHERE status IN ('assigned','dispatching','in_progress') AND slot_start > ?", clock.now());
      if (!next?.t) throw new HttpError(409, 'no_upcoming_slot', 'Nessun lavoro programmato in arrivo');
      ms = next.t - 40 * 60000 - clock.now();
    }
    if (!(ms > 0) || ms > 30 * 86400000) throw new HttpError(400, 'invalid_advance', 'advance_ms must be between 0 and 30 days');
    const offset = await advanceClock(ms);
    await emit('clock.changed', { data: { offset_ms: offset, now: iso(clock.now()) } });
    await tick();
    json(res, 200, { now: iso(clock.now()), offset_ms: offset });
  }));
  r.post('/api/ops/assignments/:id/no-show', guard(async ({ res, params }) => json(res, 200, await markNoShow(params.id, 'ops_simulated'))));
  // Why this partner: every partner, the filters that excluded them, the score breakdown.
  r.get('/api/ops/ranking', guard(async ({ res, url }) => {
    const jobId = url.searchParams.get('job') ?? (await get('SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1'))?.id;
    if (!jobId) return json(res, 200, { job: null, weights: WEIGHTS, labels_it: WEIGHT_LABELS_IT, rows: [] });
    const job = await loadJob(jobId);
    const { eligible, excluded } = await rankCandidates(job, { explain: true });
    const names = Object.fromEntries((await all('SELECT id, display_name, kind, zone FROM workers')).map((w) => [w.id, w]));
    const offers = Object.fromEntries((await all('SELECT worker_id, status FROM offers WHERE job_id = ? ORDER BY created_at', job.id)).map((o) => [o.worker_id, o.status]));
    const rows = [
      ...eligible.map((c) => ({ worker_id: c.worker.id, name: c.worker.display_name, kind: c.worker.kind, zone: c.worker.zone, rank: c.rank, score: c.score, breakdown: c.breakdown, distance_km: c.distance_km, rating: c.rating, offer: offers[c.worker.id] ?? null, excluded: null })),
      ...excluded.filter((e) => names[e.worker_id] && !e.reasons.includes('missing_service')).map((e) => ({ worker_id: e.worker_id, name: names[e.worker_id].display_name, kind: names[e.worker_id].kind, zone: names[e.worker_id].zone, rank: null, score: null, breakdown: null, offer: offers[e.worker_id] ?? null, excluded: e.reasons })),
    ];
    json(res, 200, { job: { id: job.id, title: job.title, status: job.status, service: job.service }, weights: WEIGHTS, labels_it: WEIGHT_LABELS_IT, rows, not_offering_service: excluded.filter((e) => e.reasons.includes('missing_service')).length });
  }));
  r.get('/api/ops/stream', guard(async ({ req, res, url }) => {
    const hdr = req.headers['last-event-id'] ?? url.searchParams.get('since');
    const since = hdr != null ? Number(hdr) : await lastSeq();
    return openSse(req, res, { since, fetch: (s) => eventsSince(s) });
  }));
}
