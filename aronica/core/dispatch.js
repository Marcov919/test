// Dispatch v2: approval → timed offers for every open seat (parallel, highest
// score first) → assignments with the right contract → check-in / proof →
// Done → escrow release + invoice. The guarantee layer: no-shows are detected
// and the seat is re-dispatched automatically; partial coverage is reported
// honestly, never hidden.
import { get, all, insert, update, run, tx, lockRow, getSetting } from './db.js';
import { emit } from './events.js';
import { rankCandidates, scoreWorker, freeCapacity, maxSeatsPerSupplier } from './matching.js';
import { getService } from './services.js';
import { haversineKm } from './geo.js';
import { enforce } from './reliability.js';
import { routeContract, contractText } from './compliance.js';
import { loadJob, publicWorker, serializeAssignment } from './jobs.js';
import { slotLabel, romeParts } from './time.js';
import { HttpError, clock, id, iso, token, eur, NO_SUPPLY_IT } from './util.js';

const offerTtlMs = async () => await getSetting('offer_ttl_s', 20) * 1000;
const NO_SHOW_GRACE_MS = 20 * 60000;

// ---- approval (human tap or business policy) --------------------------------
export async function confirmJob(jobId, approval = { by: 'human' }) {
  return tx(async () => { await lockRow('jobs', jobId); return confirmJobLocked(jobId, approval); });
}

async function confirmJobLocked(jobId, approval) {
  const job = await loadJob(jobId);
  if (job.status !== 'pending_confirmation') throw new HttpError(409, 'not_pending_confirmation', `Job is ${job.status}.`);
  const now = clock.now();
  const hold = job.price.total_cents + (job.price.hold_cents ?? 0);
  await update('jobs', jobId, {
    status: 'dispatching',
    status_message: 'Invio le offerte ai partner…',
    approval: { ...approval, at: iso(now) },
    dispatch_index: -1,
    escrow: { status: 'held', provider: 'stub', amount_cents: hold, purchase_cap_cents: job.price.hold_cents ?? 0, currency: 'EUR', ref: `esc_${token(6)}`, held_at: iso(now) },
    updated_at: now,
  });
  await emit('job.confirmed', { job_id: jobId, actor: approval.by === 'policy' ? 'policy' : 'buyer_human', data: { approval, slot: slotLabel(job.slot_start, job.duration_min), price_cents: job.price.total_cents, headcount: job.headcount } });
  await emit('escrow.held', { job_id: jobId, data: { amount_cents: hold, provider: 'stub' } });
  await fillSeats(jobId);
  return await loadJob(jobId);
}

// ---- offers --------------------------------------------------------------
function offerCard(job, w, offer) {
  const service = getService(job.service);
  return {
    offer_id: offer.id,
    job_id: job.id,
    rank: offer.rank,
    title: job.title,
    service: job.service,
    service_name: service.name_it,
    segment: service.segment,
    proof_kind: service.proof.kind,
    address: job.address,
    location: { lat: job.lat, lng: job.lng },
    distance_km: Math.round(haversineKm(w, job) * 10) / 10,
    slot_start: iso(job.slot_start),
    slot_label: slotLabel(job.slot_start, job.duration_min),
    duration_min: job.duration_min,
    headcount: job.headcount,
    seats: offer.seats,
    pay_cents: offer.payout_cents,
    instructions: job.instructions,
    proof: job.proof_req,
    params: job.params,
    expires_at: iso(offer.expires_at),
    ttl_s: Math.round((offer.expires_at - offer.created_at) / 1000),
    buyer: job.agent_name,
  };
}

const openSeats = async (job) => {
  const pending = (await get("SELECT COALESCE(SUM(seats),0) AS s FROM offers WHERE job_id = ? AND status = 'pending'", job.id)).s;
  return job.headcount - job.seats_filled - pending;
};

