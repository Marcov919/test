// Dispatch: human confirm → timed offer to #1 → cascade → assigned → on site →
// proof → done. Uber, not lead-gen: once confirmed, the platform keeps offering
// until someone accepts or the pool is honestly exhausted.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, all, insert, update, tx, getSetting } from './db.js';
import { emit, realGps } from './events.js';
import { rankCandidates, scoreWorker, activeJobCount } from './matching.js';
import { getSkill } from './skills.js';
import { haversineKm } from './geo.js';
import { enforce } from './reliability.js';
import { ACTIVE, loadJob, publicWorker } from './jobs.js';
import { HttpError, clock, id, iso, token, eur, NO_SUPPLY_IT } from './util.js';

export const UPLOAD_DIR = () => process.env.ARONICA_UPLOADS || join(process.cwd(), 'data', 'uploads');
const offerTtlMs = () => getSetting('offer_ttl_s', 20) * 1000;

// ---- human confirm (Now / Schedule) --------------------------------------
export function confirmJob(jobId, { mode = 'now', scheduled_at = null } = {}) {
  const job = loadJob(jobId);
  if (job.status !== 'pending_confirmation') throw new HttpError(409, 'not_pending_confirmation', `Job is ${job.status}.`);
  const now = clock.now();
  if (job.deal.valid_until < now) {
    update('jobs', jobId, { status: 'expired', status_message: 'Accordo scaduto senza conferma.', updated_at: now });
    emit('job.expired', { job_id: jobId, data: { reason: 'deal_not_confirmed' } });
    throw new HttpError(409, 'deal_expired', 'The negotiated deal expired before confirmation.');
  }
  if (!['now', 'schedule'].includes(mode)) throw new HttpError(400, 'invalid_mode', 'mode must be "now" or "schedule"');
  const patch = { mode, updated_at: now };
  if (mode === 'schedule') {
    const at = scheduled_at ? Date.parse(scheduled_at) : NaN;
    if (Number.isNaN(at) || at < now + 15 * 60000) throw new HttpError(400, 'invalid_schedule', 'scheduled_at must be ≥ 15 minutes from now');
    if (at > now + 14 * 24 * 3600000) throw new HttpError(400, 'invalid_schedule', 'Scheduling is limited to 14 days ahead.');
    const skill = getSkill(job.skill);
    patch.scheduled_at = at;
    patch.deadline_at = Math.max(job.deadline_at, at + (skill.typical_minutes + 60) * 60000);
  }
  const updated = { ...job, ...patch };
  const pool = rankCandidates(updated).eligible.filter((c) => c.floor_cents <= job.deal.price_cents);
  if (!pool.length) {
    update('jobs', jobId, { ...patch, status: 'no_match', status_message: NO_SUPPLY_IT });
    emit('job.no_match', { job_id: jobId, data: { message: NO_SUPPLY_IT, stage: 'confirm' } });
    return loadJob(jobId);
  }
  update('jobs', jobId, {
    ...patch,
    status: 'dispatching',
    status_message: 'Cerco la persona giusta…',
    dispatch_pool: pool.map((c) => c.worker.id),
    dispatch_index: -1,
    escrow: { status: 'held', provider: 'stub', amount_cents: job.deal.price_cents, currency: 'EUR', ref: `esc_${token(6)}`, held_at: iso(now) },
  });
  emit('job.confirmed', { job_id: jobId, actor: 'buyer_human', data: { mode, scheduled_at: iso(patch.scheduled_at), price_cents: job.deal.price_cents, pool_size: pool.length } });
  emit('escrow.held', { job_id: jobId, data: { amount_cents: job.deal.price_cents, provider: 'stub' } });
  offerNext(jobId);
  return loadJob(jobId);
}

// ---- cascade --------------------------------------------------------------
function offerCard(job, worker, offer) {
  const skill = getSkill(job.skill);
  return {
    offer_id: offer.id,
    job_id: job.id,
    rank: offer.rank,
    title: job.title,
    skill: job.skill,
    skill_name: skill.name_it,
    address: job.address,
    location: { lat: job.lat, lng: job.lng },
    distance_km: Math.round(haversineKm(worker, job) * 10) / 10,
    eta_min: offer.eta_min,
    deadline_at: iso(job.deadline_at),
    scheduled_at: iso(job.scheduled_at),
    mode: job.mode,
    pay_cents: job.deal.worker_payout_cents,
    instructions: job.instructions,
    proof: job.proof_req,
    expires_at: iso(offer.expires_at),
    ttl_s: Math.round((offer.expires_at - offer.created_at) / 1000),
    buyer: job.agent_name,
  };
}

