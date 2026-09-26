// Partner API v1: the supply-side app (people and small businesses).
// Auth: partner session token (demo login picks a seed profile; production =
// phone OTP). Every call is also the app's heartbeat, so the simulator knows a
// human is holding the phone and leaves that profile alone.
import { get, all, update, insert } from '../../core/db.js';
import { evaluate, THRESHOLDS } from '../../core/reliability.js';
import { loadJob, serializeJob, serializeAssignment } from '../../core/jobs.js';
import { respondOffer, startJob, arriveJob, submitProof, workerCancel, pendingOffersForWorker } from '../../core/dispatch.js';
import { listServices } from '../../core/services.js';
import { GAZETTEER, VEHICLES } from '../../core/geo.js';
import { openSse, eventsForWorker, lastSeq, emit, touchWorkerApp } from '../../core/events.js';
import { HttpError, clock, id, iso, token } from '../../core/util.js';
import { json, parseJson } from '../http.js';

export async function workerFromReq(req, url) {
  const t = req.headers['x-worker-token'] || url.searchParams.get('wt');
  const w = t ? await get('SELECT * FROM workers WHERE token = ?', String(t)) : null;
  if (!w) throw new HttpError(401, 'unauthorized', 'Sessione partner non valida');
  await touchWorkerApp(w.id);
  return w;
}

async function mine(w, statuses) {
  return all(`SELECT a.* FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.worker_id = ? AND a.status IN (${statuses.map(() => '?').join(',')}) ORDER BY j.slot_start`, w.id, ...statuses);
}

async function workerSelf(w) {
  const ev = await evaluate(w);
  const active = await Promise.all((await mine(w, ['assigned', 'en_route', 'on_site'])).map(async (a) => {
    const j = await loadJob(a.job_id);
    return { ...(await serializeJob(j)), assignment: await serializeAssignment(a, j), pay_cents: a.payout_cents };
  }));
  const history = await Promise.all((await mine(w, ['done', 'cancelled', 'no_show'])).slice(-20).reverse().map(async (a) => {
    const j = await loadJob(a.job_id);
    return { id: j.id, title: j.title, status: a.status, pay_cents: a.status === 'done' ? a.payout_cents : 0, completed_at: iso(a.completed_at ?? j.updated_at), buyer_rating: a.buyer_rating, contract: a.contract?.label_it };
  }));
  const reviews = await all('SELECT stars, tags, comment, excluded, created_at FROM ratings WHERE worker_id = ? AND job_id IS NOT NULL ORDER BY created_at DESC LIMIT 10', w.id);
  return {
    worker: {
      id: w.id, kind: w.kind, display_name: w.display_name, legal_name: w.legal_name, vat_id: w.vat_id, bio: w.bio,
      zone: w.zone, lat: w.lat, lng: w.lng, vehicle: w.vehicle, skills: w.skills, skill_jobs: w.skill_jobs, availability: w.availability,
      min_hourly_cents: w.min_hourly_cents, insured: !!w.insured, service_notes: w.service_notes,
      capacity: w.capacity, online: !!w.online, verified: !!w.verified, verification_note: w.verification_note,
      status: w.status, tier: w.tier, tier_reasons: w.tier_reasons, avatar_color: w.avatar_color,
      jobs_completed: w.jobs_completed, earnings_cents: w.earnings_cents, simulated: !!w.simulated, real_gps: !!w.real_gps,
    },
    reliability: {
      tier: ev.tier, reasons: ev.reasons,
      rating: ev.rating, completion: ev.metrics.completion, acceptance: ev.metrics.acceptance, cancel_rate: ev.metrics.cancel_rate,
      no_shows: w.no_shows, thresholds: THRESHOLDS,
    },
    active_jobs: active,
    offers: await pendingOffersForWorker(w.id),
    history,
    reviews: reviews.map((r) => ({ ...r, created_at: iso(r.created_at) })),
  };
}