// Keep one timed offer out per open seat, walking the ranked pool.
export async function fillSeats(jobId) {
  return tx(async () => {
  await lockRow('jobs', jobId);
  let job = await loadJob(jobId);
  if (job.status !== 'dispatching') return [];
  const sent = [];
  let pool = job.dispatch_pool ?? [];
  let idx = job.dispatch_index;
  const tried = async () => new Set((await all('SELECT worker_id FROM offers WHERE job_id = ?', jobId)).map((o) => o.worker_id));
  const assigned = new Set((await all("SELECT worker_id FROM assignments WHERE job_id = ? AND status != 'cancelled'", jobId)).map((a) => a.worker_id));
  let seats = await openSeats(job);
  const walk = async () => {
    while (seats > 0 && idx + 1 < pool.length) {
      idx += 1;
      const wid = pool[idx];
      if (assigned.has(wid)) continue;
      const w = await get('SELECT * FROM workers WHERE id = ?', wid);
      const cap = w && w.status === 'active' ? await freeCapacity(w, job.slot_start, job.duration_min) : 0;
      if (!cap) { await emit('dispatch.skipped', { job_id: jobId, worker_id: wid, data: { rank: idx + 1, reason: !w ? 'gone' : w.status !== 'active' ? w.status : 'not_available' } }); continue; }
      const already = (await all("SELECT COALESCE(SUM(crew),0) AS c FROM assignments WHERE job_id = ? AND worker_id = ? AND status NOT IN ('cancelled','no_show')", jobId, wid))[0].c;
      const offerSeats = w.kind === 'business' ? Math.min(cap, seats, maxSeatsPerSupplier(job.headcount) - already) : 1;
      if (offerSeats <= 0) continue;
      const s = await scoreWorker(w, job, job.slot_start);
      const now = clock.now();
      const offer = {
        id: id('off'), job_id: jobId, worker_id: wid, rank: idx + 1, score: s.score, seats: offerSeats,
        payout_cents: job.price.seat_payout_cents * offerSeats, status: 'pending', created_at: now, expires_at: now + await offerTtlMs(),
      };
      await insert('offers', offer);
      await update('workers', wid, { offers_received: w.offers_received + 1 });
      seats -= offerSeats;
      sent.push(offer);
      await emit('dispatch.offer_sent', { job_id: jobId, worker_id: wid, data: { ...offerCard(job, w, offer), alias: w.display_name, score: s.score } });
    }
  };
  await walk();
  if (seats > 0) {
    // Pool exhausted: one rescan for partners who became available since approval.
    const t = await tried();
    const fresh = (await rankCandidates(job, { slotStart: job.slot_start })).eligible.map((c) => c.worker.id).filter((x) => !t.has(x) && !pool.includes(x) && !assigned.has(x));
    if (fresh.length) {
      pool = [...pool, ...fresh];
      await update('jobs', jobId, { dispatch_pool: pool });
      await emit('dispatch.pool_extended', { job_id: jobId, data: { added: fresh.length } });
      await walk();
    }
  }
  await update('jobs', jobId, { dispatch_index: idx, updated_at: clock.now() });
  job = await loadJob(jobId);
  const pendingLeft = (await get("SELECT COUNT(*) AS c FROM offers WHERE job_id = ? AND status = 'pending'", jobId)).c;
  if (!pendingLeft && job.seats_filled < job.headcount) await closeDispatch(jobId, 'pool_exhausted');
  return sent;
  });
}

// No more candidates: honest partial coverage or no_match.
async function closeDispatch(jobId, reason) {
  const job = await loadJob(jobId);
  const now = clock.now();
  if (job.seats_filled === 0) {
    await update('jobs', jobId, { status: 'no_match', status_message: NO_SUPPLY_IT, updated_at: now, escrow: { ...job.escrow, status: 'refunded', refunded_at: iso(now) } });
    await emit('job.no_match', { job_id: jobId, data: { message: NO_SUPPLY_IT, stage: 'dispatch', reason } });
    await emit('escrow.refunded', { job_id: jobId, data: { amount_cents: job.escrow?.amount_cents } });
    return;
  }
  const missing = job.headcount - job.seats_filled;
  const refund = job.price.seat_payout_cents * missing + Math.round((job.price.fee_cents / job.headcount) * missing);
  const msg = `Coperti ${job.seats_filled} ${job.seats_filled === 1 ? 'posto' : 'posti'} su ${job.headcount}. ${NO_SUPPLY_IT.replace('.', '')} per i restanti ${missing}; rimborso di ${eur(refund)}.`;
  await update('jobs', jobId, { status: job.status === 'dispatching' ? 'assigned' : job.status, status_message: msg, updated_at: now, escrow: { ...job.escrow, partial_refund_cents: refund } });
  await emit('job.partially_filled', { job_id: jobId, data: { filled: job.seats_filled, headcount: job.headcount, refund_cents: refund, message: msg } });
}