export function offerNext(jobId) {
  const job = loadJob(jobId);
  if (job.status !== 'dispatching') return null;
  if (get("SELECT id FROM offers WHERE job_id = ? AND status = 'pending'", jobId)) return null;
  const skill = getSkill(job.skill);
  let pool = job.dispatch_pool ?? [];
  let idx = job.dispatch_index;

  const tryFrom = () => {
    for (let i = idx + 1; i < pool.length; i++) {
      const w = get('SELECT * FROM workers WHERE id = ?', pool[i]);
      const skip = !w ? 'gone'
        : w.status !== 'active' ? w.status
        : !w.online ? 'offline'
        : activeJobCount(w.id) >= w.capacity ? 'busy'
        : null;
      if (skip) {
        emit('dispatch.skipped', { job_id: jobId, worker_id: pool[i], data: { rank: i + 1, reason: skip } });
        continue;
      }
      const s = scoreWorker(w, job, skill);
      const now = clock.now();
      const offer = { id: id('off'), job_id: jobId, worker_id: w.id, rank: i + 1, score: s.score, price_cents: job.deal.worker_payout_cents, eta_min: s.eta_min, status: 'pending', created_at: now, expires_at: now + offerTtlMs() };
      insert('offers', offer);
      update('workers', w.id, { offers_received: w.offers_received + 1 });
      update('jobs', jobId, { dispatch_index: i, updated_at: now });
      emit('dispatch.offer_sent', { job_id: jobId, worker_id: w.id, data: { ...offerCard(job, w, offer), alias: w.display_name, score: s.score } });
      return offer;
    }
    return null;
  };

  let offer = tryFrom();
  if (!offer) {
    // Pool exhausted: one rescan for workers who came online since confirm.
    const tried = new Set(all('SELECT worker_id FROM offers WHERE job_id = ?', jobId).map((o) => o.worker_id));
    const fresh = rankCandidates(job).eligible
      .filter((c) => c.floor_cents <= job.deal.price_cents && !tried.has(c.worker.id) && !pool.includes(c.worker.id))
      .map((c) => c.worker.id);
    if (fresh.length) {
      idx = pool.length - 1;
      pool = [...pool, ...fresh];
      update('jobs', jobId, { dispatch_pool: pool });
      emit('dispatch.pool_extended', { job_id: jobId, data: { added: fresh.length } });
      offer = tryFrom();
    }
  }
  if (!offer) {
    const now = clock.now();
    update('jobs', jobId, {
      status: 'no_match', status_message: NO_SUPPLY_IT, updated_at: now,
      escrow: { ...job.escrow, status: 'refunded', refunded_at: iso(now) },
    });
    emit('job.no_match', { job_id: jobId, data: { message: NO_SUPPLY_IT, stage: 'cascade', tried: pool.length } });
    emit('escrow.refunded', { job_id: jobId, data: { amount_cents: job.escrow?.amount_cents } });
  }
  return offer;
}