export function partnerRoutes(r) {
  const P = '/partner/v1';
  r.get(`${P}/demo-profiles`, async ({ res }) => {
    json(res, 200, await all('SELECT id, kind, display_name, zone, status, tier, online, vehicle, skills, avatar_color, simulated FROM workers ORDER BY kind DESC, display_name'));
  });
  r.post(`${P}/login`, async ({ res, body }) => {
    // Demo login (no SMS provider yet): pick a profile. Production = phone OTP.
    const w = await get('SELECT id, token FROM workers WHERE id = ?', String(parseJson(body).worker_id ?? ''));
    if (!w) throw new HttpError(404, 'not_found', 'Partner non trovato');
    await touchWorkerApp(w.id);
    json(res, 200, { token: w.token });
  });
  r.post(`${P}/signup`, async ({ res, body }) => {
    const b = parseJson(body);
    const kind = b.kind === 'business' ? 'business' : 'person';
    const name = String(b.display_name ?? '').trim().slice(0, 60);
    if (name.length < 2) throw new HttpError(400, 'name_required', 'Inserisci un nome');
    if (kind === 'business' && !/^IT\d{11}$/.test(String(b.vat_id ?? '').replace(/\s/g, ''))) throw new HttpError(400, 'vat_required', 'Partita IVA non valida (formato IT + 11 cifre)');
    const place = GAZETTEER.find((g) => g.name === b.zone) ?? GAZETTEER[0];
    const codes = new Set(listServices().map((s) => s.code));
    const skills = (Array.isArray(b.skills) ? b.skills : []).filter((s) => codes.has(s));
    if (!skills.length) throw new HttpError(400, 'skills_required', 'Scegli almeno un servizio');
    const w = {
      id: id(kind === 'business' ? 'b' : 'w'), kind, display_name: name, legal_name: b.legal_name ? String(b.legal_name).slice(0, 120) : null,
      vat_id: kind === 'business' ? String(b.vat_id).replace(/\s/g, '') : null, bio: b.bio ? String(b.bio).slice(0, 200) : null,
      city: 'milano', zone: place.name, lat: place.lat, lng: place.lng, vehicle: VEHICLES[b.vehicle] ? b.vehicle : 'bike',
      skills, skill_jobs: {}, capacity: kind === 'business' ? Math.max(1, Math.min(20, Number(b.capacity ?? 2))) : 1,
      availability: Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [d, [[8 * 60, 20 * 60]]])), min_hourly_cents: 1200, insured: 0,
      online: 0, verified: 0, status: 'pending_verification', tier: 'good', tier_reasons: [], avatar_color: '#495057',
      simulated: 0, token: token(), joined_at: clock.now(), app_seen_at: clock.now(),
    };
    await insert('workers', w);
    await emit('worker.signed_up', { worker_id: w.id, data: { kind, display_name: name } });
    json(res, 201, { token: w.token });
  });
  r.get(`${P}/me`, async ({ req, res, url }) => json(res, 200, await workerSelf(await workerFromReq(req, url))));
  r.post(`${P}/online`, async ({ req, res, url, body }) => {
    const w = await workerFromReq(req, url);
    const online = !!parseJson(body).online;
    if (online && (w.status !== 'active' || !w.verified)) {
      throw new HttpError(409, 'not_allowed', w.status === 'suspended' ? 'Account sospeso: non puoi andare online' : 'Account in verifica: potrai andare online dopo la verifica');
    }
    await update('workers', w.id, { online: online ? 1 : 0 });
    await emit(online ? 'worker.online' : 'worker.offline', { worker_id: w.id });
    json(res, 200, { online });
  });
  r.post(`${P}/location`, async ({ req, res, url, body }) => {
    const w = await workerFromReq(req, url);
    const b = parseJson(body);
    if (b.real === false) { await update('workers', w.id, { real_gps: 0 }); return json(res, 200, { ok: true }); }
    const lat = Number(b.lat); const lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'invalid_location', 'lat/lng required');
    await update('workers', w.id, { lat, lng, real_gps: 1 });
    const a = await get("SELECT job_id FROM assignments WHERE worker_id = ? AND status IN ('en_route','on_site')", w.id);
    await emit('worker.location', { worker_id: w.id, job_id: a?.job_id ?? null, data: { lat, lng, simulated: false } });
    json(res, 200, { ok: true });
  });
  r.post(`${P}/offers/:id/:action`, async ({ req, res, url, params }) => {
    const w = await workerFromReq(req, url);
    if (!['accept', 'decline'].includes(params.action)) throw new HttpError(404, 'not_found', 'Not found');
    json(res, 200, await respondOffer(w.id, params.id, params.action === 'accept', { via: 'app' }));
  });
  // Proof photos arrive resized by the app; the host caps bodies at ~4.5 MB.
  r.post(`${P}/jobs/:id/:action`, async ({ req, res, url, params, body }) => {
    const w = await workerFromReq(req, url);
    const b = parseJson(body);
    const a = params.action;
    if (a === 'start') return json(res, 200, await startJob(w.id, params.id));
    if (a === 'arrive') return json(res, 200, await arriveJob(w.id, params.id));
    if (a === 'cancel') return json(res, 200, await workerCancel(w.id, params.id, b.reason));
    if (a === 'proof') return json(res, 200, await submitProof(w.id, params.id, { photos: b.photos, answers: b.answers }));
    if (a === 'rate-buyer') {
      const as = await get("SELECT * FROM assignments WHERE job_id = ? AND worker_id = ? AND status = 'done'", params.id, w.id);
      if (!as) throw new HttpError(409, 'invalid_state', 'Non valutabile');
      const s = Number(b.stars);
      if (!Number.isInteger(s) || s < 1 || s > 5) throw new HttpError(400, 'invalid_stars', '1..5');
      await update('assignments', as.id, { worker_rating_of_buyer: s });
      await emit('rating.buyer_rated', { job_id: params.id, worker_id: w.id, data: { stars: s } });
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not_found', 'Not found');
  }, { limit: 4_400_000 });
  r.get(`${P}/stream`, async ({ req, res, url }) => {
    const w = await workerFromReq(req, url);
    const hdr = req.headers['last-event-id'] ?? url.searchParams.get('since');
    const since = hdr != null ? Number(hdr) : await lastSeq();
    return openSse(req, res, { since, fetch: (s) => eventsForWorker(w.id, s), onBeat: () => touchWorkerApp(w.id) });
  });
}