export async function respondOffer(workerId, offerId, accept, { via = 'app' } = {}) {
  const r = await tx(async () => {
    const offer = await lockRow('offers', offerId);
    if (offer) await lockRow('jobs', offer.job_id);
    if (!offer || offer.worker_id !== workerId) throw new HttpError(404, 'offer_not_found', 'Offerta non trovata');
    const now = clock.now();
    if (offer.status !== 'pending') throw new HttpError(409, 'offer_not_pending', offer.status === 'expired' ? 'Offerta scaduta' : 'Offerta non più disponibile');
    if (now > offer.expires_at) throw new HttpError(409, 'offer_not_pending', 'Offerta scaduta');
    const w = await get('SELECT * FROM workers WHERE id = ?', workerId);
    const job = await loadJob(offer.job_id);
    if (!accept) {
      await update('offers', offerId, { status: 'declined', responded_at: now });
      await update('workers', workerId, { offers_declined: w.offers_declined + 1 });
      return { declined: true, offer };
    }
    if (!['dispatching', 'assigned', 'in_progress'].includes(job.status) || job.seats_filled >= job.headcount) {
      await update('offers', offerId, { status: 'cancelled', responded_at: now });
      return { taken: true };
    }
    const crew = Math.min(offer.seats, job.headcount - job.seats_filled, await freeCapacity(w, job.slot_start, job.duration_min) || offer.seats);
    const account = await get('SELECT * FROM accounts WHERE id = ?', job.account_id);
    const payout = job.price.seat_payout_cents * crew;
    const contract = await routeContract({ account, worker: w, payoutCents: payout });
    contract.text = contractText({ route: contract.route, account, worker: w, job, payoutCents: payout });
    const a = { id: id('as'), job_id: job.id, worker_id: workerId, crew, status: 'assigned', contract, payout_cents: payout, assigned_via: via, assigned_at: now };
    await insert('assignments', a);
    await update('offers', offerId, { status: 'accepted', responded_at: now });
    const filled = job.seats_filled + crew;
    await update('jobs', job.id, { seats_filled: filled, status: filled >= job.headcount && job.status === 'dispatching' ? 'assigned' : job.status, status_message: filled >= job.headcount ? null : `Coperti ${filled} ${filled === 1 ? 'posto' : 'posti'} su ${job.headcount}: cerco gli altri…`, updated_at: now });
    if (filled >= job.headcount) {
      for (const o of await all("SELECT id FROM offers WHERE job_id = ? AND status = 'pending'", job.id)) await update('offers', o.id, { status: 'cancelled', responded_at: now });
    }
    await update('workers', workerId, { offers_accepted: w.offers_accepted + 1, jobs_accepted: w.jobs_accepted + 1 });
    return { accepted: true, assignment: a, job };
  });
  const offer = await get('SELECT * FROM offers WHERE id = ?', offerId);
  if (r.taken) throw new HttpError(409, 'job_taken', 'Posti già coperti');
  if (r.declined) {
    await emit('dispatch.offer_declined', { job_id: offer.job_id, worker_id: workerId, actor: via, data: { rank: offer.rank } });
    await fillSeats(offer.job_id);
    return { ok: true, status: 'declined' };
  }
  const job = await loadJob(offer.job_id);
  const w = await get('SELECT * FROM workers WHERE id = ?', workerId);
  await emit('dispatch.offer_accepted', { job_id: job.id, worker_id: workerId, actor: via, data: { rank: offer.rank, crew: r.assignment.crew } });
  await emit('job.assigned', { job_id: job.id, worker_id: workerId, data: { worker: await publicWorker(w, job), crew: r.assignment.crew, seats_filled: job.seats_filled, headcount: job.headcount, contract: r.assignment.contract.label_it } });
  if (job.seats_filled >= job.headcount) await emit('job.fully_staffed', { job_id: job.id, data: { headcount: job.headcount } });
  else await fillSeats(job.id); // top up offers, or close honestly if nobody is left
  return { ok: true, status: 'accepted', job_id: job.id, assignment_id: r.assignment.id, contract: r.assignment.contract.label_it };
}