export function respondOffer(workerId, offerId, accept, { via = 'app' } = {}) {
  const result = tx(() => {
    const offer = get('SELECT * FROM offers WHERE id = ?', offerId);
    if (!offer || offer.worker_id !== workerId) throw new HttpError(404, 'offer_not_found', 'Offerta non trovata');
    const now = clock.now();
    if (offer.status !== 'pending') throw new HttpError(409, 'offer_not_pending', offer.status === 'expired' ? 'Offerta scaduta' : 'Offerta non più disponibile');
    if (now > offer.expires_at) throw new HttpError(409, 'offer_not_pending', 'Offerta scaduta');
    const w = get('SELECT * FROM workers WHERE id = ?', workerId);
    const job = loadJob(offer.job_id);
    if (!accept) {
      update('offers', offerId, { status: 'declined', responded_at: now });
      update('workers', workerId, { offers_declined: w.offers_declined + 1 });
      return { declined: true, job };
    }
    if (job.status !== 'dispatching' || job.assigned_worker_id) {
      update('offers', offerId, { status: 'cancelled', responded_at: now });
      throw new HttpError(409, 'job_taken', 'Lavoro già assegnato');
    }
    if (activeJobCount(workerId) >= w.capacity) throw new HttpError(409, 'at_capacity', 'Hai già il numero massimo di lavori attivi');
    update('offers', offerId, { status: 'accepted', responded_at: now });
    run_cancelOthers(offer.job_id, offerId, now);
    update('jobs', offer.job_id, { status: 'assigned', assigned_worker_id: workerId, assigned_via: via, assigned_at: now, status_message: null, updated_at: now });
    update('workers', workerId, { offers_accepted: w.offers_accepted + 1, jobs_accepted: w.jobs_accepted + 1 });
    return { accepted: true, job };
  });
  const offer = get('SELECT * FROM offers WHERE id = ?', offerId);
  if (result.declined) {
    emit('dispatch.offer_declined', { job_id: offer.job_id, worker_id: workerId, actor: via, data: { rank: offer.rank } });
    offerNext(offer.job_id);
    return { ok: true, status: 'declined' };
  }
  const job = loadJob(offer.job_id);
  const w = get('SELECT * FROM workers WHERE id = ?', workerId);
  emit('dispatch.offer_accepted', { job_id: job.id, worker_id: workerId, actor: via, data: { rank: offer.rank } });
  emit('job.assigned', { job_id: job.id, worker_id: workerId, data: { worker: publicWorker(w, job), mode: job.mode, scheduled_at: iso(job.scheduled_at) } });
  return { ok: true, status: 'accepted', job_id: job.id };
}

function run_cancelOthers(jobId, keepId, now) {
  for (const o of all("SELECT id FROM offers WHERE job_id = ? AND status = 'pending' AND id != ?", jobId, keepId)) {
    update('offers', o.id, { status: 'cancelled', responded_at: now });
  }
}

// ---- worker job actions --------------------------------------------------
function workerJob(workerId, jobId, allowed) {
  const job = loadJob(jobId);
  if (job.assigned_worker_id !== workerId) throw new HttpError(403, 'not_your_job', 'Questo lavoro non è assegnato a te');
  if (!allowed.includes(job.status)) throw new HttpError(409, 'invalid_state', `Stato attuale: ${job.status}`);
  return job;
}

export function startJob(workerId, jobId) {
  workerJob(workerId, jobId, ['assigned']);
  update('jobs', jobId, { status: 'en_route', started_at: clock.now(), updated_at: clock.now() });
  emit('job.en_route', { job_id: jobId, worker_id: workerId, actor: 'worker' });
  return { ok: true };
}

export function arriveJob(workerId, jobId) {
  const job = workerJob(workerId, jobId, ['en_route']);
  const w = get('SELECT * FROM workers WHERE id = ?', workerId);
  const d = haversineKm(w, job) * 1000;
  if (d > job.proof_req.gps_radius_m) {
    throw new HttpError(409, 'not_on_site', `Sei a ${Math.round(d)} m dal luogo: avvicinati entro ${job.proof_req.gps_radius_m} m.`);
  }
  update('jobs', jobId, { status: 'on_site', arrived_at: clock.now(), updated_at: clock.now() });
  emit('job.on_site', { job_id: jobId, worker_id: workerId, actor: 'worker', data: { distance_m: Math.round(d) } });
  return { ok: true };
}