// ---- partner actions (per assignment) --------------------------------------
async function myAssignment(workerId, jobId, allowed) {
  const a = await get("SELECT * FROM assignments WHERE job_id = ? AND worker_id = ? AND status NOT IN ('cancelled','no_show') ORDER BY assigned_at DESC", jobId, workerId);
  if (!a) throw new HttpError(403, 'not_your_job', 'Questo lavoro non è assegnato a te');
  if (!allowed.includes(a.status)) throw new HttpError(409, 'invalid_state', `Stato attuale: ${a.status}`);
  return a;
}

async function syncJobStatus(jobId) {
  const job = await loadJob(jobId);
  const as = await all("SELECT * FROM assignments WHERE job_id = ? AND status NOT IN ('cancelled','no_show')", jobId);
  if (['done', 'cancelled', 'expired', 'no_match'].includes(job.status)) return;
  const allDone = as.length && as.every((a) => a.status === 'done');
  const noMoreSeats = job.seats_filled >= job.headcount || !await get("SELECT 1 AS x FROM offers WHERE job_id = ? AND status = 'pending'", jobId);
  if (allDone && noMoreSeats && job.status !== 'dispatching') return await finalizeJob(jobId);
  if (as.some((a) => ['en_route', 'on_site', 'done'].includes(a.status)) && job.status === 'assigned') {
    await update('jobs', jobId, { status: 'in_progress', updated_at: clock.now() });
    await emit('job.in_progress', { job_id: jobId });
  }
}

export async function startJob(workerId, jobId) {
  const a = await myAssignment(workerId, jobId, ['assigned']);
  await update('assignments', a.id, { status: 'en_route', started_at: clock.now() });
  await emit('job.en_route', { job_id: jobId, worker_id: workerId, actor: 'worker' });
  await syncJobStatus(jobId);
  return { ok: true };
}

export async function arriveJob(workerId, jobId) {
  const a = await myAssignment(workerId, jobId, ['en_route']);
  const job = await loadJob(jobId);
  const w = await get('SELECT * FROM workers WHERE id = ?', workerId);
  const d = haversineKm(w, job) * 1000;
  if (d > job.proof_req.gps_radius_m) throw new HttpError(409, 'not_on_site', `Sei a ${Math.round(d)} m dal luogo: avvicinati entro ${job.proof_req.gps_radius_m} m.`);
  await update('assignments', a.id, { status: 'on_site', arrived_at: clock.now() });
  await emit('job.on_site', { job_id: jobId, worker_id: workerId, actor: 'worker', data: { distance_m: Math.round(d), check_in: job.proof_req.kind === 'timesheet' } });
  return { ok: true };
}

const IMG_RE = /^data:(image\/(jpeg|png|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;

// Photo services: photos + checklist. Timesheet services: check-out (hours worked).
export async function submitProof(workerId, jobId, { photos = [], answers = {}, simulated = false } = {}) {
  const a = await myAssignment(workerId, jobId, ['on_site']);
  const job = await loadJob(jobId);
  const w = await get('SELECT * FROM workers WHERE id = ?', workerId);
  const req = job.proof_req;
  const now = clock.now();
  const problems = [];
  const decoded = [];
  for (const p of Array.isArray(photos) ? photos : []) {
    const m = IMG_RE.exec(String(p));
    if (!m) { problems.push('Formato foto non valido'); continue; }
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 6 * 1024 * 1024) { problems.push('Foto troppo grande (max 6 MB)'); continue; }
    decoded.push({ mime: m[1], buf });
  }
  if (decoded.length < (req.photos_min ?? 0)) problems.push(`Servono almeno ${req.photos_min} foto (ne hai caricate ${decoded.length})`);
  const distance_m = Math.round(haversineKm(w, job) * 1000);
  const gps_ok = distance_m <= req.gps_radius_m;
  if (!gps_ok) problems.push(`Posizione a ${distance_m} m dal luogo (max ${req.gps_radius_m} m)`);
  const clean = {};
  for (const item of req.checklist ?? []) {
    const v = answers?.[item.id];
    if (v == null || v === '') { if (item.required) problems.push(`Risposta mancante: ${item.q}`); continue; }
    if (item.type === 'yes_no') {
      if (!['yes', 'no', true, false].includes(v)) problems.push(`Rispondi sì/no: ${item.q}`); else clean[item.id] = v === true || v === 'yes' ? 'yes' : 'no';
    } else if (item.type === 'number') {
      const n = Number(String(v).replace(',', '.'));
      if (Number.isNaN(n)) problems.push(`Numero non valido: ${item.q}`); else clean[item.id] = n;
    } else clean[item.id] = String(v).slice(0, 2000);
  }
  if (job.params?.spesa_max_eur != null && clean.spesa_eur != null && clean.spesa_eur > job.params.spesa_max_eur) {
    problems.push(`Scontrino (${clean.spesa_eur} €) oltre il tetto di spesa (${job.params.spesa_max_eur} €)`);
  }
  if (problems.length) {
    await emit('job.proof_rejected', { job_id: jobId, worker_id: workerId, data: { problems } });
    throw new HttpError(422, 'proof_rejected', 'La prova non soddisfa i requisiti', { problems });
  }
  // Photos go to the media table (no writable disk on serverless); the offline
  // demo keeps them inline as data URLs.
  const inline = globalThis.ARONICA_INLINE_UPLOADS;
  const urls = [];
  for (const p of decoded) {
    if (inline) { urls.push(`data:${p.mime};base64,${p.buf.toString('base64')}`); continue; }
    const mid = `m_${token(12)}`;
    await insert('media', { id: mid, job_id: jobId, mime: p.mime, data: p.buf.toString('base64'), created_at: now });
    urls.push(`/media/${mid}`);
  }
  const timesheet = req.kind === 'timesheet' ? {
    check_in: iso(a.arrived_at),
    check_out: iso(now),
    minutes_worked: Math.round((now - a.arrived_at) / 60000),
    minutes_planned: job.duration_min,
  } : null;
  const proof = {
    kind: req.kind, photos: urls, answers: clean, timesheet,
    gps: { lat: w.lat, lng: w.lng, distance_m, radius_m: req.gps_radius_m, simulated_position: !w.real_gps },
    submitted_at: iso(now), verified: true, simulated,
  };
  await update('assignments', a.id, { status: 'done', completed_at: now, proof });
  const skillJobs = { ...w.skill_jobs, [job.service]: (w.skill_jobs?.[job.service] ?? 0) + 1 };
  await update('workers', workerId, { jobs_completed: w.jobs_completed + 1, earnings_cents: w.earnings_cents + a.payout_cents, skill_jobs: skillJobs });
  await emit('job.proof_submitted', { job_id: jobId, worker_id: workerId, actor: simulated ? 'simulator' : 'worker', data: { kind: req.kind, photos: urls.length, simulated, timesheet } });
  await emit('assignment.done', { job_id: jobId, worker_id: workerId, data: { payout_cents: a.payout_cents, proof } });
  await enforce(workerId);
  await syncJobStatus(jobId);
  return { ok: true, payout_cents: a.payout_cents, proof };
}

async function finalizeJob(jobId) {
  const job = await loadJob(jobId);
  const now = clock.now();
  const done = await all("SELECT * FROM assignments WHERE job_id = ? AND status = 'done'", jobId);
  const paid = done.reduce((a, x) => a + x.payout_cents, 0);
  const fee = Math.round(job.price.fee_cents * (done.reduce((a, x) => a + x.crew, 0) / job.headcount));
  const spent = done.reduce((a, x) => a + Math.round((x.proof?.answers?.spesa_eur ?? 0) * 100), 0);
  const escrow = { ...job.escrow, status: 'released', released_at: iso(now), paid_to_partners_cents: paid, platform_fee_cents: fee, purchase_reimbursed_cents: spent };
  const account = await get('SELECT * FROM accounts WHERE id = ?', job.account_id);
  let invoice = null;
  if (account.kind === 'business') {
    const n = (await get("SELECT COUNT(*) AS c FROM jobs WHERE invoice IS NOT NULL")).c + 1;
    const imponibile = paid + fee;
    invoice = {
      number: `AR-${romeParts(now).y}-${String(n).padStart(4, '0')}`,
      date: iso(now),
      to: { name: account.org?.legal_name ?? account.name, vat_id: account.org?.vat_id ?? null, sdi: account.org?.sdi ?? null },
      lines: [...job.price.lines, ...job.price.surcharges.map((s) => ({ label: s.label, cents: s.cents }))],
      imponibile_cents: imponibile,
      iva_cents: Math.round(imponibile * 0.22),
      totale_cents: imponibile + Math.round(imponibile * 0.22),
      status: 'bozza (stub, non inviata allo SDI)',
    };
  }
  await update('jobs', jobId, { status: 'done', completed_at: now, updated_at: now, escrow, invoice, status_message: job.seats_filled < job.headcount ? job.status_message : null });
  await emit('job.done', { job_id: jobId, data: { paid_cents: paid, invoice: invoice?.number ?? null } });
  await emit('escrow.released', { job_id: jobId, data: { paid_cents: paid, fee_cents: fee } });
}

// Partner bails after accepting: counts against them; the seat is re-dispatched.
export async function workerCancel(workerId, jobId, reason = null) {
  const a = await myAssignment(workerId, jobId, ['assigned', 'en_route']);
  const w = await get('SELECT * FROM workers WHERE id = ?', workerId);
  await update('workers', workerId, { jobs_cancelled: w.jobs_cancelled + 1 });
  await reopenSeat(a, 'cancelled', 'job.worker_cancelled', reason);
  await enforce(workerId);
  return { ok: true };
}

async function reopenSeat(a, newStatus, eventType, reason) {
  const job = await loadJob(a.job_id);
  await update('assignments', a.id, { status: newStatus, completed_at: clock.now() });
  const filled = Math.max(0, job.seats_filled - a.crew);
  const canRefill = clock.now() < job.slot_start + (job.duration_min * 60000) / 2;
  await update('jobs', job.id, {
    seats_filled: filled,
    status: canRefill && !['done', 'cancelled'].includes(job.status) ? 'dispatching' : job.status,
    status_message: canRefill ? 'Una persona non è disponibile: cerco un sostituto…' : job.status_message,
    updated_at: clock.now(),
  });
  await emit(eventType, { job_id: job.id, worker_id: a.worker_id, data: { reason, crew: a.crew, replacement: canRefill } });
  if (canRefill) { await emit('dispatch.replacement', { job_id: job.id, data: { seats: a.crew } }); await fillSeats(job.id); }
  await syncJobStatus(job.id);
}

// Ops/demo hook and the tick use the same path.
export async function markNoShow(assignmentId, reason = 'no_show') {
  const a = await get('SELECT * FROM assignments WHERE id = ?', assignmentId);
  if (!a || !['assigned', 'en_route'].includes(a.status)) throw new HttpError(409, 'invalid_state', 'Assignment not active');
  const w = await get('SELECT * FROM workers WHERE id = ?', a.worker_id);
  await update('workers', w.id, { no_shows: w.no_shows + 1 });
  await reopenSeat(a, 'no_show', 'assignment.no_show', reason);
  await enforce(w.id);
  return { ok: true };
}

export async function buyerCancel(jobId, reason = null) {
  const job = await loadJob(jobId);
  if (['done', 'cancelled', 'expired', 'no_match'].includes(job.status)) throw new HttpError(409, 'invalid_state', `Job is ${job.status}`);
  const now = clock.now();
  const started = await all("SELECT * FROM assignments WHERE job_id = ? AND status IN ('en_route','on_site')", jobId);
  const lateCancel = job.slot_start && job.slot_start - now < 24 * 3600000 && job.seats_filled > 0;
  const fee = started.length ? Math.round(job.price.total_cents * 0.5) : lateCancel ? Math.round(job.price.total_cents * 0.2) : 0;
  for (const o of await all("SELECT id FROM offers WHERE job_id = ? AND status = 'pending'", jobId)) await update('offers', o.id, { status: 'cancelled', responded_at: now });
  for (const a of await all("SELECT id FROM assignments WHERE job_id = ? AND status IN ('assigned','en_route','on_site')", jobId)) await update('assignments', a.id, { status: 'cancelled', completed_at: now });
  const escrow = job.escrow ? { ...job.escrow, status: fee ? 'partially_released' : 'refunded', cancel_fee_cents: fee, refunded_at: iso(now) } : null;
  await update('jobs', jobId, { status: 'cancelled', cancelled_at: now, updated_at: now, escrow, status_message: fee ? `Annullato con penale ${eur(fee)} (preavviso sotto le 24 ore)` : 'Annullato senza costi' });
  await emit('job.cancelled', { job_id: jobId, actor: 'buyer', data: { reason, cancel_fee_cents: fee } });
  return { ok: true, cancel_fee_cents: fee };
}

// ---- the loop (every ~2s) -------------------------------------------------
export async function tick() {
  const now = clock.now();
  // 1) expire unanswered offers → next partner for that seat
  for (const o of await all("SELECT * FROM offers WHERE status = 'pending' AND expires_at <= ?", now)) {
    await update('offers', o.id, { status: 'expired', responded_at: now });
    const w = await get('SELECT offers_expired FROM workers WHERE id = ?', o.worker_id);
    if (w) await update('workers', o.worker_id, { offers_expired: w.offers_expired + 1 });
    await emit('dispatch.offer_expired', { job_id: o.job_id, worker_id: o.worker_id, data: { rank: o.rank } });
    await fillSeats(o.job_id);
  }
  // 2) dispatching jobs with open seats and nothing pending (e.g. after restart)
  for (const j of await all("SELECT id FROM jobs WHERE status = 'dispatching' AND seats_filled < headcount AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.job_id = jobs.id AND o.status = 'pending')")) await fillSeats(j.id);
  // 3) no-shows: still not on the way well after the start → replace
  for (const a of await all("SELECT a.* FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.status = 'assigned' AND (CASE WHEN j.slot_start > a.assigned_at THEN j.slot_start ELSE a.assigned_at END) + ? < ?", NO_SHOW_GRACE_MS, now)) {
    await markNoShow(a.id, 'not_started_in_time');
  }
  // 4) stop dispatching once half the job's time has gone
  for (const j of await all("SELECT id FROM jobs WHERE status = 'dispatching' AND slot_start + duration_min * 30000 < ?", now)) {
    for (const o of await all("SELECT id FROM offers WHERE job_id = ? AND status = 'pending'", j.id)) await update('offers', o.id, { status: 'cancelled', responded_at: now });
    await closeDispatch(j.id, 'slot_started');
  }
  // 5) end of shift: timesheet partners still on site are checked out automatically;
  //    a job past its end + 3h with nothing more to happen is closed.
  for (const j of await all("SELECT * FROM jobs WHERE status IN ('assigned','in_progress') AND slot_start + duration_min * 60000 < ?", now)) {
    if (j.proof_req.kind === 'timesheet') {
      for (const a of await all("SELECT * FROM assignments WHERE job_id = ? AND status = 'on_site'", j.id)) {
        try { await submitProof(a.worker_id, j.id, { answers: { notes: 'Check-out automatico a fine turno' }, simulated: a.assigned_via === 'sim' }); } catch { /* */ }
      }
    }
    if (j.slot_start + j.duration_min * 60000 + 3 * 3600000 < now) {
      const live = await all("SELECT * FROM assignments WHERE job_id = ? AND status IN ('en_route','on_site')", j.id);
      for (const a of live) await update('assignments', a.id, { status: 'no_show', completed_at: now });
      const anyDone = await get("SELECT 1 AS x FROM assignments WHERE job_id = ? AND status = 'done'", j.id);
      if (anyDone) await finalizeJob(j.id);
      else {
        await update('jobs', j.id, { status: 'expired', updated_at: now, status_message: 'Lavoro non completato: rimborso totale.', escrow: { ...j.escrow, status: 'refunded', refunded_at: iso(now) } });
        await emit('job.expired', { job_id: j.id, data: { reason: 'not_completed' } });
      }
    }
  }
  // 6) scheduling / approval that went stale
  for (const j of await all("SELECT * FROM jobs WHERE status IN ('scheduling','pending_confirmation') AND window_end < ?", now)) {
    await update('jobs', j.id, { status: 'expired', updated_at: now, status_message: 'La finestra richiesta è passata senza conferma.' });
    await emit('job.expired', { job_id: j.id, data: { reason: 'window_passed' } });
  }
}

export async function pendingOffersForWorker(workerId) {
  const w = await get('SELECT * FROM workers WHERE id = ?', workerId);
  const offers = await all("SELECT * FROM offers WHERE worker_id = ? AND status = 'pending' AND expires_at > ?", workerId, clock.now());
  return Promise.all(offers.map(async (o) => offerCard(await loadJob(o.job_id), w, o)));
}

export { serializeAssignment };