const IMG_RE = /^data:(image\/(jpeg|png|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

// Proof is checked automatically against the task card before a job is Done.
export function submitProof(workerId, jobId, { photos = [], answers = {}, simulated = false } = {}) {
  const job = workerJob(workerId, jobId, ['on_site']);
  const w = get('SELECT * FROM workers WHERE id = ?', workerId);
  const req = job.proof_req;
  const now = clock.now();
  const problems = [];
  const decoded = [];
  for (const p of Array.isArray(photos) ? photos : []) {
    const m = IMG_RE.exec(String(p));
    if (!m) { problems.push('Formato foto non valido'); continue; }
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > MAX_PHOTO_BYTES) { problems.push('Foto troppo grande (max 6 MB)'); continue; }
    decoded.push({ mime: m[1], buf });
  }
  if (decoded.length < req.photos_min) problems.push(`Servono almeno ${req.photos_min} foto (ne hai caricate ${decoded.length})`);
  const distance_m = Math.round(haversineKm(w, job) * 1000);
  const gps_ok = distance_m <= req.gps_radius_m;
  if (!gps_ok) problems.push(`Posizione a ${distance_m} m dal luogo (max ${req.gps_radius_m} m)`);
  const deadline_ok = now <= job.deadline_at;
  if (!deadline_ok) problems.push('Scadenza superata');
  const cleanAnswers = {};
  for (const item of req.checklist) {
    const v = answers?.[item.id];
    const empty = v == null || v === '';
    if (empty) { if (item.required) problems.push(`Risposta mancante: ${item.q}`); continue; }
    if (item.type === 'yes_no') {
      if (!['yes', 'no', true, false].includes(v)) problems.push(`Rispondi sì/no: ${item.q}`);
      else cleanAnswers[item.id] = v === true || v === 'yes' ? 'yes' : 'no';
    } else if (item.type === 'number') {
      const n = Number(String(v).replace(',', '.'));
      if (Number.isNaN(n)) problems.push(`Numero non valido: ${item.q}`);
      else cleanAnswers[item.id] = n;
    } else cleanAnswers[item.id] = String(v).slice(0, 2000);
  }
  if (problems.length) {
    emit('job.proof_rejected', { job_id: jobId, worker_id: workerId, data: { problems } });
    throw new HttpError(422, 'proof_rejected', 'La prova non soddisfa i requisiti', { problems });
  }
  // The in-browser demo has no file server: keep photos inline as data URLs.
  const inline = globalThis.ARONICA_INLINE_UPLOADS;
  const dir = join(UPLOAD_DIR(), jobId);
  if (!inline) mkdirSync(dir, { recursive: true });
  const urls = decoded.map((p, i) => {
    if (inline) return `data:${p.mime};base64,${p.buf.toString('base64')}`;
    const name = `${token(9)}-${i + 1}.${EXT[p.mime]}`;
    writeFileSync(join(dir, name), p.buf);
    return `/uploads/${jobId}/${name}`;
  });
  const proof = {
    photos: urls,
    answers: cleanAnswers,
    gps: { lat: w.lat, lng: w.lng, distance_m, radius_m: req.gps_radius_m, simulated_position: !realGps.has(workerId) },
    submitted_at: iso(now),
    checks: { photos: true, gps: gps_ok, deadline: deadline_ok, checklist: true },
    verified: true,
    simulated,
  };
  const payout = job.deal.worker_payout_cents;
  const skillJobs = { ...w.skill_jobs, [job.skill]: (w.skill_jobs?.[job.skill] ?? 0) + 1 };
  update('jobs', jobId, {
    status: 'done', proof, completed_at: now, updated_at: now, status_message: null,
    escrow: { ...job.escrow, status: 'released', released_at: iso(now), worker_payout_cents: payout, platform_fee_cents: job.deal.platform_fee_cents },
  });
  update('workers', workerId, { jobs_completed: w.jobs_completed + 1, earnings_cents: w.earnings_cents + payout, skill_jobs: skillJobs });
  emit('job.proof_submitted', { job_id: jobId, worker_id: workerId, actor: simulated ? 'simulator' : 'worker', data: { photos: urls.length, simulated } });
  emit('job.done', { job_id: jobId, worker_id: workerId, data: { proof, payout_cents: payout } });
  emit('escrow.released', { job_id: jobId, data: { amount_cents: job.deal.price_cents, payout_cents: payout } });
  enforce(workerId);
  return { ok: true, payout_cents: payout, proof };
}

// Worker bails after accepting: counts against them; the job goes back into the
// cascade (Uber re-matches the rider rather than cancelling their trip).
export function workerCancel(workerId, jobId, reason = null) {
  const job = workerJob(workerId, jobId, ['assigned', 'en_route']);
  const w = get('SELECT * FROM workers WHERE id = ?', workerId);
  update('workers', workerId, { jobs_cancelled: w.jobs_cancelled + 1 });
  update('jobs', jobId, { status: 'dispatching', assigned_worker_id: null, assigned_via: null, assigned_at: null, started_at: null, status_message: 'La persona ha annullato: cerco un sostituto…', updated_at: clock.now() });
  emit('job.worker_cancelled', { job_id: jobId, worker_id: workerId, actor: 'worker', data: { reason } });
  enforce(workerId);
  offerNext(jobId);
  return { ok: true };
}

export function buyerCancel(jobId, reason = null) {
  const job = loadJob(jobId);
  if (['done', 'cancelled', 'expired', 'no_match'].includes(job.status)) throw new HttpError(409, 'invalid_state', `Job is ${job.status}`);
  const now = clock.now();
  // Cancellation fee stub: free until someone is on the way.
  const fee = ['en_route', 'on_site'].includes(job.status) ? Math.round((job.deal?.price_cents ?? 0) * 0.3) : 0;
  const escrow = job.escrow ? { ...job.escrow, status: fee ? 'partially_released' : 'refunded', cancel_fee_cents: fee, refunded_at: iso(now) } : null;
  for (const o of all("SELECT id FROM offers WHERE job_id = ? AND status = 'pending'", jobId)) update('offers', o.id, { status: 'cancelled', responded_at: now });
  update('jobs', jobId, { status: 'cancelled', cancelled_at: now, updated_at: now, escrow, status_message: reason ? `Annullato: ${reason}` : 'Annullato dal cliente' });
  emit('job.cancelled', { job_id: jobId, worker_id: job.assigned_worker_id, actor: 'buyer', data: { reason, cancel_fee_cents: fee } });
  if (fee && job.assigned_worker_id) {
    const w = get('SELECT * FROM workers WHERE id = ?', job.assigned_worker_id);
    update('workers', w.id, { earnings_cents: w.earnings_cents + Math.round(fee * 0.85) });
  }
  return { ok: true, cancel_fee_cents: fee };
}

// ---- the loop (PRD: every ~2s) --------------------------------------------
export function tick() {
  const now = clock.now();
  // 1) expire unanswered offers → next worker
  for (const o of all("SELECT * FROM offers WHERE status = 'pending' AND expires_at <= ?", now)) {
    update('offers', o.id, { status: 'expired', responded_at: now });
    const w = get('SELECT offers_expired FROM workers WHERE id = ?', o.worker_id);
    if (w) update('workers', o.worker_id, { offers_expired: w.offers_expired + 1 });
    emit('dispatch.offer_expired', { job_id: o.job_id, worker_id: o.worker_id, data: { rank: o.rank } });
    offerNext(o.job_id);
  }
  // 2) dispatching jobs with no live offer (e.g. after restart)
  for (const j of all("SELECT id FROM jobs WHERE status = 'dispatching' AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.job_id = jobs.id AND o.status = 'pending')")) {
    offerNext(j.id);
  }
  // 3) unconfirmed deals lapse
  for (const j of all("SELECT * FROM jobs WHERE status = 'pending_confirmation'")) {
    if (j.deal?.valid_until < now) {
      update('jobs', j.id, { status: 'expired', status_message: 'Accordo scaduto senza conferma.', updated_at: now });
      emit('job.expired', { job_id: j.id, data: { reason: 'deal_not_confirmed' } });
    }
  }
  // 4) deadlines
  for (const j of all("SELECT * FROM jobs WHERE deadline_at < ? AND status IN ('negotiating','dispatching','assigned','en_route','on_site')", now)) {
    const escrow = j.escrow ? { ...j.escrow, status: 'refunded', refunded_at: iso(now) } : null;
    for (const o of all("SELECT id FROM offers WHERE job_id = ? AND status = 'pending'", j.id)) update('offers', o.id, { status: 'cancelled', responded_at: now });
    update('jobs', j.id, { status: 'expired', escrow, updated_at: now, status_message: 'Scadenza superata senza prova.' });
    emit('job.expired', { job_id: j.id, worker_id: j.assigned_worker_id, data: { reason: 'deadline', was: j.status } });
    if (ACTIVE.includes(j.status) && j.assigned_worker_id) {
      const w = get('SELECT no_shows FROM workers WHERE id = ?', j.assigned_worker_id);
      update('workers', j.assigned_worker_id, { no_shows: w.no_shows + 1 });
      emit('worker.no_show', { job_id: j.id, worker_id: j.assigned_worker_id });
      enforce(j.assigned_worker_id);
    }
  }
}

export function pendingOffersForWorker(workerId) {
  return all("SELECT * FROM offers WHERE worker_id = ? AND status = 'pending' AND expires_at > ?", workerId, clock.now()).map((o) => {
    const job = loadJob(o.job_id);
    const w = get('SELECT * FROM workers WHERE id = ?', workerId);
    return offerCard(job, w, o);
  });
}

export { offerCard, eur };
